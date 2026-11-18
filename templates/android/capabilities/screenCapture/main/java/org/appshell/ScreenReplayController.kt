package org.appshell

import android.media.MediaCodec
import android.media.MediaFormat
import android.media.MediaMuxer
import com.pedro.common.AudioCodec
import com.pedro.common.VideoCodec
import com.pedro.library.base.recording.RecordController
import java.io.File
import java.io.FileDescriptor
import java.nio.ByteBuffer

/** Reuses the streaming encoder, writes only video, and cuts exclusively at keyframes. */
class ScreenReplayController(private val archive:ScreenReplayArchive,private val clockOffsetMs:Long,private val onClosed:()->Unit):RecordController {
 private var status=RecordController.Status.STOPPED
 private var listener:RecordController.Listener?=null
 private var request:RecordController.RequestKeyFrame?=null
 private var format:MediaFormat?=null
 private var muxer:MediaMuxer?=null
 private var file:File?=null
 private var track=-1
 private var first=true
 private var failed=false
 private var lastPtsUs=0L
 private var frameStepUs=33333L
 private val clock=ReplaySegmentClock()
 @Synchronized override fun startRecord(path:String,listener:RecordController.Listener?,tracks:RecordController.RecordTracks) {
  check(status==RecordController.Status.STOPPED && tracks==RecordController.RecordTracks.VIDEO)
  this.listener=listener;first=true;failed=false;status=RecordController.Status.STARTED
  listener?.onStatusChange(status);request?.onRequestKeyFrame()
 }
 override fun startRecord(fd:FileDescriptor,listener:RecordController.Listener?,tracks:RecordController.RecordTracks) {throw UnsupportedOperationException("Screen archives require app-private files")}
 @Synchronized override fun recordVideo(videoBuffer:ByteBuffer,videoInfo:MediaCodec.BufferInfo) {
  if(!isRunning() || status==RecordController.Status.PAUSED || videoInfo.size<=0 || videoInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG!=0)return
  try {
   val key=videoInfo.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME!=0
   val pts=videoInfo.presentationTimeUs
   if(muxer==null) {
    if(!key || format==null){request?.onRequestKeyFrame();return}
    if(first){clock.begin(pts,System.currentTimeMillis()+clockOffsetMs);first=false}else clock.roll(pts)
    openSegment()
   } else {
    val duration=clock.durationMs(pts)
    if(clock.shouldRotate(pts,key)) {closeSegment(duration);clock.roll(pts);openSegment()}
    else if(duration>=5000)request?.onRequestKeyFrame()
    check(duration<=10000){"Screen encoder did not provide a keyframe"}
   }
   if(pts>lastPtsUs && lastPtsUs>0)frameStepUs=(pts-lastPtsUs).coerceIn(1000L,100000L)
   lastPtsUs=pts
   val info=MediaCodec.BufferInfo().apply {set(videoInfo.offset,videoInfo.size,clock.relativePtsUs(pts),videoInfo.flags)}
   muxer!!.writeSampleData(track,videoBuffer.duplicate(),info)
   if(status!=RecordController.Status.RECORDING){status=RecordController.Status.RECORDING;listener?.onStatusChange(status)}
  } catch(error:Exception) {
   failed=true;stopRecord();listener?.onError(error)
  }
 }
 private fun openSegment() {
  check(archive.pendingCount()<12){"Screen recording upload queue is full"}
  val next=archive.nextFile();check(!next.exists());file=next
  val writer=MediaMuxer(next.absolutePath,MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
  muxer=writer;track=writer.addTrack(format!!);writer.start()
 }
 private fun closeSegment(duration:Long) {
  val writer=muxer ?: return;val closed=file!!;muxer=null;file=null
  try {writer.stop()}finally{writer.release()}
  archive.append(closed,clock.segmentWallMs,duration.coerceAtLeast(1));onClosed()
 }
 @Synchronized fun finish() {stopRecord()}
 @Synchronized override fun stopRecord() {
  if(status==RecordController.Status.STOPPED)return
  status=RecordController.Status.STOPPED
  var error:Exception?=null
  try {if(muxer!=null)closeSegment(clock.durationMs(lastPtsUs+frameStepUs))}catch(cause:Exception){failed=true;error=cause}
  try {archive.finish(failed)}catch(cause:Exception){failed=true;error=cause}
  onClosed();listener?.onStatusChange(status)
  error?.let {listener?.onError(it)}
 }
 // Do not even inspect these samples: private/public audio stays in the WebView mixer.
 override fun recordAudio(audioBuffer:ByteBuffer,audioInfo:MediaCodec.BufferInfo) {}
 @Synchronized override fun setVideoFormat(videoFormat:MediaFormat) {
  if(muxer!=null) {failed=true;stopRecord();listener?.onError(IllegalStateException("Screen format changed during recording"));return}
  format=videoFormat
 }
 override fun setAudioFormat(audioFormat:MediaFormat) {}
 override fun resetFormats() {format=null}
 override fun isRunning():Boolean=status!=RecordController.Status.STOPPED
 override fun isRecording():Boolean=status==RecordController.Status.RECORDING
 override fun setVideoCodec(videoCodec:VideoCodec) {require(videoCodec==VideoCodec.H264)}
 override fun setAudioCodec(audioCodec:AudioCodec) {}
 override fun pauseRecord() {status=RecordController.Status.PAUSED}
 override fun resumeRecord() {status=RecordController.Status.RECORDING}
 override fun updateInfo(videoCodec:VideoCodec,audioCodec:AudioCodec) {setVideoCodec(videoCodec)}
 override fun getVideoCodec()=VideoCodec.H264
 override fun getAudioCodec()=AudioCodec.AAC
 override fun setRequestKeyFrame(requestKeyFrame:RecordController.RequestKeyFrame?) {request=requestKeyFrame}
 override fun getStatus()=status
}
