package org.appshell

/** Encoder timestamps, rather than callback arrival time, keep every segment on one clock. */
class ReplaySegmentClock {
 private var originPtsUs=0L
 private var originWallMs=0L
 private var segmentPtsUs=0L
 var segmentWallMs:Long=0; private set
 fun begin(ptsUs:Long,wallMs:Long) {
  require(ptsUs>=0);originPtsUs=ptsUs;originWallMs=wallMs;roll(ptsUs)
 }
 fun shouldRotate(ptsUs:Long,keyframe:Boolean):Boolean=keyframe && durationMs(ptsUs)>=5000L
 fun durationMs(ptsUs:Long):Long { require(ptsUs>=segmentPtsUs);return (ptsUs-segmentPtsUs)/1000L }
 fun relativePtsUs(ptsUs:Long):Long {require(ptsUs>=segmentPtsUs);return ptsUs-segmentPtsUs}
 fun roll(ptsUs:Long) {
  require(ptsUs>=originPtsUs);segmentPtsUs=ptsUs;segmentWallMs=originWallMs+(ptsUs-originPtsUs)/1000L
 }
}
