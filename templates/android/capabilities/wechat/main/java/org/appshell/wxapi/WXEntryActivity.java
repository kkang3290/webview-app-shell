package org.appshell.wxapi;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

import org.appshell.R;
import org.appshell.WechatAuthPlugin;

import com.tencent.mm.opensdk.modelbase.BaseReq;
import com.tencent.mm.opensdk.modelbase.BaseResp;
import com.tencent.mm.opensdk.modelmsg.SendAuth;
import com.tencent.mm.opensdk.openapi.IWXAPI;
import com.tencent.mm.opensdk.openapi.IWXAPIEventHandler;
import com.tencent.mm.opensdk.openapi.WXAPIFactory;

public class WXEntryActivity extends Activity implements IWXAPIEventHandler {
    private IWXAPI api;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        api = WXAPIFactory.createWXAPI(this, getString(R.string.wechat_app_id), false);
        api.handleIntent(getIntent(), this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        api.handleIntent(intent, this);
    }

    @Override
    public void onReq(BaseReq request) {
        finish();
    }

    @Override
    public void onResp(BaseResp response) {
        // 分享回调不能交给登录插件，否则会把进行中的授权误判为异常响应。
        if (response instanceof SendAuth.Resp) WechatAuthPlugin.handleResponse(response);
        finish();
    }
}
