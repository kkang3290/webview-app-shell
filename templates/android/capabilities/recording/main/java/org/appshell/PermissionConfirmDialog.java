package org.appshell;

import android.app.Activity;

import androidx.appcompat.app.AlertDialog;

import java.util.concurrent.atomic.AtomicBoolean;

/** 系统权限框之前的应用内用途确认。 */
final class PermissionConfirmDialog {
    interface Callback {
        void onResult(boolean confirmed);
    }

    static final String DEFAULT_TITLE = "需要您确认";
    static final String DEFAULT_CONFIRM = "确定";
    static final String DEFAULT_CANCEL = "取消";
    static final String DEFAULT_BODY = AppShellConfig.APP_NAME + " 需要获得该权限以继续。";

    private PermissionConfirmDialog() {}

    static String orDefault(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value;
    }

    static Callback settleOnce(Callback callback) {
        AtomicBoolean settled = new AtomicBoolean(false);
        return confirmed -> {
            if (settled.compareAndSet(false, true)) callback.onResult(confirmed);
        };
    }

    static void showOrSettle(Runnable show, Callback once) {
        try {
            show.run();
        } catch (Throwable t) {
            once.onResult(false);
        }
    }

    static void show(Activity activity, String title, String body, String confirmText, String cancelText, Callback callback) {
        Callback once = settleOnce(callback);
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
            once.onResult(false);
            return;
        }

        activity.runOnUiThread(() -> showOrSettle(
                () -> new AlertDialog.Builder(activity)
                        .setTitle(orDefault(title, DEFAULT_TITLE))
                        .setMessage(orDefault(body, DEFAULT_BODY))
                        .setCancelable(true)
                        .setNegativeButton(orDefault(cancelText, DEFAULT_CANCEL), (dialog, which) -> once.onResult(false))
                        .setPositiveButton(orDefault(confirmText, DEFAULT_CONFIRM), (dialog, which) -> once.onResult(true))
                        .setOnCancelListener(dialog -> once.onResult(false))
                        .show(),
                once));
    }
}
