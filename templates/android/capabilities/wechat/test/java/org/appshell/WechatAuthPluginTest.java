package org.appshell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;

import com.getcapacitor.PluginCall;
import com.tencent.mm.opensdk.modelbase.BaseResp;
import java.lang.reflect.Field;
import java.util.Timer;
import java.util.TimerTask;
import org.junit.Test;

public class WechatAuthPluginTest {
    private static class AuthCall extends PluginCall {
        String errorCode;
        String errorMessage;

        AuthCall() {
            super(null, "WechatAuth", "test", "authorize", null);
        }

        @Override
        public void reject(String message, String code) {
            errorMessage = message;
            errorCode = code;
        }

        @Override
        public void reject(String message) {
            errorMessage = message;
        }
    }

    private static class TestPlugin extends WechatAuthPlugin {
        PluginCall cancelledCall;

        @Override
        void resolveCancelled(PluginCall call) {
            cancelledCall = call;
        }
    }

    private static class ReturnTimer extends Timer {
        TimerTask task;
        long delay;

        ReturnTimer() { super(true); }

        @Override
        public void schedule(TimerTask task, long delay) {
            this.task = task;
            this.delay = delay;
        }
    }

    private static void pending(WechatAuthPlugin plugin, AuthCall call, String state) throws Exception {
        Field callField = WechatAuthPlugin.class.getDeclaredField("pendingCall");
        callField.setAccessible(true);
        callField.set(plugin, call);
        Field stateField = WechatAuthPlugin.class.getDeclaredField("pendingState");
        stateField.setAccessible(true);
        stateField.set(plugin, state);
    }

    private static Object pendingCall(WechatAuthPlugin plugin) throws Exception {
        Field field = WechatAuthPlugin.class.getDeclaredField("pendingCall");
        field.setAccessible(true);
        return field.get(plugin);
    }

    @Test
    public void timeoutReleasesThePendingCallAndAllowsANewAttempt() throws Exception {
        WechatAuthPlugin plugin = new WechatAuthPlugin();
        AuthCall first = new AuthCall();
        pending(plugin, first, "first");
        plugin.expireAuthorization(first);
        assertEquals("WECHAT_AUTH_TIMEOUT", first.errorCode);
        assertNull(pendingCall(plugin));

        AuthCall second = new AuthCall();
        pending(plugin, second, "second");
        plugin.expireAuthorization(first);
        assertSame(second, pendingCall(plugin));
        assertNull(second.errorCode);
    }

    @Test
    public void lateResponseCannotConsumeTheNewAttempt() throws Exception {
        WechatAuthPlugin plugin = new WechatAuthPlugin();
        AuthCall call = new AuthCall();
        pending(plugin, call, "new-state");
        plugin.finishAuthorization(BaseResp.ErrCode.ERR_OK, "old-code", "old-state");
        assertSame(call, pendingCall(plugin));
        assertNull(call.errorMessage);
    }

    @Test
    public void failedResponseWithoutStateReleasesThePendingCall() throws Exception {
        WechatAuthPlugin plugin = new WechatAuthPlugin();
        AuthCall call = new AuthCall();
        pending(plugin, call, "state");
        plugin.finishAuthorization(BaseResp.ErrCode.ERR_AUTH_DENIED, null, null);
        assertEquals("WeChat authorization failed", call.errorMessage);
        assertNull(pendingCall(plugin));
    }

    @Test
    public void successWithoutStateIsRejected() throws Exception {
        WechatAuthPlugin plugin = new WechatAuthPlugin();
        AuthCall call = new AuthCall();
        pending(plugin, call, "state");
        plugin.finishAuthorization(BaseResp.ErrCode.ERR_OK, "code", null);
        assertEquals("Invalid WeChat authorization state", call.errorMessage);
        assertNull(pendingCall(plugin));
    }

    @Test
    public void destroyingPluginReleasesThePendingCall() throws Exception {
        WechatAuthPlugin plugin = new WechatAuthPlugin();
        AuthCall call = new AuthCall();
        pending(plugin, call, "state");
        plugin.handleOnDestroy();
        assertEquals("WECHAT_AUTH_INTERRUPTED", call.errorCode);
        assertNull(pendingCall(plugin));
    }

    @Test
    public void returningWithoutCallbackCancelsAndAllowsFreshAttempt() throws Exception {
        TestPlugin plugin = new TestPlugin();
        AuthCall first = new AuthCall();
        pending(plugin, first, "first");
        ReturnTimer timer = new ReturnTimer();
        Field timeout = WechatAuthPlugin.class.getDeclaredField("pendingTimeout");
        timeout.setAccessible(true);
        timeout.set(plugin, timer);
        plugin.handleOnPause();
        plugin.handleOnResume();
        assertEquals(500L, timer.delay);
        timer.task.run();
        assertSame(first, plugin.cancelledCall);
        assertNull(pendingCall(plugin));
        assertNull(timeout.get(plugin));

        AuthCall second = new AuthCall();
        pending(plugin, second, "second");
        timer.task.run();
        plugin.finishAuthorization(BaseResp.ErrCode.ERR_USER_CANCEL, null, "first");
        assertSame(second, pendingCall(plugin));
        assertNull(second.errorMessage);
    }

    @Test
    public void callbackBeforeReturnCleanupWins() throws Exception {
        TestPlugin plugin = new TestPlugin();
        AuthCall call = new AuthCall();
        pending(plugin, call, "state");
        plugin.finishAuthorization(BaseResp.ErrCode.ERR_AUTH_DENIED, null, "state");
        plugin.cancelReturnedAuthorization(call);
        assertEquals("WeChat authorization failed", call.errorMessage);
        assertNull(plugin.cancelledCall);
    }

    @Test
    public void pausingAgainDoesNotCancelWhileWechatIsStillOpen() throws Exception {
        TestPlugin plugin = new TestPlugin();
        AuthCall call = new AuthCall();
        pending(plugin, call, "state");
        plugin.handleOnPause();
        plugin.cancelReturnedAuthorization(call);
        assertSame(call, pendingCall(plugin));
        assertNull(plugin.cancelledCall);
    }

}
