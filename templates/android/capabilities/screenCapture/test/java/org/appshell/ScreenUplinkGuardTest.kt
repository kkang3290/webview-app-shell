package org.appshell

import org.junit.Assert.*
import org.junit.Test

class ScreenUplinkGuardTest {
    @Test fun flushesOnlyOnceTheBacklogReachesOneSecondOfVideo() {
        val guard = ScreenUplinkGuard(30)
        assertFalse(guard.shouldFlush(0, 0))
        assertFalse(guard.shouldFlush(29, 250))
        assertTrue(guard.shouldFlush(30, 500))
    }

    @Test fun cooldownLetsTheRequestedKeyframeDrainBeforeAnotherFlush() {
        val guard = ScreenUplinkGuard(30)
        assertTrue(guard.shouldFlush(45, 1_000))
        assertFalse(guard.shouldFlush(45, 3_999))
        assertTrue(guard.shouldFlush(45, 4_000))
    }

    @Test fun cacheIsBoundedFarBelowTheLibraryDefault() {
        assertEquals(60, ScreenUplinkGuard.cacheFrames(30))
        assertEquals(30, ScreenUplinkGuard.cacheFrames(10))
        assertTrue(ScreenUplinkGuard.cacheFrames(30) < 400)
    }
}
