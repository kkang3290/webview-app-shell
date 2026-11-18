package org.appshell

import android.content.Context
import android.media.MediaCodec
import com.pedro.common.AudioCodec
import com.pedro.common.ConnectChecker
import com.pedro.common.VideoCodec
import com.pedro.encoder.input.sources.audio.NoAudioSource
import com.pedro.encoder.input.sources.video.NoVideoSource
import com.pedro.library.base.StreamBase
import com.pedro.library.util.streamclient.RtmpStreamClient
import com.pedro.library.util.streamclient.StreamClientListener
import com.pedro.rtmp.rtmp.RtmpClient
import java.nio.ByteBuffer

/** A transport reconnect must never recreate Android's single-use MediaProjection display. */
class ScreenRtmpStream(context: Context, checker: ConnectChecker) : StreamBase(context, NoVideoSource(), NoAudioSource()) {
    private val rtmp = RtmpClient(checker)
    private val client = RtmpStreamClient(rtmp, object : StreamClientListener {
        override fun onRequestKeyframe() { requestKeyframe() }
    })
    override fun getStreamClient() = client
    override fun startStreamImp(endPoint: String) {
        val size = getVideoResolution()
        rtmp.setVideoResolution(size.width, size.height)
        rtmp.setFps(getVideoFps())
        rtmp.connect(endPoint)
    }
    fun reconnect(endPoint: String) {
        client.setReTries(3)
        if (!client.reTry(0, "connection failed", endPoint)) rtmp.connect(endPoint)
    }
    override fun stopStreamImp() { rtmp.disconnect() }
    override fun setVideoCodecImp(codec: VideoCodec) { rtmp.setVideoCodec(codec) }
    override fun setAudioCodecImp(codec: AudioCodec) { rtmp.setAudioCodec(codec) }
    override fun onAudioInfoImp(sampleRate: Int, isStereo: Boolean) { rtmp.setAudioInfo(sampleRate, isStereo) }
    override fun onVideoInfoImp(sps: ByteBuffer, pps: ByteBuffer?, vps: ByteBuffer?) { rtmp.setVideoInfo(sps, pps, vps) }
    override fun getVideoDataImp(videoBuffer: ByteBuffer, info: MediaCodec.BufferInfo) { rtmp.sendVideo(videoBuffer, info) }
    override fun getAudioDataImp(audioBuffer: ByteBuffer, info: MediaCodec.BufferInfo) { rtmp.sendAudio(audioBuffer, info) }
}
