package org.appshell;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.tencent.mm.opensdk.constants.Build;
import com.tencent.mm.opensdk.modelbase.BaseResp;
import com.tencent.mm.opensdk.modelpay.PayReq;
import com.tencent.mm.opensdk.modelpay.PayResp;
import com.tencent.mm.opensdk.openapi.IWXAPI;
import com.tencent.mm.opensdk.openapi.WXAPIFactory;

import java.lang.ref.WeakReference;
import java.util.Timer;
import java.util.TimerTask;
import java.util.UUID;

@CapacitorPlugin(name = "WechatPay")
public class WechatPayPlugin extends Plugin {
    private static WeakReference<WechatPayPlugin> activePlugin = new WeakReference<>(null);

    private IWXAPI api;
    private String appId;
    private PluginCall pendingCall;
    private String pendingTransaction;
    private String pendingPrepayId;
    private Timer pendingTimeout;

    @Override
    public void load() {
        WechatPayPlugin previous = activePlugin.get();
        if (previous != null && previous != this) previous.interruptPayment();
        activePlugin = new WeakReference<>(this);
        appId = getContext().getString(R.string.wechat_app_id);
        try {
            api = WXAPIFactory.createWXAPI(getContext(), appId, true);
            api.registerApp(appId);
        } catch (RuntimeException ignored) {
            detachApi();
        }
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        boolean available = false;
        try {
            available = api != null && api.isWXAppInstalled()
                && api.getWXAppSupportAPI() >= Build.PAY_SUPPORTED_SDK_INT;
        } catch (RuntimeException ignored) {
            // A broken or unavailable WeChat installation must not break the checkout.
        }
        JSObject result = new JSObject();
        result.put("available", available);
        call.resolve(result);
    }

    @PluginMethod
    public synchronized void pay(PluginCall call) {
        if (pendingCall != null) {
            call.reject("WeChat payment is already in progress", "WECHAT_PAY_BUSY");
            return;
        }
        if (!validPaymentParameters(call)) {
            call.reject("Invalid WeChat payment parameters", "WECHAT_PAY_INVALID_PARAMS");
            return;
        }
        if (appId == null || !appId.equals(call.getString("appid"))) {
            call.reject("WeChat payment app ID does not match", "WECHAT_PAY_APP_ID_MISMATCH");
            return;
        }
        boolean requestStarted = false;
        try {
            if (api == null) {
                call.reject("WeChat payment is unavailable", "WECHAT_PAY_UNAVAILABLE");
                return;
            }
            if (!api.isWXAppInstalled()) {
                call.reject("WeChat is not installed", "WECHAT_NOT_INSTALLED");
                return;
            }
            if (api.getWXAppSupportAPI() < Build.PAY_SUPPORTED_SDK_INT) {
                call.reject("WeChat payment is unavailable", "WECHAT_PAY_UNAVAILABLE");
                return;
            }
            pendingCall = call;
            requestStarted = true;
            pendingPrepayId = call.getString("prepayid");
            pendingTransaction = UUID.randomUUID().toString();
            pendingTimeout = new Timer("WechatPay", true);
            pendingTimeout.schedule(new TimerTask() {
                @Override
                public void run() {
                    expirePayment(call);
                }
            }, 120_000L);
            if (sendPayment(call, pendingTransaction)) return;
        } catch (RuntimeException ignored) {
            // Do not expose the SDK exception or signed payment parameters to JS/logs.
        }
        if (requestStarted && pendingCall != call) return;
        clearPending();
        call.reject("Unable to start WeChat payment", "WECHAT_PAY_FAILED");
    }

    boolean sendPayment(PluginCall call, String transaction) {
        PayReq request = new PayReq();
        request.appId = call.getString("appid");
        request.partnerId = call.getString("partnerid");
        request.prepayId = call.getString("prepayid");
        request.packageValue = call.getString("package");
        request.nonceStr = call.getString("noncestr");
        request.timeStamp = call.getString("timestamp");
        request.sign = call.getString("sign");
        request.transaction = transaction;
        request.extData = transaction;
        return api.sendReq(request);
    }

    static boolean validPaymentParameters(PluginCall call) {
        String timestamp = call.getString("timestamp");
        return validField(call.getString("appid"), 32) && validField(call.getString("partnerid"), 32)
            && validField(call.getString("prepayid"), 64) && validField(call.getString("noncestr"), 32)
            && validField(call.getString("sign"), 512) && "Sign=WXPay".equals(call.getString("package"))
            && timestamp != null && timestamp.matches("[1-9][0-9]{9}");
    }

    private static boolean validField(String value, int maxLength) {
        return value != null && !value.isEmpty() && value.length() <= maxLength
            && value.chars().noneMatch(character -> Character.isWhitespace(character) || Character.isISOControl(character));
    }

    public static boolean handleResponse(BaseResp response) {
        WechatPayPlugin plugin = activePlugin.get();
        if (plugin == null || !(response instanceof PayResp)) return false;
        PayResp payment = (PayResp) response;
        plugin.finishPayment(payment.errCode, payment.transaction, payment.extData, payment.prepayId);
        return true;
    }

    synchronized void finishPayment(int errorCode, String transaction, String extData, String prepayId) {
        if (pendingCall == null || !matchesPending(transaction, extData, prepayId)) return;
        PluginCall call = pendingCall;
        clearPending();
        String status = paymentStatus(errorCode);
        if (status == null) {
            call.reject("WeChat payment failed", "WECHAT_PAY_FAILED");
            return;
        }
        JSObject result = new JSObject();
        // SDK success is only a return signal. The Web checkout must query the backend order.
        result.put("status", status);
        call.resolve(result);
    }

    private boolean matchesPending(String transaction, String extData, String prepayId) {
        if (pendingTransaction == null) return false;
        if (transaction != null && !transaction.isEmpty() && !pendingTransaction.equals(transaction)) return false;
        if (extData != null && !extData.isEmpty() && !pendingTransaction.equals(extData)) return false;
        if (prepayId != null && !prepayId.isEmpty() && !prepayId.equals(pendingPrepayId)) return false;
        // Unidentified/late callbacks cannot finish a newer attempt, including retries of the same order.
        return pendingTransaction.equals(transaction) || pendingTransaction.equals(extData);
    }

    static String paymentStatus(int errorCode) {
        if (errorCode == BaseResp.ErrCode.ERR_OK) return "success";
        if (errorCode == BaseResp.ErrCode.ERR_USER_CANCEL) return "cancelled";
        return null;
    }

    private void clearPending() {
        if (pendingTimeout != null) pendingTimeout.cancel();
        pendingTimeout = null;
        pendingCall = null;
        pendingTransaction = null;
        pendingPrepayId = null;
    }

    synchronized void expirePayment(PluginCall call) {
        if (pendingCall != call) return;
        clearPending();
        call.reject("WeChat payment timed out", "WECHAT_PAY_TIMEOUT");
    }

    private synchronized void interruptPayment() {
        PluginCall call = pendingCall;
        clearPending();
        if (call != null) call.reject("WeChat payment interrupted", "WECHAT_PAY_INTERRUPTED");
    }

    private void detachApi() {
        if (api != null) {
            try {
                api.detach();
            } catch (RuntimeException ignored) {
                // The instance is discarded even if the SDK could not clean itself up.
            }
        }
        api = null;
    }

    @Override
    protected synchronized void handleOnDestroy() {
        interruptPayment();
        if (activePlugin.get() == this) activePlugin.clear();
        detachApi();
        super.handleOnDestroy();
    }
}
