package org.appshell;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.regex.Pattern;

/**
 * 厂商通道点开通知的入口（push.android.tap 声明的 scheme://host/path）。后端下发的 intent 只能带字符串参数：
 * URI 查询参数与字符串 extras 一起作为通知的 data 交给网页；不接受任意跳转地址，只拉起本 App。
 */
public class PushTapActivity extends Activity {
    private static final Pattern KEY = Pattern.compile("[A-Za-z][A-Za-z0-9_]{0,40}");
    private static final int MAX_VALUE = 512;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent intent = getIntent();
        JSONObject data = new JSONObject();
        try {
            Uri uri = intent.getData();
            if (uri != null && uri.isHierarchical()) {
                for (String key : uri.getQueryParameterNames()) put(data, key, uri.getQueryParameter(key));
            }
            Bundle extras = intent.getExtras();
            if (extras != null) {
                for (String key : extras.keySet()) {
                    Object value = extras.get(key);
                    if (value instanceof String) put(data, key, (String) value);
                }
            }
        } catch (RuntimeException | JSONException ignored) {
            // 畸形的 intent 只是不带数据，仍然拉起 App
        }
        PushPlugin.onOpened(PushPlugin.payload(PushPlugin.idOf(data), "", "", data));
        Intent launch = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(launch);
        finish();
    }

    private static void put(JSONObject data, String key, String value) throws JSONException {
        if (key == null || value == null || !KEY.matcher(key).matches() || value.length() > MAX_VALUE) return;
        data.put(key, value);
    }
}
