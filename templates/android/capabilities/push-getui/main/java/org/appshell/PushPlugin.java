package org.appshell;

import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.igexin.sdk.PushManager;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * 推送（iOS 同名同语义）。这一份是个推版本（push.android.provider = getui），与极光版接口一致：
 * register / getToken / unregister / getLaunchNotification / clearAll / setBadge，事件 token / received / opened / message。
 * 合规：用户同意隐私政策之前不初始化 SDK——只有 Web 调 register() 之后才 initialize，并记住同意状态，
 * 之后的冷启动在 bridge 之前自动初始化。token 是个推的 clientId。
 */
@CapacitorPlugin(name = "Push")
public class PushPlugin extends Plugin {
    static final String PROVIDER = "getui";
    private static final String PREFS = "AppShellPush";
    private static final String KEY_CONSENTED = "consented";
    private static final String KEY_TOKEN = "clientId";
    private static final long REGISTER_TIMEOUT_MS = 20_000L;
    private static volatile PushPlugin current;
    private static JSObject launchNotification;
    private static final List<PluginCall> waiting = new ArrayList<>();

    @Override
    public void load() {
        current = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (current == this) current = null;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** 厂商通道（OPPO、小米分类等）要求通知渠道先在 App 里建好；id 与后端下发时用的一致。 */
    private static void initialize(Context context) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            manager.createNotificationChannel(new NotificationChannel(AppShellConfig.PUSH_CHANNEL_ID,
                AppShellConfig.PUSH_CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT));
        }
        PushManager.getInstance().initialize(context.getApplicationContext());
    }

    /** 由生成的 AppShellPlugins.beforeBridge 调用：用户以前同意过，就在页面起来前初始化。 */
    static void initIfConsented(Activity activity) {
        if (!prefs(activity).getBoolean(KEY_CONSENTED, false)) return;
        initialize(activity);
    }

    @PluginMethod
    public void register(PluginCall call) {
        Context context = getContext();
        prefs(context).edit().putBoolean(KEY_CONSENTED, true).apply();
        initialize(context);
        PushManager.getInstance().turnOnPush(context.getApplicationContext());
        String token = currentToken(context);
        if (token != null) {
            call.resolve(tokenResult(token));
            return;
        }
        // 首次注册：clientId 由 PushIntentService.onReceiveClientId 送来；超时说明 AppID / 包名签名 / 网络有问题。
        call.setKeepAlive(true);
        synchronized (waiting) {
            waiting.add(call);
        }
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            boolean pending;
            synchronized (waiting) {
                pending = waiting.remove(call);
            }
            if (pending) {
                call.setKeepAlive(false);
                call.reject("push registration timed out (check Getui AppID, package name and network)", "TIMEOUT");
            }
        }, REGISTER_TIMEOUT_MS);
    }

    private static String currentToken(Context context) {
        String token = prefs(context).getString(KEY_TOKEN, null);
        if (token == null || token.isEmpty()) {
            token = PushManager.getInstance().getClientid(context.getApplicationContext());
        }
        return token == null || token.isEmpty() ? null : token;
    }

    @PluginMethod
    public void getToken(PluginCall call) {
        String token = prefs(getContext()).getBoolean(KEY_CONSENTED, false) ? currentToken(getContext()) : null;
        call.resolve(token == null ? new JSObject().put("provider", PROVIDER) : tokenResult(token));
    }

    /** 用户撤回同意或退出登录：关掉推送并清掉同意状态，下次冷启动不再初始化。 */
    @PluginMethod
    public void unregister(PluginCall call) {
        prefs(getContext()).edit().putBoolean(KEY_CONSENTED, false).apply();
        PushManager.getInstance().turnOffPush(getContext().getApplicationContext());
        call.resolve();
    }

    @PluginMethod
    public void getLaunchNotification(PluginCall call) {
        JSObject result;
        synchronized (PushPlugin.class) {
            result = launchNotification;
            launchNotification = null;
        }
        call.resolve(new JSObject().put("notification", result));
    }

    @PluginMethod
    public void clearAll(PluginCall call) {
        NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        manager.cancelAll();
        call.resolve();
    }

    @PluginMethod
    public void setBadge(PluginCall call) {
        Integer count = call.getInt("count");
        if (count == null || count < 0) {
            call.reject("count must be a non-negative integer");
            return;
        }
        // 只有部分厂商桌面支持角标（华为 / 荣耀 / vivo / OPPO），其余机型静默忽略。
        PushManager.getInstance().setBadgeNum(getContext().getApplicationContext(), count);
        call.resolve();
    }

    // ─── 回调入口（PushIntentService、PushTapActivity）──────────────

    static JSObject tokenResult(String token) {
        return new JSObject().put("provider", PROVIDER).put("token", token);
    }

    static JSObject payload(String id, String title, String body, JSONObject data) {
        JSObject out = new JSObject().put("id", id == null ? "" : id).put("title", title == null ? "" : title)
            .put("body", body == null ? "" : body);
        try {
            out.put("data", data == null ? new JSObject() : JSObject.fromJSONObject(data));
        } catch (JSONException e) {
            out.put("data", new JSObject());
        }
        return out;
    }

    /** 透传与通知附加字段：能解析成 JSON 对象就用对象，否则原样放在 raw 里。 */
    static JSONObject parseData(String text) {
        if (text == null || text.isEmpty()) return new JSONObject();
        try {
            return new JSONObject(text);
        } catch (JSONException e) {
            JSONObject raw = new JSONObject();
            try {
                raw.put("raw", text);
            } catch (JSONException ignored) {
                // put 只在键为 null 时抛
            }
            return raw;
        }
    }

    static String idOf(JSONObject data) {
        for (Iterator<String> it = data.keys(); it.hasNext(); ) {
            String key = it.next();
            if (key.equals("id") || key.equals("notificationId")) return data.optString(key);
        }
        return "";
    }

    static void onToken(Context context, String token) {
        prefs(context).edit().putString(KEY_TOKEN, token).apply();
        List<PluginCall> calls;
        synchronized (waiting) {
            calls = new ArrayList<>(waiting);
            waiting.clear();
        }
        for (PluginCall call : calls) {
            call.setKeepAlive(false);
            call.resolve(tokenResult(token));
        }
        PushPlugin plugin = current;
        if (plugin != null) plugin.notifyListeners("token", tokenResult(token));
    }

    static void onNotification(String event, JSObject payload) {
        PushPlugin plugin = current;
        if (plugin != null) plugin.notifyListeners(event, payload);
    }

    /** 点开通知：页面活着就推 opened；同时留一份给冷启动后的 getLaunchNotification。 */
    static void onOpened(JSObject payload) {
        synchronized (PushPlugin.class) {
            launchNotification = payload;
        }
        PushPlugin plugin = current;
        if (plugin != null) plugin.notifyListeners("opened", payload, true);
    }
}
