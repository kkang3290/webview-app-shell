package org.appshell;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.webkit.WebSettings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.plugin.WebView;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 前端产物（dist-shell）的热更新：下载 zip → sha256 校验 → 解压 → 切换 WebView 服务目录。
 *
 * 路径持久化直接写 Capacitor 自己的偏好（CapWebViewSettings/serverBasePath）：
 * bridge 启动时会读它并校验目录存在。Capacitor 的 isNewBinary 只识别版本变化，
 * 所以 MainActivity 在 bridge 创建前按 APK 安装时间和内嵌 Bundle SHA 清理旧热更。
 *
 * 坏包防护是两阶段确认：activate 后 confirmed=false，JS 启动成功要调 notifyReady；
 * 连续两次冷启动都没等到确认，就认定包是坏的，回退内置产物。没有这道闸，
 * 一个白屏的热更新包会把没有商店可回滚的用户永远关在门外。
 *
 * web 侧按 window.Capacitor?.Plugins?.WebBundleUpdater 探测，浏览器目标里自然不存在。
 */
@CapacitorPlugin(name = "WebBundleUpdater")
public class WebBundleUpdaterPlugin extends Plugin {
    private static final String KEY_CONFIRMED = "confirmed";
    private static final String KEY_ATTEMPTS = "attempts";
    private static final String KEY_VERSION = "version";
    private static final String KEY_PENDING_PATH = "pendingPath";
    private static final String KEY_PENDING_VERSION = "pendingVersion";
    private static final String KEY_BAD = "badVersions";
    private static final int MAX_BOOT_ATTEMPTS = 2;
    private static final Pattern CHROMIUM_VERSION = Pattern.compile("\\bChrome/(\\d+)\\.");

    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        // 回退与切换都在 bridge 创建前做完（prepareBeforeBridge），这里只做后台检查。
        // 不能在 load() 里切目录：那时 bridge 还在装配，原地重载会让页面拿到不完整的插件表。
        if (!AutoUpdate.NEXT_LAUNCH.equals(AppShellConfig.HOT_UPDATE_APPLY)) return;
        if (!supportsWebView(WebSettings.getDefaultUserAgent(getContext()))) return;
        executor.execute(this::checkInBackground);
    }

    /**
     * MainActivity 在 bridge 创建前调用（AppShellPlugins.beforeBridge），只读写偏好，不碰 bridge：
     * 1. 坏包防护：上次切了包但连续冷启动没等到 notifyReady → 回退内置产物，并把该版本记为坏包。
     * 2. 自动热更新（next-launch）：上次后台下载好的更新的包，这次冷启动直接作为服务目录（仍走两阶段确认）。
     */
    static void prepareBeforeBridge(Context context) {
        SharedPreferences cap = context.getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Activity.MODE_PRIVATE);
        SharedPreferences own = context.getSharedPreferences(EmbeddedWebBundleState.OWN_PREFS, Activity.MODE_PRIVATE);
        String path = cap.getString(WebView.CAP_SERVER_PATH, null);
        if (path != null && !path.isEmpty() && !own.getBoolean(KEY_CONFIRMED, false)) {
            int attempts = own.getInt(KEY_ATTEMPTS, 0) + 1;
            if (attempts >= MAX_BOOT_ATTEMPTS) {
                String badVersion = own.getString(KEY_VERSION, null);
                String bad = AutoUpdate.addBad(own.getString(KEY_BAD, ""), badVersion);
                cap.edit().remove(WebView.CAP_SERVER_PATH).commit();
                own.edit().clear().putString(KEY_BAD, bad).commit();
            } else {
                own.edit().putInt(KEY_ATTEMPTS, attempts).commit();
            }
        }
        if (!AutoUpdate.NEXT_LAUNCH.equals(AppShellConfig.HOT_UPDATE_APPLY)) return;
        String pendingPath = own.getString(KEY_PENDING_PATH, null);
        String pendingVersion = own.getString(KEY_PENDING_VERSION, null);
        if (pendingPath == null || pendingVersion == null) return;
        String current = currentVersion(context);
        File dir = new File(pendingPath);
        if (!AutoUpdate.isNewer(pendingVersion, current) || AutoUpdate.isBad(own.getString(KEY_BAD, ""), pendingVersion)) {
            own.edit().remove(KEY_PENDING_PATH).remove(KEY_PENDING_VERSION).commit();
            return;
        }
        try {
            WebBundleContract.validatePublishedBundle(dir);
        } catch (IOException error) {
            own.edit().remove(KEY_PENDING_PATH).remove(KEY_PENDING_VERSION).commit();
            EmbeddedWebBundleState.deleteRecursively(dir);
            return;
        }
        cap.edit().putString(WebView.CAP_SERVER_PATH, dir.getAbsolutePath()).commit();
        // 这次冷启动算第 1 次尝试：再一次冷启动还没确认就回退
        own.edit().putBoolean(KEY_CONFIRMED, false).putInt(KEY_ATTEMPTS, 1).putString(KEY_VERSION, pendingVersion)
            .remove(KEY_PENDING_PATH).remove(KEY_PENDING_VERSION).commit();
    }

    /** 查最新版 → 比当前新、不是坏包、没下过 → 下载校验解压，记为待启用。失败安静放弃，下次启动再试。 */
    private void checkInBackground() {
        try {
            AutoUpdate.Latest latest = AutoUpdate.parseLatest(httpGet(AppShellConfig.HOT_UPDATE_LATEST_URL));
            if (latest == null) return;
            SharedPreferences own = ownPrefs();
            if (!AutoUpdate.isNewer(latest.version, currentVersion())) return;
            if (AutoUpdate.isBad(own.getString(KEY_BAD, ""), latest.version)) return;
            if (latest.version.equals(own.getString(KEY_PENDING_VERSION, null))) return;
            String url = AutoUpdate.resolveUrl(latest.url, AppShellConfig.HOT_UPDATE_LATEST_URL);
            if (url == null) return;
            String sha256 = AutoUpdate.parseSha256(httpGet(url + ".sha256"));
            if (sha256 == null) return;
            File zip = new File(getContext().getCacheDir(), "webbundle-" + latest.version + ".zip");
            try {
                download(url, zip, sha256);
                File dir = extract(zip, latest.version);
                own.edit().putString(KEY_PENDING_PATH, dir.getAbsolutePath())
                    .putString(KEY_PENDING_VERSION, latest.version).apply();
                pruneOldBundles(dir.getName());
            } finally {
                //noinspection ResultOfMethodCallIgnored
                zip.delete();
            }
        } catch (Exception ignored) {
            // 网络不好、发布中途等都安静放弃；坏包防护不依赖这里
        }
    }

    /**
     * 当前在跑的 web 版本：正在用热更包就是热更包的版本，否则是 APK 内置产物的 webVersion。
     * Capacitor 不用热更包时会把 serverBasePath 存成空串，空串和没有同样对待。
     */
    static String currentVersion(Context context) {
        String path = context.getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Activity.MODE_PRIVATE)
            .getString(WebView.CAP_SERVER_PATH, null);
        if (path != null && !path.isEmpty()) {
            String active = context.getSharedPreferences(EmbeddedWebBundleState.OWN_PREFS, Activity.MODE_PRIVATE)
                .getString(KEY_VERSION, null);
            if (active != null) return active;
        }
        return EmbeddedWebBundleState.embeddedWebVersion(context);
    }

    private String currentVersion() {
        return currentVersion(getContext());
    }

    private static String httpGet(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        try {
            if (connection.getResponseCode() != 200) throw new IOException("HTTP " + connection.getResponseCode());
            try (InputStream in = connection.getInputStream()) {
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                copy(in, out);
                return out.toString("UTF-8");
            }
        } finally {
            connection.disconnect();
        }
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject result = new JSObject();
        try {
            result.put("shellVersion", getContext().getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0).versionName);
        } catch (PackageManager.NameNotFoundException e) {
            result.put("shellVersion", "");
        }
        result.put("bundleVersion", ownPrefs().getString(KEY_VERSION, null));
        // 页面据此决定要不要自己提示：next-launch 时外壳下次冷启动自动切换，页面不用管
        result.put("apply", AppShellConfig.HOT_UPDATE_APPLY);
        result.put("webVersion", currentVersion());
        call.resolve(result);
    }

    @PluginMethod
    public void notifyReady(PluginCall call) {
        if (!requireSupportedWebView(call)) return;
        // 只有真在跑热更新包时才有确认可言；跑内置产物时调它是 no-op
        String activePath = capPrefs().getString(WebView.CAP_SERVER_PATH, null);
        if (activePath != null && !activePath.isEmpty()) {
            ownPrefs().edit().putBoolean(KEY_CONFIRMED, true).putInt(KEY_ATTEMPTS, 0).apply();
        }
        call.resolve();
    }

    @PluginMethod
    public void install(PluginCall call) {
        if (!requireSupportedWebView(call)) return;
        String url = call.getString("url");
        String version = call.getString("version");
        String sha256 = call.getString("sha256");
        if (url == null || version == null || sha256 == null
            || !version.matches("\\d+\\.\\d+\\.\\d+")) {
            call.reject("install 需要 url/version/sha256，version 必须是三段数字");
            return;
        }
        executor.execute(() -> {
            // 已经解压过同版本（上次下载后用户点了"稍后"）就直接复用，不再下载
            File existing = new File(new File(getContext().getFilesDir(), EmbeddedWebBundleState.BUNDLES_DIR), version);
            if (new File(existing, "index.html").isFile()) {
                try {
                    WebBundleContract.validatePublishedBundle(existing);
                    JSObject result = new JSObject();
                    result.put("path", existing.getAbsolutePath());
                    call.resolve(result);
                    return;
                } catch (IOException ignored) {
                    EmbeddedWebBundleState.deleteRecursively(existing);
                }
            }
            File zip = new File(getContext().getCacheDir(), "webbundle-" + version + ".zip");
            try {
                download(url, zip, sha256);
                File bundleDir = extract(zip, version);
                pruneOldBundles(bundleDir.getName());
                JSObject result = new JSObject();
                result.put("path", bundleDir.getAbsolutePath());
                call.resolve(result);
            } catch (Exception e) {
                call.reject("热更新包安装失败: " + e.getMessage(), e);
            } finally {
                //noinspection ResultOfMethodCallIgnored
                zip.delete();
            }
        });
    }

    @PluginMethod
    public void activate(PluginCall call) {
        if (!requireSupportedWebView(call)) return;
        String path = call.getString("path");
        String version = call.getString("version");
        if (path == null || version == null) {
            call.reject("activate 需要 path/version");
            return;
        }
        File dir = new File(path);
        try {
            WebBundleContract.validatePublishedBundle(dir);
        } catch (IOException error) {
            call.reject(error.getMessage(), "WEB_BUNDLE_CONTRACT_MISMATCH", error);
            return;
        }
        capPrefs().edit().putString(WebView.CAP_SERVER_PATH, dir.getAbsolutePath()).apply();
        ownPrefs().edit()
            .putBoolean(KEY_CONFIRMED, false)
            .putInt(KEY_ATTEMPTS, 0)
            .putString(KEY_VERSION, version)
            .apply();
        // setServerBasePath 内部会 post 一次 loadUrl，等价于原地重载到新包
        getActivity().runOnUiThread(() -> getBridge().setServerBasePath(dir.getAbsolutePath()));
        call.resolve();
    }

    // 华为等厂商的 WebView 包版本不等于 Chromium 版本；以实际渲染内核为准。
    static boolean supportsWebView(String userAgent) {
        if (userAgent == null) return false;
        Matcher match = CHROMIUM_VERSION.matcher(userAgent);
        if (!match.find()) return false;
        try {
            return Integer.parseInt(match.group(1)) >= 111;
        } catch (NumberFormatException ignored) {
            return false;
        }
    }

    private boolean requireSupportedWebView(PluginCall call) {
        if (supportsWebView(WebSettings.getDefaultUserAgent(getContext()))) return true;
        call.reject("请先更新 Android System WebView 或 Chrome 后重试", "UNSUPPORTED_WEBVIEW");
        return false;
    }

    // ── 下载与解压 ──────────────────────────────────────────────────────────

    private void download(String url, File target, String expectedSha256) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(60_000);
        connection.setInstanceFollowRedirects(true);
        try {
            if (connection.getResponseCode() != 200) {
                throw new IOException("下载返回 " + connection.getResponseCode());
            }
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream in = new DigestInputStream(
                    new BufferedInputStream(connection.getInputStream()), digest);
                 OutputStream out = new FileOutputStream(target)) {
                copy(in, out);
            }
            String actual = hex(digest.digest());
            if (!actual.equalsIgnoreCase(expectedSha256.trim())) {
                throw new IOException("sha256 不匹配: 期望 " + expectedSha256 + " 实际 " + actual);
            }
        } finally {
            connection.disconnect();
        }
    }

    private File extract(File zip, String version) throws IOException {
        File root = new File(getContext().getFilesDir(), EmbeddedWebBundleState.BUNDLES_DIR);
        File finalDir = new File(root, version);
        File tmpDir = new File(root, version + ".tmp");
        EmbeddedWebBundleState.deleteRecursively(tmpDir);
        if (!tmpDir.mkdirs() && !tmpDir.isDirectory()) {
            throw new IOException("建不了解压目录 " + tmpDir);
        }
        String tmpCanonical = tmpDir.getCanonicalPath() + File.separator;
        try (ZipInputStream in = new ZipInputStream(new BufferedInputStream(new FileInputStream(zip)))) {
            ZipEntry entry;
            while ((entry = in.getNextEntry()) != null) {
                File out = new File(tmpDir, entry.getName());
                // zip-slip：条目名里的 ../ 会把文件写出目录外
                if (!out.getCanonicalPath().startsWith(tmpCanonical)) {
                    throw new IOException("非法 zip 条目 " + entry.getName());
                }
                if (entry.isDirectory()) {
                    //noinspection ResultOfMethodCallIgnored
                    out.mkdirs();
                    continue;
                }
                //noinspection ResultOfMethodCallIgnored
                out.getParentFile().mkdirs();
                try (OutputStream fileOut = new FileOutputStream(out)) {
                    copy(in, fileOut);
                }
            }
        }
        if (!new File(tmpDir, "index.html").isFile()) {
            EmbeddedWebBundleState.deleteRecursively(tmpDir);
            throw new IOException("包里没有 index.html，不是前端产物");
        }
        WebBundleContract.validatePublishedBundle(tmpDir);
        EmbeddedWebBundleState.deleteRecursively(finalDir);
        if (!tmpDir.renameTo(finalDir)) {
            EmbeddedWebBundleState.deleteRecursively(tmpDir);
            throw new IOException("改名失败 " + tmpDir + " → " + finalDir);
        }
        return finalDir;
    }

    /** 只保留正在用的和刚装好的包，其余删掉，别让旧版本把用户的存储吃光。 */
    private void pruneOldBundles(String keepName) {
        String activePath = capPrefs().getString(WebView.CAP_SERVER_PATH, null);
        File root = new File(getContext().getFilesDir(), EmbeddedWebBundleState.BUNDLES_DIR);
        File[] children = root.listFiles();
        if (children == null) return;
        for (File child : children) {
            boolean isActive = activePath != null && child.getAbsolutePath().equals(activePath);
            if (!isActive && !child.getName().equals(keepName)) {
                EmbeddedWebBundleState.deleteRecursively(child);
            }
        }
    }

    private SharedPreferences capPrefs() {
        return getContext().getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Activity.MODE_PRIVATE);
    }

    private SharedPreferences ownPrefs() {
        return getContext().getSharedPreferences(EmbeddedWebBundleState.OWN_PREFS, Activity.MODE_PRIVATE);
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = in.read(buffer)) != -1) {
            out.write(buffer, 0, read);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format(Locale.ROOT, "%02x", b));
        }
        return sb.toString();
    }

}
