package org.appshell;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.JSObject;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 给 WebView 里的录音代码开关前台服务用的最小桥。
 * web 侧按 window.Capacitor?.Plugins?.RecordingKeepAlive 探测，浏览器目标里自然不存在。
 */
@CapacitorPlugin(
    name = "RecordingKeepAlive",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
        @Permission(alias = "storage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
    }
)
public class RecordingKeepAlivePlugin extends Plugin {
    static final String PREFS = "appshell_permissions";
    private final PermissionUsageBanner permissionBanner = new PermissionUsageBanner();
    /**
     * 录音原件的落点，相对路径。中文前缀由 Web 的 i18n 拼，别在这里拼死。
     *
     * **不是 `Music/`**，尽管这里存的确实是录音。MediaProvider 按集合限制一级目录，
     * `Music/` 只属于 Audio 集合，而 Audio 集合只收音频 MIME——我们录出来的 WebM 在
     * Android 的 MIME 表里只有 `video/webm` 一个身份（WebM 是容器，装音频还是视频它不看），
     * 于是 `Music/` + `.webm` 这个组合在系统层面根本不存在。详见
     * {@link RecordingLocalFilePlugin#beginMediaStore}。
     *
     * 能收任意类型的是 Files 集合，它只放行 `Download/` 和 `Documents/` 两个一级目录。
     * 取 `Documents/` 而不是 `Download/`：清理类应用和系统「释放空间」都拿 Download 开刀，
     * 用户的录音原件不该躺在那儿。两者在「文件」应用里同样是一级入口，找起来没差别。
     */
    static final String STORAGE_LOCATION = "Documents/" + AppShellConfig.STORAGE_DIR;
    /**
     * 把三个布尔折成四态。
     *
     * shouldShowRequestPermissionRationale 在「从没问过」和「勾了不再询问」两种情况下
     * 都返回 false，光靠它区分不出来。asked 是我们自己落的标记，补的就是这一刀。
     */
    static String derivePermissionState(boolean granted, boolean rationale, boolean asked) {
        if (granted) return "granted";
        if (rationale) return "prompt-with-rationale";
        return asked ? "denied" : "prompt";
    }

    /** API ≥ 29 写 MediaStore 自己的目录不需要运行时权限，这一档整个不成立。 */
    static String storageState(int sdkInt, boolean granted, boolean rationale, boolean asked) {
        if (sdkInt >= Build.VERSION_CODES.Q) return "unsupported";
        return derivePermissionState(granted, rationale, asked);
    }

    /**
     * 权限状态 → 回给 Web 的 outcome，接口约定为 granted / blocked / dismissed。
     *
     * prompt 表示系统框没有得到答复；prompt-with-rationale 表示已经拒绝但仍允许下次请求。
     * 其余一律 blocked——包括认不出来的状态：闸门的兜底方向是拦，不是放。
     */
    static String outcomeForState(String state) {
        if ("granted".equals(state)) return "granted";
        if ("prompt".equals(state)) return "dismissed";
        return "blocked";
    }

    /**
     * 系统那一关到底给没给答复。
     *
     * 用户在系统权限框上按返回键时，AndroidX 回来的结果 map 是【空的】，而 Capacitor 的
     * Bridge.validatePermissions 只对 map 里真有的那几条写状态缓存（PluginPermStates），
     * 所以它那份状态会原封不动停在 prompt。这是原生侧唯一能把「拒绝」和「退出」分开的信号：
     * granted 与 rationale 两个布尔在「首次询问后按返回」和「勾了不再询问」上取值完全一样。
     */
    static boolean verdictArrived(String capacitorState) {
        return capacitorState != null && !"prompt".equals(capacitorState);
    }

