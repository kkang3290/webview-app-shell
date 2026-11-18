package org.appshell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import com.getcapacitor.PluginCall;
import com.tencent.mm.opensdk.constants.Build;
import com.tencent.mm.opensdk.modelbase.BaseResp;
import com.tencent.mm.opensdk.openapi.IWXAPI;
import java.lang.reflect.Field;
import java.lang.reflect.Proxy;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class WechatPayPluginTest {
    private static class PayCall extends PluginCall {
        final Map<String, String> parameters = new HashMap<>();
        String errorCode;
        String errorMessage;

        PayCall() {
            super(null, "WechatPay", "test", "pay", null);
            parameters.put("appid", "wx0000000000000000");
            parameters.put("partnerid", "1234567890");
            parameters.put("prepayid", "test-prepay-id");
            parameters.put("package", "Sign=WXPay");
            parameters.put("noncestr", "test-nonce");
            parameters.put("timestamp", "1791500000");
            parameters.put("sign", "test-signature");
        }

        @Override
        public String getString(String name) {
            return parameters.get(name);
        }

        @Override
        public void reject(String message, String code) {
            errorMessage = message;
            errorCode = code;
        }
    }

    private static class TestPlugin extends WechatPayPlugin {
        boolean sendResult = true;
        boolean throwOnSend;
        String sentTransaction;
        PluginCall sentCall;

        @Override
        boolean sendPayment(PluginCall call, String transaction) {
            // OpenSDK's Android bytecode cannot be verified by JDK 21. Replace only its send boundary.
            sentCall = call;
            sentTransaction = transaction;
            if (throwOnSend) throw new IllegalStateException("SDK diagnostic details");
            return sendResult;
        }
    }

    private static Object field(WechatPayPlugin plugin, String name) throws Exception {
        Field field = WechatPayPlugin.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(plugin);
    }

    private static void field(WechatPayPlugin plugin, String name, Object value) throws Exception {
        Field field = WechatPayPlugin.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(plugin, value);
    }

    private static TestPlugin plugin(boolean installed, int supportedVersion) throws Exception {
        TestPlugin plugin = new TestPlugin();
        IWXAPI api = (IWXAPI) Proxy.newProxyInstance(IWXAPI.class.getClassLoader(),
            new Class<?>[] { IWXAPI.class }, (proxy, method, arguments) -> {
                switch (method.getName()) {
                    case "isWXAppInstalled": return installed;
                    case "getWXAppSupportAPI": return supportedVersion;
                    default: return null;
                }
            });
        field(plugin, "api", api);
        field(plugin, "appId", "wx0000000000000000");
        return plugin;
    }

    private static TestPlugin ready() throws Exception {
        return plugin(true, Build.PAY_SUPPORTED_SDK_INT);
    }

    @Test
    public void signedParametersRemainUnmodifiedAndInvalidInputIsRejected() {
        PayCall valid = new PayCall();
        Map<String, String> original = new HashMap<>(valid.parameters);
        assertTrue(WechatPayPlugin.validPaymentParameters(valid));
        assertEquals(original, valid.parameters);
        for (String key : valid.parameters.keySet()) {
            PayCall missing = new PayCall();
            missing.parameters.remove(key);
            assertFalse(key, WechatPayPlugin.validPaymentParameters(missing));
            PayCall whitespace = new PayCall();
            whitespace.parameters.put(key, " value ");
            assertFalse(key, WechatPayPlugin.validPaymentParameters(whitespace));
        }
        for (String timestamp : new String[] { "0", "1791500000000", "NaN", "179150000x" }) {
            PayCall invalid = new PayCall();
            invalid.parameters.put("timestamp", timestamp);
            assertFalse(WechatPayPlugin.validPaymentParameters(invalid));
        }
        valid.parameters.put("noncestr", "x".repeat(33));
        assertFalse(WechatPayPlugin.validPaymentParameters(valid));
        valid.parameters.put("noncestr", "bad\u0000nonce");
        assertFalse(WechatPayPlugin.validPaymentParameters(valid));
    }

    @Test
    public void invalidParametersAndDifferentAppIdNeverReachWeChat() throws Exception {
        TestPlugin plugin = ready();
        PayCall invalid = new PayCall();
        invalid.parameters.put("package", "prepay_id=wrong");
        plugin.pay(invalid);
        assertEquals("WECHAT_PAY_INVALID_PARAMS", invalid.errorCode);
        PayCall mismatch = new PayCall();
        mismatch.parameters.put("appid", "wx-different-app");
        plugin.pay(mismatch);
        assertEquals("WECHAT_PAY_APP_ID_MISMATCH", mismatch.errorCode);
        assertNull(plugin.sentCall);
        assertNull(field(plugin, "pendingCall"));
    }

    @Test
    public void missingWeChatAndUnsupportedVersionAreDistinctErrors() throws Exception {
        PayCall missing = new PayCall();
        plugin(false, Build.PAY_SUPPORTED_SDK_INT).pay(missing);
        assertEquals("WECHAT_NOT_INSTALLED", missing.errorCode);
        PayCall unsupported = new PayCall();
        plugin(true, Build.PAY_SUPPORTED_SDK_INT - 1).pay(unsupported);
        assertEquals("WECHAT_PAY_UNAVAILABLE", unsupported.errorCode);
        WechatPayPlugin unavailable = ready();
        field(unavailable, "api", null);
        PayCall uninitialized = new PayCall();
        unavailable.pay(uninitialized);
        assertEquals("WECHAT_PAY_UNAVAILABLE", uninitialized.errorCode);
    }

    @Test
    public void sendFailureAndSdkExceptionReleaseTheAttempt() throws Exception {
        for (boolean throwOnSend : new boolean[] { false, true }) {
            TestPlugin plugin = ready();
            plugin.sendResult = false;
            plugin.throwOnSend = throwOnSend;
            PayCall call = new PayCall();
            plugin.pay(call);
            assertEquals("WECHAT_PAY_FAILED", call.errorCode);
            assertEquals("Unable to start WeChat payment", call.errorMessage);
            assertNull(field(plugin, "pendingCall"));
            assertNull(field(plugin, "pendingTimeout"));
        }
    }

    @Test
    public void concurrentPayCannotReplaceThePendingAttempt() throws Exception {
        TestPlugin plugin = ready();
        try {
            PayCall first = new PayCall();
            plugin.pay(first);
            String transaction = plugin.sentTransaction;
            assertNotNull(transaction);
            PayCall second = new PayCall();
            plugin.pay(second);
            assertEquals("WECHAT_PAY_BUSY", second.errorCode);
            assertSame(first, field(plugin, "pendingCall"));
            assertSame(first, plugin.sentCall);
            assertEquals(transaction, plugin.sentTransaction);
        } finally {
            plugin.handleOnDestroy();
        }
    }

    @Test
    public void timeoutAndLateResponseCannotConsumeRetryOfTheSameOrder() throws Exception {
        TestPlugin plugin = ready();
        try {
            PayCall first = new PayCall();
            plugin.pay(first);
            String oldTransaction = plugin.sentTransaction;
            plugin.expirePayment(first);
            assertEquals("WECHAT_PAY_TIMEOUT", first.errorCode);
            assertNull(field(plugin, "pendingCall"));
            PayCall second = new PayCall();
            plugin.pay(second);
            assertNotEquals(oldTransaction, plugin.sentTransaction);
            plugin.expirePayment(first);
            for (int code : new int[] { BaseResp.ErrCode.ERR_OK, BaseResp.ErrCode.ERR_USER_CANCEL, BaseResp.ErrCode.ERR_COMM }) {
                plugin.finishPayment(code, oldTransaction, oldTransaction, "test-prepay-id");
            }
            assertSame(second, field(plugin, "pendingCall"));
            assertNull(second.errorCode);
        } finally {
            plugin.handleOnDestroy();
        }
    }

    @Test
    public void unidentifiedOrConflictingResponseCannotSettlePayment() throws Exception {
        TestPlugin plugin = ready();
        try {
            PayCall call = new PayCall();
            plugin.pay(call);
            String transaction = plugin.sentTransaction;
            plugin.finishPayment(BaseResp.ErrCode.ERR_COMM, null, null, "test-prepay-id");
            plugin.finishPayment(BaseResp.ErrCode.ERR_COMM, transaction, "older-attempt", "test-prepay-id");
            plugin.finishPayment(BaseResp.ErrCode.ERR_COMM, transaction, transaction, "other-order");
            assertSame(call, field(plugin, "pendingCall"));
            assertNull(call.errorCode);
        } finally {
            plugin.handleOnDestroy();
        }
    }

    @Test
    public void matchedSdkFailureReleasesTheAttemptWithoutExposingItsError() throws Exception {
        TestPlugin plugin = ready();
        PayCall call = new PayCall();
        plugin.pay(call);
        // extData is sufficient when the SDK omits transaction.
        plugin.finishPayment(BaseResp.ErrCode.ERR_AUTH_DENIED, null, plugin.sentTransaction, "test-prepay-id");
        assertEquals("WECHAT_PAY_FAILED", call.errorCode);
        assertEquals("WeChat payment failed", call.errorMessage);
        assertNull(field(plugin, "pendingCall"));
        assertNull(field(plugin, "pendingTimeout"));
    }

    @Test
    public void successAndCancellationRemainDifferentFromFailure() {
        assertEquals("success", WechatPayPlugin.paymentStatus(BaseResp.ErrCode.ERR_OK));
        assertEquals("cancelled", WechatPayPlugin.paymentStatus(BaseResp.ErrCode.ERR_USER_CANCEL));
        assertNull(WechatPayPlugin.paymentStatus(BaseResp.ErrCode.ERR_COMM));
        assertNull(WechatPayPlugin.paymentStatus(BaseResp.ErrCode.ERR_AUTH_DENIED));
    }

    @Test
    public void destroyingPluginInterruptsAndCleansUpThePendingCall() throws Exception {
        WechatPayPlugin plugin = ready();
        PayCall call = new PayCall();
        plugin.pay(call);
        plugin.handleOnDestroy();
        assertEquals("WECHAT_PAY_INTERRUPTED", call.errorCode);
        assertNull(field(plugin, "pendingCall"));
        assertNull(field(plugin, "pendingTimeout"));
        assertNull(field(plugin, "api"));
    }
}
