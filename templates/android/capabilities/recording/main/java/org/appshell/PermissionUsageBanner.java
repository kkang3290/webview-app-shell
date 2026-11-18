package org.appshell;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

/** 系统权限框显示期间固定在 Activity 顶部的用途说明。 */
final class PermissionUsageBanner {
    static final String DEFAULT_TITLE = "权限申请说明";
    static final String DEFAULT_BODY = AppShellConfig.APP_NAME + " 需要获得该权限以继续。";
    static final long REQUEST_DELAY_MS = 180L;

    private View banner;

    static String orDefault(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value;
    }

    void show(Activity activity, String title, String body) {
        hideNow();

        FrameLayout root = activity.findViewById(android.R.id.content);
        LinearLayout card = new LinearLayout(activity);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(activity, 16), dp(activity, 14), dp(activity, 16), dp(activity, 14));
        card.setElevation(dp(activity, 8));
        card.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        card.setContentDescription(
                orDefault(title, DEFAULT_TITLE) + "。" + orDefault(body, DEFAULT_BODY));

        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.WHITE);
        background.setCornerRadius(dp(activity, 12));
        card.setBackground(background);

        TextView titleView = new TextView(activity);
        titleView.setText(orDefault(title, DEFAULT_TITLE));
        titleView.setTextColor(Color.rgb(24, 24, 24));
        titleView.setTextSize(16);
        titleView.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        card.addView(titleView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView bodyView = new TextView(activity);
        bodyView.setText(orDefault(body, DEFAULT_BODY));
        bodyView.setTextColor(Color.rgb(85, 85, 85));
        bodyView.setTextSize(14);
        bodyView.setLineSpacing(0, 1.18f);
        bodyView.setMaxLines(4);
        LinearLayout.LayoutParams bodyParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        bodyParams.topMargin = dp(activity, 6);
        card.addView(bodyView, bodyParams);

        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP);
        int margin = dp(activity, 10);
        params.leftMargin = margin;
        params.rightMargin = margin;
        params.topMargin = statusBarInset(root) + margin;
        root.addView(card, params);
        banner = card;
    }

    void hide(Activity activity) {
        if (activity == null) {
            hideNow();
            return;
        }
        activity.runOnUiThread(this::hideNow);
    }

    private void hideNow() {
        if (banner == null) return;
        if (banner.getParent() instanceof ViewGroup) {
            ((ViewGroup) banner.getParent()).removeView(banner);
        }
        banner = null;
    }

    private static int statusBarInset(View root) {
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(root);
        if (insets == null) return 0;
        int[] location = new int[2];
        root.getLocationOnScreen(location);
        return Math.max(0, insets.getInsets(WindowInsetsCompat.Type.statusBars()).top - location[1]);
    }

    private static int dp(Activity activity, int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }
}
