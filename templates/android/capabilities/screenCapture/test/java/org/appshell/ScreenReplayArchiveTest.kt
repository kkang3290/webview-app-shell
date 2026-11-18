package org.appshell
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.io.File
class ScreenReplayArchiveTest {
 private fun credentials()=ScreenCredentials().apply {
  url="rtmps://push.example.com/live/screen"
  renewUrl="https://api.example.com/live/l1/screen/lease"
  publisherId="pub_test";leaseToken="a".repeat(43);expiresAt="2026-10-27T10:00:00.000Z"
  replay=ScreenReplayCredentials().apply {uploadUrl="https://api.example.com/live/l1/screen/recording";serverNow="2026-10-27T09:00:00.000Z"}
 }
 private val hosts=arrayOf("example.com")
 @org.junit.Before fun allowTestHosts() {ScreenCredentials.allowedHosts=hosts}
 @Test fun rejectsHostsOutsideTheAllowListAndCredentialLeaks() {
  val c=credentials();assertTrue(c.valid(hosts))
  assertFalse("allow list ignored",c.valid(arrayOf("other.com")))
  for(bad in listOf("https://evil.example/upload","https://push.example.com/l1/recording","https://api.example.com/l1/recording?secret=leak","https://api.example.com:8443/l1/recording")) {
   c.replay!!.uploadUrl=bad;assertFalse("unsafe replay URL accepted: $bad",c.valid(hosts))
  }
  val push=credentials()
  for(bad in listOf("rtmp://push.example.com/live","rtmps://push.example.com.evil.io/live","rtmps://user:pass@push.example.com/live")) {
   push.url=bad;assertFalse("unsafe push URL accepted: $bad",push.valid(hosts))
  }
  val ids=credentials();ids.publisherId="../x";assertFalse(ids.valid(hosts))
 }
 @Test fun failedUploadsRemainDurableAndRetryBeforeFinishingTheManifest() {
  val root=Files.createTempDirectory("screen-queue-test").toFile()
  try {
   val c=credentials();val archive=ScreenReplayArchive(File(root,c.publisherId),c)
   val clip=archive.nextFile();clip.writeBytes(ByteArray(64){7});archive.append(clip,1700000L,1000L);archive.finish(false)
   try {archive.drain(ReplayTransport{_,_,_,_,_->throw java.io.IOException("offline")});fail("upload failure hidden")}catch(_:java.io.IOException){}
   assertTrue(clip.exists());assertEquals(1,archive.pendingCount())
   val observed=mutableListOf<String>()
   ScreenReplayArchive(File(root,c.publisherId)).drain(ReplayTransport { lease,part,file,count,failed->
    assertEquals(c.leaseToken,lease.leaseToken);assertFalse(failed)
    if(part!=null){assertEquals(0,part.seq);assertEquals(1000L,part.durationMs);assertArrayEquals(ByteArray(64){7},file!!.readBytes());observed.add("video")}
    else {assertEquals(1,count);observed.add("finished")}
   })
   assertEquals(listOf("video","finished"),observed);assertFalse(clip.exists())
  } finally {root.deleteRecursively()}
 }
 @Test fun cancelledAuthorizationFinishesZeroClipsAndCannotOverwriteAnAcknowledgedArchive() {
  val root=Files.createTempDirectory("screen-cancel-test").toFile()
  try {
   val c=credentials();val archive=ScreenReplayArchive(File(root,c.publisherId),c);archive.finish(false)
   archive.drain(ReplayTransport{_,part,_,count,failed->assertNull(part);assertEquals(0,count);assertFalse(failed)})
   assertTrue(File(root,"${c.publisherId}.done").exists())
   ScreenReplayUploads.cancelUnstarted(root,c)
   assertFalse(File(root,c.publisherId).exists())
  } finally {root.deleteRecursively()}
 }
 @Test fun recordingFailureCannotBeClearedByALaterNormalStop() {
  val root=Files.createTempDirectory("screen-failed-test").toFile()
  try {
   val c=credentials();val archive=ScreenReplayArchive(File(root,c.publisherId),c)
   archive.finish(true);archive.finish(false)
   archive.drain(ReplayTransport{_,_,_,count,failed->assertEquals(0,count);assertTrue(failed)})
  } finally {root.deleteRecursively()}
 }

 @Test fun receiptMustMatchTheUploadedClipBeforeDeletingTheLocalCopy() {
  checkReplayReceipt("{\"seq\":2,\"bytes\":64}",2,64)
  checkReplayReceipt("{\"finished\":true}",null,null)
  for(body in listOf("<html>ok</html>","{}","{\"seq\":2.1,\"bytes\":64}","{\"seq\":\"2\",\"bytes\":64}","{\"seq\":1,\"bytes\":64}","{\"seq\":2,\"bytes\":63}")) {
   try{checkReplayReceipt(body,2,64);fail("invalid upload acknowledgement accepted")}catch(_:Exception){}
  }
 }

}
