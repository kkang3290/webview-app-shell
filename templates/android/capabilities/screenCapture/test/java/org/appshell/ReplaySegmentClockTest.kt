package org.appshell
import org.junit.Assert.*
import org.junit.Test
class ReplaySegmentClockTest {
 @Test fun waitsForKeyframesAndKeepsOneWallClockAcrossSegments() {
  val clock = ReplaySegmentClock()
  clock.begin(2_000_000L, 1_700_000L)
  assertFalse(clock.shouldRotate(8_000_000L, false))
  assertTrue(clock.shouldRotate(8_000_000L, true))
  assertEquals(6000L, clock.durationMs(8_000_000L))
  clock.roll(8_000_000L)
  assertEquals(1_706_000L, clock.segmentWallMs)
  assertEquals(1000L, clock.durationMs(9_000_000L))
 }
 @Test fun rejectsBackwardsTimestampsInsteadOfProducingAnInvalidArchive() {
  val clock=ReplaySegmentClock();clock.begin(2_000_000L,1_700_000L)
  try {clock.durationMs(1_000_000L);fail("backwards timestamp accepted")}catch (_:IllegalArgumentException) {}
 }
}
