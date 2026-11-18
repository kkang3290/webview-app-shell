package org.appshell;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.tencent.mm.opensdk.modelbase.BaseResp;
import com.tencent.mm.opensdk.modelmsg.SendAuth;
import com.tencent.mm.opensdk.openapi.IWXAPI;
import com.tencent.mm.opensdk.openapi.WXAPIFactory;

import java.lang.ref.WeakReference;
import java.util.UUID;
import java.util.Timer;
import java.util.TimerTask;

@CapacitorPlugin(name = "WechatAuth")
public class WechatAuthPlugin extends Plugin {
    private static WeakReference<WechatAuthPlugin> activePlugin = new WeakReference<>(null);

    private IWXAPI api;
    private PluginCall pendingCall;
    private String pendingState;
    private Timer pendingTimeout;
    private boolean authorizationPaused;

    @Override
    public void load() {
        activePlugin = new WeakReference<>(this);
        api = WXAPIFactory.createWXAPI(getContext(), getContext().getString(R.string.wechat_app_id), true);
        api.registerApp(getContext().getString(R.string.wechat_app_id));
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", api != null && api.isWXAppInstalled());
        call.resolve(result);
    }

    @PluginMethod
    public synchronized void authorize(PluginCall call) {
        if (api == null || !api.isWXAppInstalled()) {
            call.reject("WeChat is not installed");
            return;
        }
        if (pendingCall != null) {
            call.reject("WeChat authorization is already in progress");
            return;
        }

        pendingCall = call;
        pendingState = UUID.randomUUID().toString();
        pendingTimeout = new Timer("WechatAuth", true);
        pendingTimeout.schedule(new TimerTask() {
            @Override
            public void run() {
                expireAuthorization(call);
            }
        }, 60_000L);
        SendAuth.Req request = new SendAuth.Req();
        request.scope = "snsapi_userinfo";
        // 登录与绑定均要求用户手动授权，避免已授权账户直接返回 code。
        request.nonAutomatic = true;
        request.state = pendingState;
        try {
            if (api.sendReq(request)) return;
            clearPending();
            call.reject("Unable to start WeChat authorization");
        } catch (RuntimeException error) {
            clearPending();
            call.reject("Unable to start WeChat authorization");
        }
    }

    public static void handleResponse(BaseResp response) {
        WechatAuthPlugin plugin = activePlugin.get();
        if (plugin != null) plugin.finishAuthorization(response);
    }

    synchronized void finishAuthorization(BaseResp response) {
        PluginCall call = pendingCall;
        if (call == null) return;

        if (!(response instanceof SendAuth.Resp)) {
            clearPending();
            call.reject("Unexpected WeChat response");
            return;
        }
        SendAuth.Resp auth = (SendAuth.Resp) response;
        finishAuthorization(auth.errCode, auth.code, auth.state);
    }

    synchronized void finishAuthorization(int errorCode, String code, String state) {
        PluginCall call = pendingCall;
        if (call == null) return;
        String expectedState = pendingState;
        if (state != null && !state.isEmpty() && !state.equals(expectedState)) return;
        clearPending();
        if (errorCode == BaseResp.ErrCode.ERR_USER_CANCEL) {
            resolveCancelled(call);
            return;
        }
        if (errorCode != BaseResp.ErrCode.ERR_OK || code == null || code.isEmpty()) {
            call.reject("WeChat authorization failed", String.valueOf(errorCode));
            return;
        }
        // 微信拒绝签名等失败响应时可能不回传 state；只对成功响应做 CSRF 校验，
        // 否则会把真正的 SDK 错误误报成 state 异常。
        if (expectedState == null || !expectedState.equals(state)) {
            call.reject("Invalid WeChat authorization state");
            return;
        }
        JSObject result = new JSObject();
        result.put("code", code);
        call.resolve(result);
    }

    @Override
    protected synchronized void handleOnPause() {
        if (pendingCall != null) authorizationPaused = true;
        super.handleOnPause();
    }

    @Override
    protected synchronized void handleOnResume() {
        super.handleOnResume();
        if (!authorizationPaused || pendingCall == null) return;
        authorizationPaused = false;
        PluginCall call = pendingCall;
        // 微信关闭授权页可能不回调；给回调 Activity 留出处理时间，再释放本次等待。
        pendingTimeout.schedule(new TimerTask() {
            @Override
            public void run() {
                cancelReturnedAuthorization(call);
            }
        }, 500L);
    }

    synchronized void cancelReturnedAuthorization(PluginCall call) {
        if (pendingCall != call || authorizationPaused) return;
        clearPending();
        resolveCancelled(call);
    }

    void resolveCancelled(PluginCall call) {
        JSObject result = new JSObject();
        result.put("cancelled", true);
        call.resolve(result);
    }

    private void clearPending() {
        authorizationPaused = false;
        if (pendingTimeout != null) pendingTimeout.cancel();
        pendingTimeout = null;
        pendingCall = null;
        pendingState = null;
    }

    synchronized void expireAuthorization(PluginCall call) {
        if (pendingCall != call) return;
        clearPending();
        call.reject("WeChat authorization timed out. Please try again.", "WECHAT_AUTH_TIMEOUT");
    }

    @Override
    protected synchronized void handleOnDestroy() {
        PluginCall call = pendingCall;
        clearPending();
        if (activePlugin.get() == this) activePlugin.clear();
        if (call != null) call.reject("WeChat authorization interrupted", "WECHAT_AUTH_INTERRUPTED");
        super.handleOnDestroy();
    }
}
