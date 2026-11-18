package org.appshell;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONException;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 统一权限接口（iOS 同名同语义）：check / request / openSettings。
 * 只处理 appshell.config.json permissions 里声明过的权限——没声明的不在 Manifest 里，申请也没有意义。
 * 状态取值：granted / denied / prompt / unsupported。
 */
@CapacitorPlugin(
    name = "Permissions",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
        @Permission(alias = "photos", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }),
        @Permission(alias = "location", strings = {
            Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }),
    }
)
public class PermissionsPlugin extends Plugin {
    static final List<String> KNOWN = Arrays.asList("microphone", "camera", "notifications", "photos", "location");

    /** 该系统版本上是否需要运行时申请；不需要的直接按系统开关或 granted 回答。 */
    static boolean needsRuntimeRequest(String name, int sdk) {
        switch (name) {
            case "notifications":
                return sdk >= 33;
            case "photos":
                return sdk <= 28;
            default:
                return true;
        }
    }

    static String stateName(PermissionState state) {
        if (state == PermissionState.GRANTED) return "granted";
        if (state == PermissionState.DENIED) return "denied";
        return "prompt";
    }

    /** 校验并去重 Web 传来的权限名；未声明的直接报错，让配置问题在开发期暴露。 */
    static List<String> parseNames(List<String> raw, List<String> declared) {
        if (raw == null || raw.isEmpty()) throw new IllegalArgumentException("names must be a non-empty array");
        Set<String> names = new LinkedHashSet<>();
        for (String name : raw) {
            if (!KNOWN.contains(name)) throw new IllegalArgumentException("unknown permission " + name);
            if (!declared.contains(name)) {
                throw new IllegalArgumentException(name + " is not declared in appshell.config.json permissions");
            }
            names.add(name);
        }
        return new ArrayList<>(names);
    }

    private List<String> names(PluginCall call) {
        JSArray array = call.getArray("names");
        try {
            return parseNames(array == null ? null : array.toList(), Arrays.asList(AppShellConfig.PERMISSIONS));
        } catch (JSONException e) {
            throw new IllegalArgumentException("names must be an array of strings");
        }
    }

    private String state(String name) {
        int sdk = Build.VERSION.SDK_INT;
        if (!needsRuntimeRequest(name, sdk)) {
            if ("notifications".equals(name)) {
                return NotificationManagerCompat.from(getContext()).areNotificationsEnabled() ? "granted" : "denied";
            }
            return "granted";
        }
        String state = stateName(getPermissionState(name));
        // 13+ 授权了运行时权限但用户在系统设置里关了通知，也算 denied。
        if ("notifications".equals(name) && "granted".equals(state)
            && !NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) return "denied";
        return state;
    }

    private JSObject snapshot(List<String> names) {
        JSObject result = new JSObject();
        for (String name : names) result.put(name, state(name));
        return result;
    }

    @PluginMethod
    public void check(PluginCall call) {
        try {
            call.resolve(snapshot(names(call)));
        } catch (IllegalArgumentException e) {
            call.reject(e.getMessage(), "INVALID");
        }
    }

    @PluginMethod
    public void request(PluginCall call) {
        List<String> names;
        try {
            names = names(call);
        } catch (IllegalArgumentException e) {
            call.reject(e.getMessage(), "INVALID");
            return;
        }
        List<String> runtime = new ArrayList<>();
        for (String name : names) {
            if (needsRuntimeRequest(name, Build.VERSION.SDK_INT) && !"granted".equals(state(name))) runtime.add(name);
        }
        if (runtime.isEmpty()) {
            call.resolve(snapshot(names));
            return;
        }
        requestPermissionForAliases(runtime.toArray(new String[0]), call, "afterRequest");
    }

    @PermissionCallback
    private void afterRequest(PluginCall call) {
        call.resolve(snapshot(names(call)));
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", getContext().getPackageName(), null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
