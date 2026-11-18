package org.appshell

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.activity.result.ActivityResult
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

/**
 * 屏幕共享（能力组 screenCapture，iOS / 桌面同名）。整屏经 MediaProjection 采集，H.264 推 RTMPS，
 * 前台服务持有采集与租约：网页进后台、锁屏不断；租约续不上就自己停。可选本地分段存档并在之后补传（回放）。
 * 只采画面不采声音；每次 start 系统都会弹授权。协议见 docs/screen-capture.md。
 */
@CapacitorPlugin(name = "ScreenCapture")
class ScreenCapturePlugin : Plugin() {
    private data class Pending(val credentials: ScreenCredentials, val generation: Int)
    private val main = Handler(Looper.getMainLooper())
    private var pending: Pending? = null
    private var generation = 0
    private val replayRoot by lazy { File(context.noBackupFilesDir, "appshell-screen-replay") }

    override fun load() {
        current = this
        ScreenReplayUploads.recover(replayRoot)
    }

    override fun handleOnResume() {
        super.handleOnResume()
        ScreenReplayUploads.recover(replayRoot)
    }

    override fun handleOnDestroy() {
        if (current === this) current = null
    }

    @PluginMethod
    fun capabilities(call: PluginCall) {
        call.resolve(JSObject().put("platform", "android").put("screens", true).put("windows", false)
            .put("stream", JSArray().put("rtmps")).put("replay", true))
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val credentials = runCatching { ScreenCredentials.fromStart(call.data) }.getOrNull()
        if (credentials == null || !credentials.valid()) { call.reject("屏幕共享参数无效或地址不在 screenCapture.allowedHosts 里", "INVALID"); return }
        if (pending != null || ScreenCaptureService.instance != null) { call.reject("已有进行中的屏幕共享，先 stop", "BUSY"); return }
        credentials.replay?.let { it.clockOffsetMs = replayTime(it.serverNow) - System.currentTimeMillis() }
        pending = Pending(credentials, ++generation)
        ScreenCaptureService.state = "requesting"
        val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(call, manager.createScreenCaptureIntent(), "onScreenCaptureResult")
    }

    @ActivityCallback
    private fun onScreenCaptureResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val request = pending.also { pending = null }
        if (request == null || request.generation != generation) { call.resolve(stateResult()); return }
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            ScreenReplayUploads.cancelUnstarted(replayRoot, request.credentials)
            ScreenCaptureService.state = "denied"; call.reject("用户取消了屏幕共享", "DENIED"); return
        }
        ScreenCaptureService.request = ScreenCaptureService.Start(request.credentials, result.resultCode, data)
        val started = runCatching { ContextCompat.startForegroundService(context, Intent(context, ScreenCaptureService::class.java)) }
        if (started.isFailure) {
            ScreenReplayUploads.cancelUnstarted(replayRoot, request.credentials); ScreenCaptureService.request = null
            ScreenCaptureService.state = "failed"; call.reject("无法启动屏幕共享服务", "FAILED"); return
        }
        // 等推流真正连上（或失败）再回复；45 秒内没连上视为失败并停掉服务。
        val deadline = SystemClock.elapsedRealtime() + 45_000
        val poll = object : Runnable {
            override fun run() {
                val stale = request.generation != generation
                val state = ScreenCaptureService.state
                when {
                    !stale && state == "sharing" -> call.resolve(stateResult())
                    stale || state != "requesting" || SystemClock.elapsedRealtime() >= deadline -> {
                        context.stopService(Intent(context, ScreenCaptureService::class.java))
                        call.reject("屏幕共享连接失败或授权已过期，请重新开始", "FAILED")
                    }
                    else -> main.postDelayed(this, 100)
                }
            }
        }
        main.post(poll)
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        pending?.let { ScreenReplayUploads.cancelUnstarted(replayRoot, it.credentials) }
        generation++; pending = null; ScreenCaptureService.request = null
        ScreenCaptureService.instance?.finish("stopped")
        ScreenCaptureService.state = "stopped"
        call.resolve(stateResult())
    }

    @PluginMethod
    fun state(call: PluginCall) {
        ScreenReplayUploads.recover(replayRoot)
        call.resolve(stateResult())
    }

    /** 共享中额外给出本次的 publisherId 与 renewUrl（不含令牌），页面重载后据此认回进行中的共享。 */
    private fun stateResult() = JSObject().apply {
        put("state", ScreenCaptureService.state)
        ScreenCaptureService.instance?.credentials?.takeIf { ScreenCaptureService.state == "sharing" }?.let {
            put("publisherId", it.publisherId)
            put("renewUrl", it.renewUrl)
        }
    }

    companion object {
        @Volatile private var current: ScreenCapturePlugin? = null

        /** 状态变化推给页面：requesting / sharing / stopped / failed / denied。 */
        fun stateChanged(state: String) {
            val plugin = current ?: return
            plugin.main.post { plugin.notifyListeners("state", JSObject().put("state", state)) }
        }
    }
}
