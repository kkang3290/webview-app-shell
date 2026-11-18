package org.appshell

/** Uses elapsed realtime; changing the system clock cannot extend a screen lease. */
class ScreenRecovery(deadline: Long) {
    enum class Action { WAIT, RENEW, RECONNECT, STOP }
    enum class Status { CONNECTING, CONNECTED, DISCONNECTED, STOPPED }
    var deadline = deadline
        private set
    var status = Status.CONNECTING
        private set
    val connected: Boolean @Synchronized get() = status == Status.CONNECTED
    private var retryAt = 0L
    private var failures = 0
    private fun transition(event: String) {
        val target = ScreenLeasePolicy.transitions[status.name.lowercase()]?.get(event) ?: return
        status = Status.valueOf(target.uppercase())
    }
    private fun active(now: Long): Boolean {
        if (now >= deadline) transition("stop")
        return status != Status.STOPPED
    }
    @Synchronized fun next(now: Long): Action {
        if (!active(now)) return Action.STOP
        if (now < retryAt) return Action.WAIT
        return if (connected) Action.RENEW else Action.RECONNECT
    }
    @Synchronized fun renewed(until: Long, now: Long) {
        if (!active(now) || until <= now) { transition("stop"); return }
        deadline = minOf(until, now + ScreenLeasePolicy.LEASE_MS)
    }
    @Synchronized fun succeeded(now: Long) {
        if (!active(now)) return
        transition("connected"); failures = 0; retryAt = now + ScreenLeasePolicy.RENEW_MS
    }
    @Synchronized fun disconnected(now: Long) {
        if (!active(now)) return
        transition("disconnected"); retryAt = now
    }
    @Synchronized fun failed(permanent: Boolean, now: Long) {
        if (!active(now)) return
        if (permanent) { transition("stop"); return }
        retryAt = now + ScreenLeasePolicy.RETRY_MS[minOf(failures, ScreenLeasePolicy.RETRY_MS.lastIndex)]
        failures = minOf(failures + 1, 3)
    }
}

class ScreenLeaseFailure(val status: Int) : Exception("Screen lease request failed") {
    companion object { fun permanent(status: Int) = ScreenLeasePolicy.permanent(status) }
}

// 屏幕租约协议 v1 的时间与重试策略（见 docs/screen-capture.md）。iOS 广播扩展里有同一份（ScreenLease.swift），
// 两处必须一致；业务后端按同样的租约长度签发 expiresAt。
private object ScreenLeasePolicy {
    const val LEASE_MS = 60000L
    const val RENEW_MS = 20000L
    val RETRY_MS = longArrayOf(1000L, 2000L, 4000L, 5000L)
    fun permanent(status: Int) = status in 400..499 && status !in listOf(408, 425, 429)
    val transitions = mapOf(
        "connecting" to mapOf("connected" to "connected", "disconnected" to "disconnected", "stop" to "stopped"),
        "connected" to mapOf("connected" to "connected", "disconnected" to "disconnected", "stop" to "stopped"),
        "disconnected" to mapOf("connected" to "connected", "disconnected" to "disconnected", "stop" to "stopped"),
        "stopped" to mapOf("connected" to "stopped", "disconnected" to "stopped", "stop" to "stopped")
    )
}
