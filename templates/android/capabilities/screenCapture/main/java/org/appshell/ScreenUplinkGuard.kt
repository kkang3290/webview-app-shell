package org.appshell

/**
 * Bounds how far the RTMP screen push may fall behind real time.
 *
 * RootEncoder queues encoded frames until its cache is full (400 by default, ~13s of video-only 30fps)
 * and only then drops them. On an uplink slower than the encoder bitrate the picture therefore drifted
 * further and further behind the classroom audio, which travels on the WebView's adaptive WebRTC push.
 * The bitrate adapter lowers the encoder rate first; this guard is the hard limit when the backlog still
 * exceeds about one second: the queued frames are discarded and a keyframe is requested so students
 * resume from a decodable picture instead of watching ever older frames.
 */
class ScreenUplinkGuard(private val fps: Int, private val cooldownMs: Long = 3_000) {
    companion object {
        const val MAX_BITRATE = 3_000_000
        /** Upper bound for the sender cache: two seconds; beyond the guard threshold it only absorbs bursts. */
        fun cacheFrames(fps: Int) = maxOf(30, fps * 2)
    }
    private var flushedAt = Long.MIN_VALUE / 2

    /** Returns true when the caller must clear the sender cache and request a keyframe. */
    fun shouldFlush(itemsInCache: Int, nowMs: Long): Boolean {
        if (itemsInCache < maxOf(1, fps) || nowMs - flushedAt < cooldownMs) return false
        flushedAt = nowMs
        return true
    }
}
