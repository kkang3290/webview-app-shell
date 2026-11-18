package org.appshell;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

import cn.jiguang.api.utils.JCollectionAuth;
import cn.jpush.android.api.JPushInterface;

/**
 * 推送（iOS 同名同语义）。Android 走极光：它聚合小米 / 华为 / OPPO / vivo / 荣耀 / 魅族厂商通道。
 * 合规：用户同意隐私政策之前不得初始化 SDK——所以只有 Web 调 register() 之后才 init，并记住同意状态，
 * 之后的冷启动在 bridge 之前自动 init。
 */
@CapacitorPlugin(name = "Push")
public class PushPlugin extends Plugin {
    private static final String PREFS = "AppShellPush";
    private static final String KEY_CONSENTED = "consented";
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

    /** 由生成的 AppShellPlugins.beforeBridge 调用：用户以前同意过，就在页面起来前初始化。 */
    static void initIfConsented(Activity activity) {
        if (!prefs(activity).getBoolean(KEY_CONSENTED, false)) return;
        JCollectionAuth.setAuth(activity, true);
        JPushInterface.init(activity.getApplicationContext());
    }

    @PluginMethod
    public void register(PluginCall call) {
        Context context = getContext();
        prefs(context).edit().putBoolean(KEY_CONSENTED, true).apply();
        JCollectionAuth.setAuth(context, true);
        JPushInterface.init(context.getApplicationContext());
        if (JPushInterface.isPushStopped(context)) JPushInterface.resumePush(context);
        String token = JPushInterface.getRegistrationID(context);
        if (token != null && !token.isEmpty()) {
            call.resolve(tokenResult(token));
            return;
        }
        // 首次注册：registrationId 由 onRegister 回调送来；超时说明 AppKey / 网络 / 包名签名有问题。
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
                call.reject("push registration timed out (check JPush AppKey, package name and network)", "TIMEOUT");
            }
        }, REGISTER_TIMEOUT_MS);
    }

    @PluginMethod
    public void getToken(PluginCall call) {
        String token = JPushInterface.getRegistrationID(getContext());
        call.resolve(token == null || token.isEmpty() ? new JSObject().put("provider", "jpush") : tokenResult(token));
    }

    /** 用户撤回同意或退出登录：停止推送并清掉同意状态，下次冷启动不再初始化。 */
    @PluginMethod
    public void unregister(PluginCall call) {
        prefs(getContext()).edit().putBoolean(KEY_CONSENTED, false).apply();
        JPushInterface.stopPush(getContext());
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
        JPushInterface.clearAllNotifications(getContext());
        call.resolve();
    }

    @PluginMethod
    public void setBadge(PluginCall call) {
        Integer count = call.getInt("count");
        if (count == null || count < 0) {
            call.reject("count must be a non-negative integer");
            return;
        }
        JPushInterface.setBadgeNumber(getContext(), count);
        call.resolve();
    }

    // ─── 回调入口（PushMessageReceiver）──────────────────────────

    static JSObject tokenResult(String token) {
        return new JSObject().put("provider", "jpush").put("token", token);
    }

    static JSObject payload(String id, String title, String body, String extras) {
        JSObject out = new JSObject().put("id", id).put("title", title).put("body", body);
        try {
            out.put("data", extras == null || extras.isEmpty() ? new JSObject() : JSObject.fromJSONObject(new JSONObject(extras)));
        } catch (JSONException e) {
            out.put("data", new JSObject().put("raw", extras));
        }
        return out;
    }

    static void onToken(Context context, String token) {
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
    static void onOpened(Context context, JSObject payload) {
        synchronized (PushPlugin.class) {
            launchNotification = payload;
        }
        PushPlugin plugin = current;
        if (plugin != null) plugin.notifyListeners("opened", payload, true);
    }
}
