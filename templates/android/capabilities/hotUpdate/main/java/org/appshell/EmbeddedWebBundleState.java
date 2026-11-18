package org.appshell;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;

import com.getcapacitor.plugin.WebView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.util.Locale;

final class EmbeddedWebBundleState {
    static final String OWN_PREFS = "AppShellWebBundle";
    static final String BUNDLES_DIR = "webbundles";
    private static final String KEY_APK_UPDATE_TIME = "appshellApkUpdateTime";
    private static final String KEY_EMBEDDED_BUNDLE_SHA256 = "appshellEmbeddedBundleSha256";

    private EmbeddedWebBundleState() {}

    static void resetAfterApkUpdate(Context context) {
        long updateTime;
        try {
            updateTime = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).lastUpdateTime;
        } catch (PackageManager.NameNotFoundException ignored) {
            updateTime = -1L;
        }
        resetAfterApkUpdate(updateTime, embeddedBundleSha256(context),
            context.getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Activity.MODE_PRIVATE),
            context.getSharedPreferences(OWN_PREFS, Activity.MODE_PRIVATE), context.getFilesDir());
    }

    static void resetAfterApkUpdate(long updateTime, String embeddedBundleSha256,
                                    SharedPreferences cap, SharedPreferences own, File filesDir) {
        boolean sameApk = updateTime > 0L && cap.getLong(KEY_APK_UPDATE_TIME, -1L) == updateTime;
        boolean sameBundle = embeddedBundleSha256 != null
            && embeddedBundleSha256.equals(cap.getString(KEY_EMBEDDED_BUNDLE_SHA256, null));
        if (sameApk && sameBundle) return;
        SharedPreferences.Editor editor = cap.edit()
            .remove(WebView.CAP_SERVER_PATH)
            .putLong(KEY_APK_UPDATE_TIME, updateTime);
        if (embeddedBundleSha256 == null) editor.remove(KEY_EMBEDDED_BUNDLE_SHA256);
        else editor.putString(KEY_EMBEDDED_BUNDLE_SHA256, embeddedBundleSha256);
        // Bridge 会在 super.onCreate 内读取路径；同步落盘避免覆盖安装仍抢先加载旧目录。
        editor.commit();
        own.edit().clear().commit();
        deleteRecursively(new File(filesDir, BUNDLES_DIR));
    }

    private static String embeddedBundleSha256(Context context) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                context.getAssets().open("public/" + WebBundleContract.MANIFEST_FILE)))) {
            StringBuilder json = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) json.append(line);
            String value = new JSONObject(json.toString()).optString("bundleSha256", "").trim();
            return value.matches("[0-9a-fA-F]{64}") ? value.toLowerCase(Locale.ROOT) : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    /** APK 内置产物的 webVersion（三段数字）；读不到返回 null，自动热更新就不启用（比不出新旧宁可不更新）。 */
    static String embeddedWebVersion(Context context) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                context.getAssets().open("public/" + WebBundleContract.MANIFEST_FILE)))) {
            StringBuilder json = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) json.append(line);
            String value = new JSONObject(json.toString()).optString("webVersion", "").trim();
            return value.matches("\\d+\\.\\d+\\.\\d+") ? value : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    static void deleteRecursively(File file) {
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursively(child);
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
