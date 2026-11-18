package org.appshell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;
import com.getcapacitor.PluginCall;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public class RecordingLocalFilePluginTest {

    @Test
    public void slowStorageLeavesTheBridgeFreeAndDestroyDrainsAcceptedWrites() throws Exception {
        List<String> operations = Collections.synchronizedList(new ArrayList<>());
        CountDownLatch writing = new CountDownLatch(1);
        CountDownLatch releaseWrite = new CountDownLatch(1);
        RecordingLocalFilePlugin.Session session = new RecordingLocalFilePlugin.Session();
        session.stream = new OutputStream() {
            @Override public void write(int value) throws IOException {
                writing.countDown();
                try {
                    if (!releaseWrite.await(5, TimeUnit.SECONDS)) throw new IOException("blocked storage");
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IOException(error);
                }
                operations.add("write");
            }
            @Override public void flush() { operations.add("flush"); }
            @Override public void close() { operations.add("close"); }
        };
        RecordingLocalFilePlugin plugin = new RecordingLocalFilePlugin() {
            @Override void beginOnFileThread(PluginCall call) { operations.add("begin"); }
            @Override void appendOnFileThread(PluginCall call) { session.write(new byte[] {1}); }
            @Override void finalizeOnFileThread(PluginCall call) { operations.add("finalize"); }
            @Override void discardOnFileThread(PluginCall call) { operations.add("discard"); }
        };
        Field sessions = RecordingLocalFilePlugin.class.getDeclaredField("sessions");
        sessions.setAccessible(true);
        @SuppressWarnings("unchecked")
        Map<String, RecordingLocalFilePlugin.Session> openSessions =
            (Map<String, RecordingLocalFilePlugin.Session>) sessions.get(plugin);
        openSessions.put("test", session);
        ExecutorService bridge = Executors.newSingleThreadExecutor();
        try {
            bridge.submit(() -> {
                plugin.begin(null);
                plugin.append(null);
                plugin.finalizeRecording(null);
                plugin.discard(null);
            }).get(1, TimeUnit.SECONDS);
            assertTrue(writing.await(1, TimeUnit.SECONDS));
            // Acknowledge/start share this Capacitor thread; neither may wait for file I/O.
            assertEquals("ack", bridge.submit(() -> "ack").get(1, TimeUnit.SECONDS));
            bridge.submit(plugin::handleOnDestroy).get(1, TimeUnit.SECONDS);
            assertFalse(plugin.fileIo.isTerminated());
            releaseWrite.countDown();
            assertTrue(plugin.fileIo.awaitTermination(2, TimeUnit.SECONDS));
            assertEquals(List.of("begin", "write", "finalize", "discard", "flush", "close"), operations);
            assertTrue(session.publishable());
            assertTrue(openSessions.isEmpty());
        } finally {
            releaseWrite.countDown();
            plugin.handleOnDestroy();
            bridge.shutdownNow();
            plugin.fileIo.awaitTermination(2, TimeUnit.SECONDS);
        }
    }

    @Test
    public void stripsPathSeparatorsSoWebCannotEscapeTheFolder() {
        assertEquals("abc", RecordingLocalFilePlugin.sanitizeFilename("a/b\\c", "录音"));
        assertEquals("etcpasswd", RecordingLocalFilePlugin.sanitizeFilename("../etc/passwd", "录音"));
    }

    @Test
    public void stripsControlCharacters() {
        assertEquals("ab", RecordingLocalFilePlugin.sanitizeFilename("a\0b\n", "录音"));
    }

    @Test
    public void fallsBackWhenNothingSurvives() {
        assertEquals("录音", RecordingLocalFilePlugin.sanitizeFilename("///", "录音"));
        assertEquals("录音", RecordingLocalFilePlugin.sanitizeFilename(null, "录音"));
    }

    @Test
    public void capsLength() {
        StringBuilder long200 = new StringBuilder();
        for (int i = 0; i < 200; i++) long200.append('x');
        assertEquals(128, RecordingLocalFilePlugin.sanitizeFilename(long200.toString(), "录音").length());
    }

    @Test
    public void firstFileKeepsItsName() {
        assertEquals("会议记录-20260827.webm", RecordingLocalFilePlugin.uniqueName("会议记录-20260827", "webm", 0));
    }

    @Test
    public void duplicatesGetASequenceLikeTheSystemDoes() {
        assertEquals("会议记录-20260827 (1).webm", RecordingLocalFilePlugin.uniqueName("会议记录-20260827", "webm", 1));
        assertEquals("会议记录-20260827 (7).webm", RecordingLocalFilePlugin.uniqueName("会议记录-20260827", "webm", 7));
    }

    @Test
    public void pendingEntriesOlderThanTenMinutesAreOrphans() {
        // 应用被杀掉时 IS_PENDING 还是 1，文件对用户不可见。超过这个岁数就认定没人会来收尾了。
        assertTrue(RecordingLocalFilePlugin.isOrphan(1_000L, 1_000L + 601L));
        assertFalse(RecordingLocalFilePlugin.isOrphan(1_000L, 1_000L + 599L));
        // 时钟回拨不能把刚建的条目判成孤儿。
        assertFalse(RecordingLocalFilePlugin.isOrphan(2_000L, 1_000L));
    }

    @Test
    public void dropsMimeParametersMediaStoreCannotParse() {
        // MediaRecorder 交出来的是 "audio/webm;codecs=opus"，带参数的 MIME 塞进 MediaStore
        // 会被判成非法插入，落盘整条链就静默失效了。
        assertEquals("audio/webm", RecordingLocalFilePlugin.normalizeMimeType("audio/webm;codecs=opus", "audio/webm"));
        assertEquals("audio/mp4", RecordingLocalFilePlugin.normalizeMimeType("  audio/mp4  ", "audio/webm"));
        assertEquals("audio/webm", RecordingLocalFilePlugin.normalizeMimeType(null, "audio/webm"));
        assertEquals("audio/webm", RecordingLocalFilePlugin.normalizeMimeType("   ", "audio/webm"));
    }

    @Test
    public void aNameWithAnExtensionInsertsWithoutAMime() {
        // 真机（API 36）验出来的那个 bug：给 MIME 就会被 MediaProvider 拿去校验/改名。
        // 有扩展名时一律不给，让它自己从扩展名反推——推出来的必然自洽，名字不会被动。
        assertNull(RecordingLocalFilePlugin.mimeForInsert("会议记录.webm", "audio/webm"));
        assertNull(RecordingLocalFilePlugin.mimeForInsert("a.b.webm", "audio/webm"));
    }

    @Test
    public void aNameWithoutAnExtensionStillNeedsTheCallersMime() {
        // 没有扩展名就没有「用户选的后缀」要保护，MediaProvider 也需要一个类型才建得出行。
        assertEquals("audio/webm", RecordingLocalFilePlugin.mimeForInsert("noext", "audio/webm"));
        assertEquals("audio/mp4", RecordingLocalFilePlugin.mimeForInsert("trailing.", "audio/mp4"));
        // `.webm` 整个是名字（隐藏文件），同样没有扩展名可用——跟 extension() 一条判定。
        assertEquals("audio/webm", RecordingLocalFilePlugin.mimeForInsert(".webm", "audio/webm"));
    }

    @Test
    public void recordingsGoIntoTheUntypedFilesCollection() throws IOException {
        // 线上一直是坏的，而且坏得没有声音：Audio 集合收到 audio/webm 会抛
        // `Unsupported MIME type audio/webm`（MediaProvider.ensureFileColumns），
        // begin() 把异常吞掉回 id: null，Web 侧降级成「没保存」——本地留存这个功能
        // 100% 失效，用户只会发现目录里什么都没有。
        //
        // 根因不是扩展名而是 MIME：`.webm` 在 Android 的表里只有 video/webm 一个身份，
        // Audio 集合无论如何都不收。所以只能插不分类型的 Files 集合。
        //
        // 这条只能钉在源码上：选集合是 Android API 调用，本模块没有 Robolectric。
        String code = pluginCode();
        assertTrue("落盘必须插 MediaStore.Files（不分类型的并集视图）",
                code.contains("MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)"));
        assertFalse("Audio 集合收不了 WebM，一个引用都不该再有",
                code.contains("MediaStore.Audio."));
        assertTrue("insert 的 MIME 必须过 mimeForInsert()，不能无条件写死",
                code.contains("mimeForInsert(requested,mimeType)"));
    }

    @Test
    public void writesIntoTheFolderThePermissionPluginAdvertises() {
        // 落点是跨仓库契约：Web 的文案照这个路径写，用户按这个路径去文件管理器里找。
        // 期望值必须硬编码——拿 STORAGE_LOCATION 跟自己比是自证，两边一起改也照样绿。
        assertEquals("Documents/" + AppShellConfig.STORAGE_DIR, RecordingLocalFilePlugin.RELATIVE_PATH);
    }

    @Test
    public void theFolderMustBeOneFilesCollectionAccepts() {
        // 一级目录不是随便挑的：MediaProvider 按集合限制一级目录，Files 集合只放行
        // Download/ 与 Documents/（真机 API 36 原话：`Primary directory Music not allowed
        // for content://media/external_primary/file; allowed directories are
        // [Download, Documents]`）。
        //
        // 所以「录音就该放 Music/」这个直觉改回去会让落盘再次 100% 静默失效——
        // 而 Music/ 那条路要走通就得换回 Audio 集合，Audio 集合又收不了 WebM。
        // 这条断言守的就是这个环：先看住一级目录，别让人只改一半。
        String primary = RecordingLocalFilePlugin.RELATIVE_PATH.split("/")[0];
        assertTrue("一级目录必须是 Files 集合放行的那两个之一，实际是 " + primary,
                primary.equals("Documents") || primary.equals("Download"));
    }

    @Test
    public void orphanScanCannotReachSiblingFolders() {
        // LIKE 的前缀不带分隔符时，'Documents/ExampleApp%' 会把 Documents/ExampleAppOther/
        // 一起圈进来，而那目录里的 pending 条目是别人的，我们没有理由去翻它的 IS_PENDING。
        assertEquals("Documents/" + AppShellConfig.STORAGE_DIR + "/%", RecordingLocalFilePlugin.ORPHAN_PATH_PREFIX);
    }

    // ---- 截断保住扩展名 ----

    @Test
    public void truncationKeepsTheExtension() {
        StringBuilder long200 = new StringBuilder();
        for (int i = 0; i < 200; i++) long200.append('x');
        String sanitized = RecordingLocalFilePlugin.sanitizeFilename(long200.toString() + ".webm", "录音");
        assertEquals(128, sanitized.length());
        // 硬截会把 .webm 整个削掉，MediaStore 那条路径就拿一个没有扩展名的名字当 DISPLAY_NAME，
        // MediaProvider 只好自己按 MIME 猜一个补上——用户看到的文件名不再是他给的那个。
        assertTrue(sanitized, sanitized.endsWith(".webm"));
    }

    @Test
    public void truncationHardCutsWhenThereIsNoExtensionToSave() {
        assertEquals("abcde", RecordingLocalFilePlugin.truncateKeepingExtension("abcdefgh", 5));
        assertEquals("abc.z", RecordingLocalFilePlugin.truncateKeepingExtension("abcdefgh.z", 5));
        // 够短就原样返回。
        assertEquals("ab.z", RecordingLocalFilePlugin.truncateKeepingExtension("ab.z", 8));
        // 「扩展名」比整个预算还长，那它就不是扩展名。
        assertEquals("abcde", RecordingLocalFilePlugin.truncateKeepingExtension("abcde.longext", 5));
    }

    // ---- baseName / extension（API ≤ 28 那条腿靠它们拆文件名） ----

    @Test
    public void baseNameAndExtensionSplitOnTheLastDot() {
        assertEquals("会议记录-20260827", RecordingLocalFilePlugin.baseName("会议记录-20260827.webm"));
        assertEquals("webm", RecordingLocalFilePlugin.extension("会议记录-20260827.webm", "m4a"));
        assertEquals("a.b", RecordingLocalFilePlugin.baseName("a.b.webm"));
        assertEquals("webm", RecordingLocalFilePlugin.extension("a.b.webm", "m4a"));
    }

    @Test
    public void aNameWithoutAUsableDotHasNoExtension() {
        // dot <= 0 那条：`.webm` 整个是名字（隐藏文件），不是「扩展名 webm 的空名字」。
        // 判反了，legacy 分支会去建一个叫 `.webm` 的文件——用户在文件管理器里看不见。
        assertEquals(".webm", RecordingLocalFilePlugin.baseName(".webm"));
        assertEquals("m4a", RecordingLocalFilePlugin.extension(".webm", "m4a"));
        assertEquals("noext", RecordingLocalFilePlugin.baseName("noext"));
        assertEquals("m4a", RecordingLocalFilePlugin.extension("noext", "m4a"));
        // 点落在末尾同样没有扩展名可用。
        assertEquals("trailing", RecordingLocalFilePlugin.baseName("trailing."));
        assertEquals("m4a", RecordingLocalFilePlugin.extension("trailing.", "m4a"));
    }

    // ---- 写失败不能被忘掉：残文件不许发布 ----

    @Test
    public void aCleanSessionIsPublishable() {
        RecordingLocalFilePlugin.Session session = new RecordingLocalFilePlugin.Session();
        ByteArrayOutputStream sink = new ByteArrayOutputStream();
        session.stream = sink;
        assertTrue(session.write(new byte[] { 1, 2, 3 }));
        session.close();
        assertTrue(session.publishable());
        assertEquals(3, sink.toByteArray().length);
    }

    @Test
    public void aChunkThatFailedToWriteMakesTheWholeFileUnpublishable() {
        // append 里写失败只回了 { ok: false }。Web 拿这个 false 没法做什么（录音还在继续），
        // 真正要拦的是收尾那一下：文件已经缺了一块，不能再告诉用户「已保存到 Documents/ExampleApp」。
        RecordingLocalFilePlugin.Session session = new RecordingLocalFilePlugin.Session();
        session.stream = new BrokenStream(true, false, false);
        assertFalse(session.write(new byte[] { 1, 2, 3 }));
        session.close();
        assertFalse(session.publishable());
    }

    @Test
    public void theLastFlushFailingCountsAsAFailedFileToo() {
        // 最后那次 flush 才是真正落盘的时刻：缓冲里的尾巴就在这一下写出去。
        // 吞掉它的异常，等于拿着一个截断文件报成功。
        RecordingLocalFilePlugin.Session session = new RecordingLocalFilePlugin.Session();
        BrokenStream stream = new BrokenStream(false, true, false);
        session.stream = stream;
        assertTrue(session.write(new byte[] { 1 }));
        session.close();
        assertFalse(session.publishable());
        assertTrue("flush 抛了也得把流关掉，否则文件描述符泄漏", stream.closed);
    }

    @Test
    public void closeFailingCountsAsAFailedFileToo() {
        // close 对带缓冲的流同样会 flush，它抛异常是一样的意思。
        RecordingLocalFilePlugin.Session session = new RecordingLocalFilePlugin.Session();
        session.stream = new BrokenStream(false, false, true);
        assertTrue(session.write(new byte[] { 1 }));
        session.close();
        assertFalse(session.publishable());
    }

    @Test
    public void aChunkThatNeverReachedTheStreamCountsTheSame() {
        // append 里 base64 解不开走的是 markFailed()：这一块同样没进文件。
        RecordingLocalFilePlugin.Session session = new RecordingLocalFilePlugin.Session();
        session.stream = new ByteArrayOutputStream();
        session.markFailed();
        session.close();
        assertFalse(session.publishable());
    }

    @Test
    public void finalizeRefusesToPublishAFailedFile() throws IOException {
        // 上面几条测的是 Session 这个状态机本身；这一条钉的是 finalizeRecording 有没有去问它。
        // 必须先被 publishable() 短路，才轮得到翻 IS_PENDING——两句顺序反过来就是复核抓到的
        // 那个 bug：把截断文件发布进媒体库，还回一条 path 告诉用户「已保存」。
        String code = pluginCode();
        int method = code.indexOf("publicvoidfinalizeRecording(");
        assertTrue("找不到 finalizeRecording", method >= 0);
        int guard = code.indexOf("if(!session.publishable())", method);
        assertTrue("finalizeRecording 必须先问一次 publishable()", guard >= 0);
        assertTrue("publishable() 的短路必须排在翻 IS_PENDING 之前",
                guard < code.indexOf("IS_PENDING", method));
    }

    @Test
    public void discardResolvesAnEmptyObjectNotUndefined() throws IOException {
        // 契约第 15 行是 discard({ id }) → {}。PluginCall.resolve() 无参不写 data 字段，
        // 桥那头 resolve 出来的是 undefined。
        // 这条只能钉在源码上：JSObject 继承 org.json.JSONObject（在 android.jar 里），
        // 本模块的单测没有 Robolectric、也没开 returnDefaultValues，
        // 一个 new JSObject() 在这里就会抛 "Method not mocked"，跑不到断言。
        String code = pluginCode();
        assertFalse("插件里不能有裸的 call.resolve()：桥上出去是 undefined 而不是 {}",
                code.contains("call.resolve();"));
        assertTrue("discard 必须 resolve 一个空 JSObject",
                code.contains("call.resolve(newJSObject());"));
    }

    /** 插件源码去掉注释和空白：被钉的那些片段在注释里也会出现，不剥干净就是钉了个寂寞。 */
    private static String pluginCode() throws IOException {
        return pluginSource()
                .replaceAll("(?s)/\\*.*?\\*/", "")
                .replaceAll("(?m)//[^\n]*", "")
                .replaceAll("\\s+", "");
    }

    /** 读插件源码本身。Gradle 单测的工作目录是模块目录，往上找几层足够覆盖各种跑法。 */
    private static String pluginSource() throws IOException {
        String relative = "src/main/java/org/appshell/RecordingLocalFilePlugin.java";
        File dir = new File(System.getProperty("user.dir")).getAbsoluteFile();
        for (int depth = 0; dir != null && depth < 6; depth++, dir = dir.getParentFile()) {
            for (String candidate : new String[] { relative, "app/" + relative, "android/app/" + relative }) {
                File file = new File(dir, candidate);
                if (file.isFile()) {
                    return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
                }
            }
        }
        throw new FileNotFoundException(
                "找不到 RecordingLocalFilePlugin.java，起点 " + System.getProperty("user.dir"));
    }

    /** 按要求在 write / flush / close 上抛的流：磁盘写满、SD 卡拔了都是这个形状。 */
    private static final class BrokenStream extends OutputStream {
        private final boolean failWrite;
        private final boolean failFlush;
        private final boolean failClose;
        boolean closed;

        BrokenStream(boolean failWrite, boolean failFlush, boolean failClose) {
            this.failWrite = failWrite;
            this.failFlush = failFlush;
            this.failClose = failClose;
        }

        @Override
        public void write(int b) throws IOException {
            if (failWrite) throw new IOException("ENOSPC");
        }

        @Override
        public void write(byte[] b) throws IOException {
            if (failWrite) throw new IOException("ENOSPC");
        }

        @Override
        public void flush() throws IOException {
            if (failFlush) throw new IOException("flush failed");
        }

        @Override
        public void close() throws IOException {
            closed = true;
            if (failClose) throw new IOException("close failed");
        }
    }
}
