package org.appshell

import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.*

internal fun replayIso(ms:Long):String=SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",Locale.ROOT).apply {timeZone=TimeZone.getTimeZone("UTC")}.format(Date(ms))
internal fun replayTime(value:String):Long=SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",Locale.ROOT).apply {timeZone=TimeZone.getTimeZone("UTC");isLenient=false}.parse(value)!!.time

data class ReplayClip(val seq:Int,val startedAt:String,val durationMs:Long,val file:String)
fun interface ReplayTransport {
 fun send(credentials:ScreenCredentials,clip:ReplayClip?,file:File?,finished:Int?,failed:Boolean)
}

/** App-private, excluded from backup; a sealed clip is durable before any network request. */
class ScreenReplayArchive(val directory:File,credentials:ScreenCredentials?=null) {
 private val journalFile=File(directory,"journal.json")
 init {
  synchronized(lock) {
   if(credentials==null)check(journalFile.isFile) else directory.mkdirs()
   if(!journalFile.exists() && credentials!=null) {
    check(credentials.valid() && credentials.replay!=null)
    save(JSONObject().put("credentials",credentials.json()).put("clips",JSONArray()).put("complete",false).put("failed",false))
   }
  }
 }
 fun nextFile():File=synchronized(lock){val journal=read();File(directory,"${journal.getJSONArray("clips").length()}.mp4")}
 fun pendingCount():Int=synchronized(lock){val parts=read().getJSONArray("clips");(0 until parts.length()).count {File(directory,parts.getJSONObject(it).getString("file")).exists()}}
 fun append(file:File,startedAt:Long,durationMs:Long) = synchronized(lock) {
  val journal=read();check(!journal.getBoolean("complete"));require(durationMs in 1..10000 && file.length() in 32..8*1024*1024)
  val clips=journal.getJSONArray("clips")
  check(file.name=="${clips.length()}.mp4")
  clips.put(JSONObject().put("seq",clips.length()).put("startedAt",replayIso(startedAt)).put("durationMs",durationMs).put("file",file.name))
  save(journal)
 }
 fun finish(failed:Boolean)=synchronized(lock){val journal=read();journal.put("complete",true).put("failed",journal.getBoolean("failed")||failed);save(journal)}
 fun drain(transport:ReplayTransport) {
  val initial=synchronized(lock){read()}
  val credentials=ScreenCredentials.fromJson(initial.getJSONObject("credentials"));check(credentials.valid())
  val clips=initial.getJSONArray("clips")
  for(i in 0 until clips.length()) {
   val json=clips.getJSONObject(i);val filename=json.getString("file");check(filename=="$i.mp4")
   val file=File(directory,filename);if(!file.exists())continue
   val clip=ReplayClip(i,json.getString("startedAt"),json.getLong("durationMs"),filename)
   transport.send(credentials,clip,file,null,false)
   check(file.delete())
  }
  val finish=synchronized(lock) {
   val current=read();val parts=current.getJSONArray("clips")
   if(current.getBoolean("complete") && (0 until parts.length()).none {File(directory,parts.getJSONObject(it).getString("file")).exists()}) Pair(parts.length(),current.getBoolean("failed")) else null
  }
  if(finish!=null) {
   transport.send(credentials,null,null,finish.first,finish.second)
   synchronized(lock) {
    File(directory.parentFile,"${credentials.publisherId}.done").writeText("done")
    check(directory.deleteRecursively())
   }
  }
 }
 private fun read():JSONObject=JSONObject(journalFile.readText())
 private fun save(journal:JSONObject) {
  val temporary=File(directory,"journal.next")
  FileOutputStream(temporary).use {it.write(journal.toString().toByteArray());it.fd.sync()}
  check(temporary.renameTo(journalFile))
 }
 companion object {private val lock=Any()}
}

/** HTTPS with no redirects and a screen-only lease header, never a login token. */
object ScreenReplayHttp:ReplayTransport {
 override fun send(credentials:ScreenCredentials,clip:ReplayClip?,file:File?,finished:Int?,failed:Boolean) {
  check(credentials.valid());val replay=credentials.replay ?: error("No replay lease")
  val query=linkedMapOf("publisherId" to credentials.publisherId,"seq" to (clip?.seq?:finished?:error("No sequence")).toString())
  if(clip!=null){query["startedAt"]=clip.startedAt;query["durationMs"]=clip.durationMs.toString()}
  if(finished!=null){query["finish"]="1";query["failed"]=if(failed)"1" else "0"}
  val url=URI(replay.uploadUrl+"?"+query.entries.joinToString("&"){URLEncoder.encode(it.key,"UTF-8")+"="+URLEncoder.encode(it.value,"UTF-8")}).toURL()
  val connection=url.openConnection() as HttpURLConnection
  try {
   connection.requestMethod="POST";connection.instanceFollowRedirects=false;connection.connectTimeout=5000;connection.readTimeout=20000;connection.doOutput=true
   connection.setRequestProperty("Content-Type","video/mp4");connection.setRequestProperty("X-Screen-Lease",credentials.leaseToken)
   connection.setFixedLengthStreamingMode(file?.length()?:0)
   connection.outputStream.use {out->if(file!=null)file.inputStream().use {it.copyTo(out)}}
   check(connection.responseCode in 200..299){"Screen archive upload failed"}
   val body=connection.inputStream.bufferedReader().use { reader ->
    val buffer=CharArray(4097);var length=0
    while(length<buffer.size){val count=reader.read(buffer,length,buffer.size-length);if(count<0)break;length+=count}
    check(length<=4096){"Invalid screen upload acknowledgement"};String(buffer,0,length)
   }
   checkReplayReceipt(body,clip?.seq,file?.length())
  } finally {connection.disconnect()}
 }
}

object ScreenReplayUploads {
 private val scope=CoroutineScope(SupervisorJob()+Dispatchers.IO)
 private val requestLock=Any()
 private var running=false
 private var again=false
 fun recover(root:File) {
  synchronized(requestLock){if(running){again=true;return};running=true}
  scope.launch {
   try {
    root.listFiles()?.filter{it.isDirectory && it.name.matches(SCREEN_ID)}?.forEach {directory->
     repeat(3) {attempt->
      if(!directory.isDirectory || !File(directory,"journal.json").isFile)return@forEach
      try {ScreenReplayArchive(directory).drain(ScreenReplayHttp);return@forEach}
      catch(_:Exception){if(attempt<2)delay((attempt+1)*500L)}
     }
    }
   } finally {
    val repeat=synchronized(requestLock){running=false;val value=again;again=false;value}
    if(repeat)recover(root)
   }
  }
 }
 fun cancelUnstarted(root:File,credentials:ScreenCredentials) {
  if(credentials.replay==null || File(root,"${credentials.publisherId}.done").exists())return
  val directory=File(root,credentials.publisherId)
  if(!directory.exists())ScreenReplayArchive(directory,credentials).finish(false)
  recover(root)
 }
}

internal fun checkReplayReceipt(body:String,seq:Int?,bytes:Long?) {
 require(body.length<=4096 && (seq==null)==(bytes==null))
 val result=JSONObject(body)
 if(seq!=null){
  val acknowledgedSeq=result.get("seq");val acknowledgedBytes=result.get("bytes")
  check(acknowledgedSeq is Number && acknowledgedSeq.toDouble()==seq.toDouble() && acknowledgedBytes is Number && acknowledgedBytes.toDouble()==bytes?.toDouble()){"Screen upload acknowledgement mismatch"}
 } else check(result.get("finished")==true){"Screen recording manifest was not acknowledged"}
}
