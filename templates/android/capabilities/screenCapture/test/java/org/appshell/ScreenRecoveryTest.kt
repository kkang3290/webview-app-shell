package org.appshell

import org.junit.Assert.*
import org.junit.Test

class ScreenRecoveryTest {
    @Test fun transientFailureKeepsCaptureUntilLeaseDeadline() {
        val recovery = ScreenRecovery(60_000)
        assertEquals(ScreenRecovery.Action.RECONNECT, recovery.next(0))
        recovery.failed(false, 0)
        assertEquals(ScreenRecovery.Action.WAIT, recovery.next(0))
        assertEquals(ScreenRecovery.Action.RECONNECT, recovery.next(1000))
        recovery.succeeded(1000)
        assertEquals(ScreenRecovery.Action.WAIT, recovery.next(20_000))
        assertEquals(ScreenRecovery.Action.RENEW, recovery.next(21_000))
        recovery.failed(false, 21_000)
        assertTrue(recovery.connected)
        assertEquals(ScreenRecovery.Action.RENEW, recovery.next(22_000))
        recovery.disconnected(23_000)
        assertEquals(ScreenRecovery.Action.RECONNECT, recovery.next(23_000))
        assertEquals(ScreenRecovery.Action.STOP, recovery.next(60_000))
        recovery.renewed(120_000, 60_000)
        assertEquals(ScreenRecovery.Action.STOP, recovery.next(60_000))
    }
    @Test fun terminalAndExpiredCallbacksCannotMarkTransportConnected() {
        val revoked = ScreenRecovery(60_000)
        revoked.failed(true, 0)
        revoked.succeeded(1)
        assertFalse(revoked.connected)
        assertEquals(ScreenRecovery.Action.STOP, revoked.next(1))
        val expired = ScreenRecovery(60_000)
        expired.succeeded(60_000)
        assertFalse(expired.connected)
        assertEquals(ScreenRecovery.Action.STOP, expired.next(60_000))
    }
    @Test fun revokedLeaseNeverRetries() {
        val recovery = ScreenRecovery(60_000)
        recovery.failed(true, 0)
        assertEquals(ScreenRecovery.Action.STOP, recovery.next(0))
        assertTrue(ScreenLeaseFailure.permanent(403))
        assertTrue(ScreenLeaseFailure.permanent(409))
        assertFalse(ScreenLeaseFailure.permanent(503))
    }
}
