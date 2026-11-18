package org.appshell;

import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.RequiresApi;
import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;

import java.net.URI;
import java.util.Arrays;

public class MainActivity extends BridgeActivity {
    static final long BACK_TO_DESKTOP_WINDOW_MS = 2_000L;
    static final String SHORTCUT_PATH_EXTRA = "org.appshell.shortcut_path";

    private long lastRootBackPressedAt = -1L;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Install before super so Android 11 and older use the same launch theme as Android 12+.
        SplashScreen.installSplashScreen(this);
        // 能力组由 appshell.config.json 决定，生成的 AppShellPlugins 只登记启用的插件；
        // 必须在 super.onCreate 之前，bridge 启动时才扫得到。
        AppShellPlugins.beforeBridge(this);
        AppShellPlugins.register(this);
        registerPlugin(AppControlPlugin.class);
        registerPlugin(StatusBarThemePlugin.class);
        registerPlugin(PermissionsPlugin.class);
        super.onCreate(savedInstanceState);
        // 应用页面不做 WebView 整页缩放；图片预览仍由页面自己的手势处理。
        getBridge().getWebView().getSettings().setSupportZoom(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Audio processing must retain the highest renderer binding while hidden/locked.
            getBridge().getWebView().setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
        StatusBarThemePlugin.configureOverlay(this, getBridge());
        publishLauncherShortcuts();

        // Tab 是应用根页，不能按 WebView 历史退回已关闭的子页。
        // 子页仍正常出栈，根页沿用双击退到桌面、保留录音进程。
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() == null) {
                    handleDefaultBack();
                    return;
                }
                // 先让页面自己处理返回（例如收起展开的面板），页面 preventDefault 时到此为止。
                getBridge().getWebView().evaluateJavascript(
                    "window.dispatchEvent(new Event('" + AppShellConfig.NATIVE_BACK_EVENT + "', {cancelable:true}))",
                    result -> {
                        if ("false".equals(result)) lastRootBackPressedAt = -1L;
                        else handleDefaultBack();
                    }
                );
            }
        });
    }

    private void handleDefaultBack() {
        if (getBridge() != null && getBridge().getWebView().canGoBack()
            && !isRootPage(getBridge().getWebView().getUrl(), getBridge().getLocalUrl(), AppShellConfig.ROOT_PAGES)) {
            lastRootBackPressedAt = -1L;
            getBridge().getWebView().goBack();
            return;
        }

        long now = SystemClock.elapsedRealtime();
        if (shouldReturnToDesktop(lastRootBackPressedAt, now)) {
            lastRootBackPressedAt = -1L;
            // 退到桌面但不杀进程：正在录音时按返回不该终止录音
            moveTaskToBack(true);
            return;
        }

        lastRootBackPressedAt = now;
        Toast.makeText(MainActivity.this, R.string.back_again_to_desktop, Toast.LENGTH_SHORT).show();
    }

    private void publishLauncherShortcuts() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) {
            return;
        }
        ShortcutManager manager = getSystemService(ShortcutManager.class);
        if (manager == null) {
            return;
        }
        ShortcutInfo[] shortcuts = new ShortcutInfo[AppShellConfig.SHORTCUTS.length];
        for (int i = 0; i < shortcuts.length; i++) {
            AppShellConfig.Shortcut item = AppShellConfig.SHORTCUTS[i];
            shortcuts[i] = shortcut(item.id, item.label, item.icon, item.path, i);
        }
        manager.setDynamicShortcuts(Arrays.asList(shortcuts));
    }

    @RequiresApi(Build.VERSION_CODES.N_MR1)
    private ShortcutInfo shortcut(String id, String label, int icon, String path, int rank) {
        Intent intent = new Intent(this, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .putExtra(SHORTCUT_PATH_EXTRA, path);
        return new ShortcutInfo.Builder(this, id)
            .setShortLabel(label)
            .setIcon(Icon.createWithResource(this, icon))
            .setIntent(intent)
            .setRank(rank)
            .build();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        setIntent(intent);
        super.onNewIntent(intent);
        openShortcut(intent);
    }

    private void openShortcut(Intent intent) {
        String path = shortcutPath(intent == null ? null : intent.getStringExtra(SHORTCUT_PATH_EXTRA), AppShellConfig.SHORTCUTS);
        if (path == null || getBridge() == null) {
            return;
        }
        intent.removeExtra(SHORTCUT_PATH_EXTRA);

        WebView webView = getBridge().getWebView();
        String localUrl = getBridge().getLocalUrl();
        webView.post(() -> {
            String currentUrl = webView.getUrl();
            if (currentUrl == null || webView.getProgress() < 100 || !currentUrl.startsWith(localUrl)) {
                webView.loadUrl(localUrl + path);
                return;
            }
            webView.evaluateJavascript(
                "window.history.replaceState(window.history.state,'','" + path + "');window.dispatchEvent(new PopStateEvent('popstate'));",
                null
            );
        });
    }

    static String shortcutPath(String path, AppShellConfig.Shortcut[] shortcuts) {
        if (path == null) return null;
        for (AppShellConfig.Shortcut item : shortcuts) {
            if (item.path.equals(path)) return path;
        }
        return null;
    }

    /**
     * 根页（Tab 一级页）按返回键不回退 WebView 历史，而是双击退到桌面。
     * 某些根页靠 query 打开子视图（例如 /timeline?id=7），那种 query 列在 childQuery 里：
     * 写 "id" 表示带这个参数就是子页，写 "tab=facts" 表示参数取这个值才是子页。
     */
    static boolean isRootPage(String url, String localUrl, AppShellConfig.RootPage[] rootPages) {
        if (url == null || localUrl == null) return false;
        try {
            URI current = URI.create(url);
            URI local = URI.create(localUrl);
            if (local.getScheme() == null || local.getAuthority() == null
                || !local.getScheme().equals(current.getScheme())
                || !local.getAuthority().equals(current.getAuthority())) return false;
            String path = current.getPath();
            String[] query = current.getQuery() == null ? new String[0] : current.getQuery().split("&");
            for (AppShellConfig.RootPage page : rootPages) {
                if (!page.path.equals(path)) continue;
                for (String child : page.childQuery) {
                    boolean keyOnly = child.indexOf('=') < 0;
                    for (String part : query) {
                        if (keyOnly ? part.startsWith(child + "=") : part.equals(child)) return false;
                    }
                }
                return true;
            }
            return false;
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    static boolean shouldReturnToDesktop(long lastPressedAt, long now) {
        return lastPressedAt >= 0L
            && now >= lastPressedAt
            && now - lastPressedAt <= BACK_TO_DESKTOP_WINDOW_MS;
    }
}