    /**
     * 系统权限框回来之后这一路的完整结论。
     *
     * asked 只在系统真给了答复时才补上——见 verdictArrived。按返回键退出不算问过：
     * 算了的话状态立刻变 denied，confirmThenRequest 从此走短路，
     * 系统权限框再也不会出现，而系统其实还愿意再弹。
     */
    static String outcomeAfterRequest(boolean granted, boolean rationale, boolean askedBefore, String capacitorState) {
        return outcomeForState(derivePermissionState(granted, rationale, askedBefore || verdictArrived(capacitorState)));
    }

    static String askedKey(String permission) {
        return "permission_asked." + permission;
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private boolean asked(String permission) {
        return prefs().getBoolean(askedKey(permission), false);
    }

    void markAsked(String permission) {
        prefs().edit().putBoolean(askedKey(permission), true).apply();
    }

    private boolean rationaleFor(String permission) {
        Activity activity = getActivity();
        // Activity 还没起来时按「没有 rationale」算：这只会让状态偏保守，不会误放行。
        return activity != null && ActivityCompat.shouldShowRequestPermissionRationale(activity, permission);
    }

    String stateFor(String permission) {
        boolean granted = ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
        return derivePermissionState(granted, rationaleFor(permission), asked(permission));
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(permissionStatus());
    }

    @PluginMethod
    public void requestMicrophone(PluginCall call) {
        confirmThenRequest(call, "microphone", Manifest.permission.RECORD_AUDIO);
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            resolveWith(call, "granted");
            return;
        }
        confirmThenRequest(call, "notifications", Manifest.permission.POST_NOTIFICATIONS);
    }

