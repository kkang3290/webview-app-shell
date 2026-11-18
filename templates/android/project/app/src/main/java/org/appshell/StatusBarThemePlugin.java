package org.appshell;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.view.Window;
import android.view.View;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.WebViewListener;

import androidx.core.view.WindowCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "StatusBarTheme")
public class StatusBarThemePlugin extends Plugin {
    static void configureOverlay(Activity activity, Bridge bridge) {
        Window window = activity.getWindow();
        WindowCompat.enableEdgeToEdge(window);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
        WindowCompat.getInsetsController(window, window.getDecorView())
            .setAppearanceLightStatusBars(true);
        WindowCompat.getInsetsController(window, window.getDecorView())
            .setAppearanceLightNavigationBars(true);
        WebView webView = bridge.getWebView();
        View parent = (View) webView.getParent();
        // 顶部交给页面安全区；从底部缩短 WebView，避免键盘遮挡输入或整页上推。
        ViewCompat.setOnApplyWindowInsetsListener(parent, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            int bottom = Math.max(bars.bottom, insets.getInsets(WindowInsetsCompat.Type.ime()).bottom);
            // Capacitor 的 SystemBars 也会在窗口根视图上按键盘高度留白（它的监听先于这里执行），
            // 而且不会把键盘的 inset 清掉。已经留过的部分不能再扣一次，否则键盘弹出时页面被缩两遍，
            // 输入框飘在键盘上方很远。
            bottom = bottomPadding(bottom, window.getDecorView().getPaddingBottom());
            view.setPadding(bars.left, 0, bars.right, bottom);
            safeTop = bars.top / activity.getResources().getDisplayMetrics().density;
            applySafeTop(webView);
            return new WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime(), Insets.NONE)
                .build();
        });
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageCommitVisible(WebView view, String url) {
                // 新文档不带上一个文档的内联样式：先把已知的状态栏高度写回去，再请求重新分发 insets。
                // 只靠重新分发的话，insets 没变化时页面可能一直拿不到这个值，内容就顶进状态栏里。
                applySafeTop(view);
                ViewCompat.requestApplyInsets(parent);
            }

            @Override
            public void onPageLoaded(WebView view) {
                applySafeTop(view);
            }
        });
        ViewCompat.requestApplyInsets(parent);
    }

    /** 最近一次分发到的状态栏高度（dp）。 */
    private static float safeTop;

    private static void applySafeTop(WebView webView) {
        webView.evaluateJavascript("document.documentElement?.style.setProperty('--appshell-native-safe-top','" + safeTop + "px')", null);
    }

    /** WebView 容器底部还要留多少：系统栏 / 键盘占的高度，减去上层已经留出的部分。 */
    static int bottomPadding(int inset, int alreadyPadded) {
        return Math.max(0, inset - Math.max(0, alreadyPadded));
    }

    @PluginMethod
    public void setTheme(PluginCall call) {
        String colorValue = call.getString("color");
        Boolean darkIcons = call.getBoolean("darkIcons");
        if (colorValue == null || darkIcons == null) {
            call.reject("color 和 darkIcons 必填");
            return;
        }

        final int color;
        try {
            color = Color.parseColor(colorValue);
        } catch (IllegalArgumentException error) {
            call.reject("color 不是合法颜色", error);
            return;
        }

        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity 不可用");
            return;
        }
        activity.runOnUiThread(() -> {
            Window window = activity.getWindow();
            window.getDecorView().setBackgroundColor(color);
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
                setLegacyStatusBarColor(window, Color.TRANSPARENT);
            }
            WindowCompat.getInsetsController(window, window.getDecorView())
                .setAppearanceLightStatusBars(darkIcons);
            WindowCompat.getInsetsController(window, window.getDecorView())
                .setAppearanceLightNavigationBars(darkIcons);
            call.resolve();
        });
    }

    @SuppressWarnings("deprecation")
    private static void setLegacyStatusBarColor(Window window, int color) {
        window.setStatusBarColor(color);
    }
}
