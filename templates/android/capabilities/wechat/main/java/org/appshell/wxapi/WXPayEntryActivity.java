package org.appshell.wxapi;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

import org.appshell.MainActivity;
import org.appshell.R;
import org.appshell.WechatPayPlugin;

import com.tencent.mm.opensdk.modelbase.BaseReq;
import com.tencent.mm.opensdk.modelbase.BaseResp;
import com.tencent.mm.opensdk.modelpay.PayResp;
import com.tencent.mm.opensdk.openapi.IWXAPI;
import com.tencent.mm.opensdk.openapi.IWXAPIEventHandler;
import com.tencent.mm.opensdk.openapi.WXAPIFactory;

public class WXPayEntryActivity extends Activity implements IWXAPIEventHandler {
    private IWXAPI api;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            api = WXAPIFactory.createWXAPI(this, getString(R.string.wechat_app_id), true);
            handlePaymentIntent(getIntent());
        } catch (RuntimeException ignored) {
            finish();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handlePaymentIntent(intent);
    }

    private void handlePaymentIntent(Intent intent) {
        try {
            if (api != null && intent != null) api.handleIntent(intent, this);
        } catch (RuntimeException ignored) {
            // Invalid external intents cannot settle or cancel a pending payment.
        } finally {
            finish();
        }
    }

    @Override
    public void onReq(BaseReq request) {
        finish();
    }

    @Override
    public void onResp(BaseResp response) {
        if (!WechatPayPlugin.handleResponse(response) && response instanceof PayResp) {
            // A killed process has no pending JS promise. Restore the app, never replay a payment.
            startActivity(new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
        }
        finish();
    }

    @Override
    protected void onDestroy() {
        if (api != null) {
            try {
                api.detach();
            } catch (RuntimeException ignored) {
                // No payment data or SDK exception is logged.
            }
        }
        super.onDestroy();
    }
}