    @PluginMethod
    public void requestStorage(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // 这一档根本没有权限要请求，直接放行。
            // 必须在碰 alias 之前短路：manifest 里这条权限带 maxSdkVersion="28"，
            // API ≥ 29 上它根本不在 requestedPermissions 里，Capacitor 会直接拒掉这次 alias 请求。
            resolveWith(call, "granted");
            return;
        }
        confirmThenRequest(call, "storage", Manifest.permission.WRITE_EXTERNAL_STORAGE);
    }

    /**
     * 一道闸的完整顺序：系统仍允许询问 → 先确认用途，用户确定后再弹系统权限框；
     * 其余（已给 / 永久拒绝 / 认不出来的状态）按状态直接给 Web 结论。
     */
    private void confirmThenRequest(PluginCall call, String alias, String permission) {
        String state = stateFor(permission);
        if (!"prompt".equals(state) && !"prompt-with-rationale".equals(state)) {
            resolveWith(call, outcomeForState(state));
            return;
        }
        PermissionConfirmDialog.show(
                getActivity(),
                call.getString("title"),
                call.getString("body"),
                call.getString("confirmText"),
                call.getString("cancelText"),
                confirmed -> {
                    if (!confirmed) {
                        resolveWith(call, "dismissed");
                        return;
                    }
                    requestWithUsageBanner(call, alias);
                });
    }

    private void requestWithUsageBanner(PluginCall call, String alias) {
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
            resolveWith(call, "dismissed");
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                permissionBanner.show(activity, call.getString("disclosureTitle"), call.getString("body"));
                activity.getWindow().getDecorView().postDelayed(() -> {
                    if (activity.isFinishing() || activity.isDestroyed()) {
                        permissionBanner.hide(activity);
                        resolveWith(call, "dismissed");
                        return;
                    }
                    try {
                        requestPermissionForAlias(alias, call, "permissionCallback");
                    } catch (Throwable error) {
                        permissionBanner.hide(activity);
                        resolveWith(call, "dismissed");
                    }
                }, PermissionUsageBanner.REQUEST_DELAY_MS);
            } catch (Throwable error) {
                permissionBanner.hide(activity);
                resolveWith(call, "dismissed");
            }
        });
    }

    /** 系统回调里拿不到 alias，只能用发起时的方法名倒推是哪一路。 */
    static String permissionForMethod(String method) {
        if ("requestMicrophone".equals(method)) return Manifest.permission.RECORD_AUDIO;
        if ("requestNotifications".equals(method)) return Manifest.permission.POST_NOTIFICATIONS;
        if ("requestStorage".equals(method)) return Manifest.permission.WRITE_EXTERNAL_STORAGE;
        return null;
    }

    /**
     * 同上，倒推 alias。必须和类上 @CapacitorPlugin 注解里的 alias 逐字一致：
     * 写错了 Capacitor 只会安静地把请求丢掉（getPermissionStringsForAliases 返回空数组）。
     * 单测用反射把这张表和注解钉在了一起。
     */
    static String aliasForMethod(String method) {
        if ("requestMicrophone".equals(method)) return "microphone";
        if ("requestNotifications".equals(method)) return "notifications";
        if ("requestStorage".equals(method)) return "storage";
        return null;
    }

    /** Capacitor 自己维护的那份权限状态（PluginPermStates），取不到时为 null。 */
    private String capacitorStateName(String alias) {
        try {
            PermissionState state = getPermissionState(alias);
            return state == null ? null : state.toString();
        } catch (Exception e) {
            // 这里抛出去 = PluginCall 既不 resolve 也不 reject，Web 那个 promise 挂到会话结束。
            // 取不到就当没答复：状态停在 prompt，用户下次还能再走一遍，比卡死强。
            return null;
        }
    }

    @PermissionCallback
    public void permissionCallback(PluginCall call) {
        permissionBanner.hide(getActivity());
        String method = call.getMethodName();
        String permission = permissionForMethod(method);
        String alias = aliasForMethod(method);
        if (permission == null || alias == null) {
            // 认不出是哪一路，按闸门的兜底方向来：拦住（blocked），不是放行。
            resolveWith(call, outcomeForState(null));
            return;
        }
        String capacitorState = capacitorStateName(alias);
        boolean askedBefore = asked(permission);
        // 只有系统真回了话才算「问过了」，按返回键退出不算。
        if (verdictArrived(capacitorState)) markAsked(permission);
        boolean granted = ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
        resolveWith(call, outcomeAfterRequest(granted, rationaleFor(permission), askedBefore, capacitorState));
    }

    @Override
    protected void handleOnDestroy() {
        permissionBanner.hide(getActivity());
        super.handleOnDestroy();
    }

    private void resolveWith(PluginCall call, String outcome) {
        JSObject status = permissionStatus();
        status.put("outcome", outcome);
        call.resolve(status);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:" + getContext().getPackageName())
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void start(PluginCall call) {
        // 通知不是起录闸门，不在这里偷偷追加第二个系统权限框；用户可从权限说明入口开启。
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            call.reject("microphone permission required");
            return;
        }
        long generation = RecordingForegroundService.requestKeepAliveStart();
        try {
            Intent intent = new Intent(getContext(), RecordingForegroundService.class)
                .setAction(RecordingForegroundService.ACTION_START);
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (Exception e) {
            RecordingForegroundService.failKeepAliveStart(generation);
            // 后台起前台服务在 12+ 会被拒；录音是从前台页面发起的，真拒了只能降级
            call.reject("start foreground service failed", e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        // stop() must be idempotent. Starting a missing foreground service with only a
        // STOP action still creates it, and Android kills the process five seconds later
        // because that new service never called startForeground().
        RecordingForegroundService.stopKeepAliveIfActive();
        call.resolve();
    }

    private JSObject permissionStatus() {
        JSObject status = new JSObject();
        status.put("microphone", stateFor(Manifest.permission.RECORD_AUDIO));
        status.put("notifications", Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                ? "granted"
                : stateFor(Manifest.permission.POST_NOTIFICATIONS));
        boolean storageGranted = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.WRITE_EXTERNAL_STORAGE)
                == PackageManager.PERMISSION_GRANTED;
        status.put("storage", storageState(Build.VERSION.SDK_INT, storageGranted,
                rationaleFor(Manifest.permission.WRITE_EXTERNAL_STORAGE),
                asked(Manifest.permission.WRITE_EXTERNAL_STORAGE)));
        status.put("storageLocation", STORAGE_LOCATION);
        return status;
    }
}
