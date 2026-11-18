package org.appshell

import android.app.*
import android.content.Intent
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.*
import androidx.core.app.NotificationCompat
import com.pedro.common.ConnectChecker
import com.pedro.library.base.recording.RecordController
import com.pedro.library.util.BitrateAdapter
import java.io.File
import com.pedro.encoder.input.sources.video.ScreenSource
import kotlinx.coroutines.*
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.*

/** 持有采集与短租约：网页进后台也不断。只采画面，不采声音。 */
class ScreenCaptureService : Service(), ConnectChecker {
    data class Start(val credentials: ScreenCredentials, val resultCode: Int, val data: Intent)
    companion object {
        @Volatile var request: Start? = null
        @Volatile var instance: ScreenCaptureService? = null
        @Volatile var state = "stopped"
            set(value) { val changed = field != value; field = value; if (changed) ScreenCapturePlugin.stateChanged(value) }
        const val CHANNEL = "appshell-screen-capture"
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var recorder: ScreenReplayController? = null
    private val replayRoot by lazy {File(noBackupFilesDir,"screen-replay")}
    private var stream: ScreenRtmpStream? = null
    /** Lowers the encoder bitrate to what the uplink actually delivers; see [ScreenUplinkGuard] for the hard bound. */
    private var bitrateAdapter: BitrateAdapter? = null
    private val uplink = ScreenUplinkGuard(30)
    private var projection: MediaProjection? = null
    internal var credentials: ScreenCredentials? = null
        private set
    private lateinit var recovery: ScreenRecovery
    private var connecting = false
    private var connectDeadline = 0L
    private var stopped = false
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val start = request.also { request = null }
        if (start == null || instance != null) { if (instance == null) stopSelf(); return START_NOT_STICKY }
        instance = this; credentials = start.credentials
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.screen_capture_notification_channel), NotificationManager.IMPORTANCE_LOW))
        val stop = PendingIntent.getService(this, 0, Intent(this, StopScreenCaptureService::class.java), PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.presence_video_online).setContentTitle(getString(R.string.screen_capture_notification_title))
            .setContentText(getString(R.string.screen_capture_notification_text)).setOngoing(true)
            .addAction(0, getString(R.string.screen_capture_stop), stop).build()
        // Android 14+ 要求在 getMediaProjection 之前进入 mediaProjection 类型的前台服务。
        if (Build.VERSION.SDK_INT >= 29) startForeground(7124, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        else startForeground(7124, notification)
        recovery = ScreenRecovery(SystemClock.elapsedRealtime() + maxOf(0, minOf(60_000, expiry(start.credentials.expiresAt) - System.currentTimeMillis())))
        scope.launch {
            while (!stopped) {
                if (recovery.next(SystemClock.elapsedRealtime()) == ScreenRecovery.Action.STOP) { finish("failed"); break }
                delay(1000)
            }
        }
        scope.launch {
            try {
                while (!stopped) {
                    try { renew(true); break }
                    catch (error: Exception) {
                        recovery.failed(error is ScreenLeaseFailure && ScreenLeaseFailure.permanent(error.status), SystemClock.elapsedRealtime())
                        while (!stopped && recovery.next(SystemClock.elapsedRealtime()) == ScreenRecovery.Action.WAIT) delay(250)
                        if (recovery.next(SystemClock.elapsedRealtime()) == ScreenRecovery.Action.STOP) { finish("failed"); return@launch }
                    }
                }
                if (stopped) return@launch
                val display = resources.displayMetrics
                val scale = minOf(1.0, 1920.0 / maxOf(display.widthPixels, display.heightPixels), 1080.0 / minOf(display.widthPixels, display.heightPixels))
                val width = (display.widthPixels * scale / 2).toInt() * 2
                val height = (display.heightPixels * scale / 2).toInt() * 2
                val next = ScreenRtmpStream(applicationContext, this@ScreenCaptureService)
                stream = next
                start.credentials.replay?.let { replay ->
                    val archive=ScreenReplayArchive(File(replayRoot,start.credentials.publisherId),start.credentials)
                    val recording=ScreenReplayController(archive,replay.clockOffsetMs) {ScreenReplayUploads.recover(replayRoot)}
                    recorder=recording;next.setRecordController(recording)
                }
                next.getStreamClient().setLogs(false); next.getStreamClient().setOnlyVideo(true)
                next.getStreamClient().setReTries(3)
                next.getStreamClient().resizeCache(ScreenUplinkGuard.cacheFrames(30))
                next.getGlInterface().setForceRender(true, 15)
                check(next.prepareVideo(width, height, ScreenUplinkGuard.MAX_BITRATE, fps = 30) && next.prepareAudio(32000, false, 32000))
                bitrateAdapter = BitrateAdapter { bitrate -> mainHandler.post { if (!stopped && stream === next) next.setVideoBitrateOnFly(bitrate) } }
                    .apply { setMaxBitrate(ScreenUplinkGuard.MAX_BITRATE) }
                val projectionManager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                val capture = projectionManager.getMediaProjection(start.resultCode, start.data) ?: error("Screen permission revoked")
                projection = capture
                next.changeVideoSource(ScreenSource(applicationContext, capture, object : MediaProjection.Callback() {
                    override fun onStop() { mainHandler.post { finish("stopped") } }
                }))
                connecting = true; connectDeadline = SystemClock.elapsedRealtime() + 10_000
                next.startStream(start.credentials.url)
                if(recorder!=null)next.startRecord(File(replayRoot,start.credentials.publisherId).absolutePath,RecordController.RecordTracks.VIDEO,object:RecordController.Listener {
                    override fun onStatusChange(status:RecordController.Status) {}
                    override fun onError(e:Exception?) {mainHandler.post {finish("failed")}}
                })
                while (!stopped) {
                    val now = SystemClock.elapsedRealtime()
                    if (!connecting && uplink.shouldFlush(next.getStreamClient().getItemsInCache(), now)) {
                        // Older frames are worthless in a live class: drop them and restart from a keyframe.
                        next.getStreamClient().clearCache(); next.requestKeyframe()
                    }
                    val action = recovery.next(now)
                    if (action == ScreenRecovery.Action.STOP) { finish("failed"); break }
                    if (connecting) {
                        if (now >= connectDeadline) {
                            connecting = false; recovery.disconnected(now); recovery.failed(false, now)
                        }
                        delay(250); continue
                    }
                    if (action == ScreenRecovery.Action.WAIT) { delay(250); continue }
                    try {
                        renew(action == ScreenRecovery.Action.RECONNECT)
                        if (stopped) break
                        if (recovery.next(SystemClock.elapsedRealtime()) == ScreenRecovery.Action.STOP) { finish("failed"); break }
                        if (action == ScreenRecovery.Action.RECONNECT) {
                            connecting = true; state = "requesting"; connectDeadline = SystemClock.elapsedRealtime() + 10_000
                            next.reconnect(start.credentials.url)
                        } else if (recovery.connected) recovery.succeeded(SystemClock.elapsedRealtime())
                    } catch (error: Exception) {
                        if (stopped) break
                        connecting = false
                        recovery.failed(error is ScreenLeaseFailure && ScreenLeaseFailure.permanent(error.status), SystemClock.elapsedRealtime())
                    }
                }
            } catch (_: Exception) { finish("failed") }
        }
        return START_NOT_STICKY
    }

    private fun expiry(value: String): Long = runCatching {
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(value)!!.time
    }.getOrDefault(0L)

    private suspend fun renew(refreshPush: Boolean) {
        val current = credentials ?: error("No lease")
        val response = leaseRequest(current, "renew", refreshPush)
        if (stopped) return
        val url = if (refreshPush) response.getString("url") else response.optString("url", current.url)
        val old = current.url; current.url = url
        if (!current.valid()) { current.url = old; error("Invalid lease") }
        val remaining = expiry(response.getString("expiresAt")) - System.currentTimeMillis()
        check(remaining in 1..65_000)
        recovery.renewed(SystemClock.elapsedRealtime() + minOf(remaining, 60_000), SystemClock.elapsedRealtime())
    }
    private suspend fun leaseRequest(current: ScreenCredentials, action: String, refreshPush: Boolean = true): JSONObject = withContext(Dispatchers.IO) {
        val connection = URL(current.renewUrl).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"; connection.instanceFollowRedirects = false
            connection.connectTimeout = 5000; connection.readTimeout = 5000; connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(JSONObject().put("publisherId", current.publisherId).put("leaseToken", current.leaseToken).put("action", action).put("refreshPush", refreshPush).toString().toByteArray()) }
            if (connection.responseCode !in 200..299) throw ScreenLeaseFailure(connection.responseCode)
            JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
        } finally { connection.disconnect() }
    }
    fun finish(nextState: String) {
        if (stopped) return
        stopped = true; state = nextState
        recorder?.finish(); recorder=null
        stream?.release(); stream = null; projection?.stop(); projection = null
        val lease = credentials; credentials = null
        if(lease!=null)ScreenReplayUploads.cancelUnstarted(replayRoot,lease)
        scope.cancel()
        if (lease != null) CoroutineScope(Dispatchers.IO).launch { runCatching { leaseRequest(lease, "stop") } }
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }
    override fun onDestroy() { finish("stopped"); if (instance === this) instance = null; super.onDestroy() }
    override fun onConnectionStarted(url: String) {}
    override fun onConnectionSuccess() { mainHandler.post {
        if (!stopped) {
            connecting = false; recovery.succeeded(SystemClock.elapsedRealtime())
            if (!recovery.connected) { finish("failed"); return@post }
            state = "sharing"
        }
    } }
    override fun onConnectionFailed(reason: String) { mainHandler.post {
        if (stopped) return@post
        connecting = false; state = "requesting"
        val now = SystemClock.elapsedRealtime()
        recovery.disconnected(now); recovery.failed(false, now)
    } }
    override fun onDisconnect() { mainHandler.post {
        if (!stopped) {
            connecting = false; state = "requesting"
            val now = SystemClock.elapsedRealtime()
            recovery.disconnected(now); recovery.failed(false, now)
        }
    } }
    override fun onAuthError() { mainHandler.post { finish("failed") } }
    override fun onAuthSuccess() {}
    override fun onNewBitrate(bitrate: Long) { mainHandler.post {
        val current = stream ?: return@post
        if (!stopped) bitrateAdapter?.adaptBitrate(bitrate, current.getStreamClient().hasCongestion())
    } }
}

class StopScreenCaptureService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ScreenCaptureService.instance?.finish("stopped"); stopSelf(); return START_NOT_STICKY
    }
}
