package org.appshell;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 录音原件落盘：边录边写 Documents/ExampleApp，用户能在系统「文件」里直接找到。
 *
 * 走 MediaStore 而不是 app 私有目录：私有目录用户看不见，那就等于没保存。
 * 也不申请 MANAGE_EXTERNAL_STORAGE——只写自己创建的这一个目录，API 29 起本来就不需要权限；
 * API ≤ 28 走 WRITE_EXTERNAL_STORAGE，没给就落盘失败（不影响录音）。
 *
 * 插的是 {@link MediaStore.Files} 这个不分类型的集合，**不是 Audio 集合**；目录也不是
 * 「录音就该在」的 `Music/`。两件事是同一条约束的两头，推导见 {@link #beginMediaStore}。
 *
 * 上传路径与这条完全独立：这里写失败不影响录音继续、也不影响上传。
 * 桥是 JSON 的，音频按 base64 分块进来，大约每秒一块。
 */
@CapacitorPlugin(name = "RecordingLocalFile")
public class RecordingLocalFilePlugin extends Plugin {

    /**
     * 落点由权限插件的 storageLocation 提供，避免与网页文案漂移。
     * 在这里再拼一次 Environment.DIRECTORY_DOCUMENTS + "ExampleApp"，就是给同一个目录留了
     * 第二个会漂移的真相源。
     */
    static final String RELATIVE_PATH = RecordingKeepAlivePlugin.STORAGE_LOCATION;
    /**
     * 扫孤儿时的 LIKE 前缀。分隔符必须带上：`Documents/ExampleApp%` 会把
     * `Documents/ExampleAppOther/` 这种同前缀的兄弟目录一起圈进来，那是别人的文件。
     */
    static final String ORPHAN_PATH_PREFIX = RELATIVE_PATH + "/%";
    static final String DEFAULT_MIME_TYPE = "audio/webm";
    static final String DEFAULT_BASE_NAME = AppShellConfig.APP_NAME;
    static final int MAX_NAME_LENGTH = FileNames.MAX_NAME_LENGTH;
    /** 超过这个岁数还挂着 IS_PENDING 的，判定为上次异常退出留下的孤儿。 */
    static final long ORPHAN_AGE_SECONDS = 600;
    /** 重名时最多往后试这么多个序号，试不出来就放弃落盘（不影响上传）。 */
    static final int MAX_SEQUENCE = 100;

    private final Map<String, Session> sessions = new HashMap<>();
    private final AtomicLong nextId = new AtomicLong(1);
    // Web awaits each append. Keep file operations ordered without blocking capture/ack calls.
    final ExecutorService fileIo = Executors.newSingleThreadExecutor();

    /**
     * 一次落盘的全部状态。包内可见是为了单测够得着 {@link #write}/{@link #close} 这条
     * 失败记账链——它不碰任何 Android API，纯 JUnit 拿一个会抛的 OutputStream 就能测。
     */
    static final class Session {
        OutputStream stream;
        Uri uri;          // API ≥ 29
        File file;        // API ≤ 28
        String displayName;
        /**
         * 只要有一块没落进去，这个文件就是残的。
         * 记在 session 上而不是就地返回 false 就算了：写失败发生在 append，
         * 而「要不要告诉用户已保存」是 finalizeRecording 才做的决定，中间隔着几百次调用。
         */
        private boolean failed;

        /** 写一块音频。失败只记账不抛：落盘不通不能把录音带下去。 */
        boolean write(byte[] bytes) {
            try {
                stream.write(bytes);
                return true;
            } catch (Exception e) {
                failed = true;
                return false;
            }
        }

        /** 这一块压根没走到 write（比如 base64 解不开），同样是丢数据。 */
        void markFailed() {
            failed = true;
        }

        /**
         * 收尾。最后这次 flush 才是真正落盘的时刻——它抛异常和中途 write 抛异常
         * 是同一件事（文件不完整），所以不能吞。flush 抛了也照样 close，否则流泄漏。
         */
        void close() {
            OutputStream open = stream;
            stream = null;
            if (open == null) return;
            try {
                open.flush();
            } catch (Exception e) {
                failed = true;
            }
            try {
                open.close();
            } catch (Exception e) {
                failed = true;
            }
        }

        /** 从头到尾没失败过的文件才配发布给用户看见。 */
        boolean publishable() {
            return !failed;
        }
    }

    // ─── 纯函数：这几段是单测唯一够得着的部分 ──────────────────────────

    static String sanitizeFilename(String raw, String fallback) {
        return FileNames.sanitize(raw, fallback);
    }

    static String truncateKeepingExtension(String name, int max) {
        return FileNames.truncateKeepingExtension(name, max);
    }

    /** 重名时的序号格式，跟系统下载器一致：`名字 (1).webm`。 */
    static String uniqueName(String base, String ext, int sequence) {
        String suffix = sequence <= 0 ? "" : " (" + sequence + ")";
        return base + suffix + "." + ext;
    }

    static boolean isOrphan(long dateAddedSeconds, long nowSeconds) {
        return nowSeconds - dateAddedSeconds > ORPHAN_AGE_SECONDS;
    }

    static String baseName(String filename) {
        return FileNames.baseName(filename);
    }

    static String extension(String filename, String fallback) {
        int dot = filename.lastIndexOf('.');
        return dot <= 0 || dot == filename.length() - 1 ? fallback : filename.substring(dot + 1);
    }

    /**
     * MediaRecorder 给出来的 mimeType 长这样：`audio/webm;codecs=opus`。
     * 带参数的 MIME 进 MediaStore 会被当成非法类型，insert 直接抛——
     * 那样落盘会静默失效（用户只会发现文件不见了），所以在这里把参数削掉。
     */
    static String normalizeMimeType(String raw, String fallback) {
        if (raw == null) return fallback;
        int semicolon = raw.indexOf(';');
        String cleaned = (semicolon < 0 ? raw : raw.substring(0, semicolon)).trim();
        return cleaned.isEmpty() ? fallback : cleaned;
    }

    /**
     * insert 时到底要不要写 MIME_TYPE。有扩展名就**不写**，交给 MediaProvider 从扩展名反推。
     *
     * 这一条是「文件名不能被改」唯一可靠的保证。MediaProvider.ensureFileColumns() 做两件事：
     * 先把给定 MIME 映射成它认得的扩展名（映射不到就抛 `Unsupported MIME type`），
     * 再检查 DISPLAY_NAME 的扩展名跟这个 MIME 对不对得上——**对不上就往名字后面追加**它
     * 认的那个扩展名。真机上两种翻车都撞过：
     *   - `audio/webm` → 映射不到扩展名 → insert 抛，落盘静默失效（begin 回 id: null）；
     *   - 换成 `audio/x-matroska` 能插进去，但用户的 `会议.webm` 变成 `会议.webm.mka`。
     * 反过来，不给 MIME 时它按扩展名推，推出来的 MIME 与扩展名天然自洽，第二步永远不会改名。
     *
     * 名字没有扩展名时才退回调用方给的 MIME：那时没有「用户选的扩展名」需要保护，
     * 而 MediaProvider 至少需要一个类型才知道该建什么行。这条路对 `audio/webm` 仍然会失败，
     * 跟修复前一样——但 Web 侧一直传 `<名字>.webm`，走不到这里。
     */
    static String mimeForInsert(String displayName, String fallbackMime) {
        return extension(displayName, null) == null ? fallbackMime : null;
    }

    // ─── 插件方法 ────────────────────────────────────────────────────

    @Override
    public void load() {
        // 上次被系统杀掉时留下的半截文件对用户是不可见的。开机第一件事就是把它们放出来，
        // 免得用户「录了但找不到」。放后台线程：插件加载卡住等于应用启动卡住。
        new Thread(this::releaseOrphans).start();
    }

    @PluginMethod
    public void begin(PluginCall call) {
        enqueue(call, () -> beginOnFileThread(call));
    }

    void beginOnFileThread(PluginCall call) {
        String requested = sanitizeFilename(call.getString("filename"), DEFAULT_BASE_NAME);
        String mimeType = normalizeMimeType(call.getString("mimeType"), DEFAULT_MIME_TYPE);
        try {
            Session session = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? beginMediaStore(requested, mimeType)
                    : beginLegacy(requested);
            String id = String.valueOf(nextId.getAndIncrement());
            synchronized (sessions) { sessions.put(id, session); }
            JSObject result = new JSObject();
            result.put("id", id);
            call.resolve(result);
        } catch (Exception e) {
            // 落盘不通不能影响录音：回 null，Web 那边照常上传，只是不显示保存位置。
            call.resolve(nullValued("id"));
        }
    }

    @PluginMethod
    public void append(PluginCall call) {
        enqueue(call, () -> appendOnFileThread(call));
    }

    void appendOnFileThread(PluginCall call) {
        Session session = session(call.getString("id"));
        JSObject result = new JSObject();
        if (session == null) {
            result.put("ok", false);
            call.resolve(result);
            return;
        }
        boolean ok;
        try {
            byte[] bytes = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
            // 锁的说明见 finalizeRecording。
            synchronized (session) { ok = session.write(bytes); }
        } catch (Exception e) {
            // base64 解不开，这一块就此丢了：跟 write 抛异常是同一件事，都得记在 session 上。
            session.markFailed();
            ok = false;
        }
        result.put("ok", ok);
        call.resolve(result);
    }

    @PluginMethod
    public void finalizeRecording(PluginCall call) {
        enqueue(call, () -> finalizeOnFileThread(call));
    }

    void finalizeOnFileThread(PluginCall call) {
        // 名字不能叫 finalize：Capacitor 拿 Java 方法名当 JS 方法名，
        // 而 finalize() 是 java.lang.Object 的方法，这么覆写编译就过不去。
        // TS 包装对外仍叫 finalize()，桥上调的是这个名字。
        Session session = takeSession(call.getString("id"));
        if (session == null) {
            call.resolve(nullValued("path"));
            return;
        }
        // Dedicated fileIo preserves append/finalize/discard order, including the final chunk.
        synchronized (session) { session.close(); }
        if (!session.publishable()) {
            // failed 置位过：磁盘上是个残文件，直接删掉。
            //
            // 光是不翻 IS_PENDING 拦不住它：releaseOrphans() 的规则是「pending 且超过
            // ORPHAN_AGE_SECONDS 岁的一律放出来」，它分不清两种半截文件，下次冷启动
            // 照样把这个残件交给用户，只是不再当场报成功而已。
            //
            // 删除的依据是 failed 置位本身，不是「流处于未知状态」——置位路径不止一条：
            // write/flush/close 抛 IOException（典型是空间不足或介质被拔）时流确实状态不明，
            // 但 append 里 base64 解不开时调的 markFailed() 压根没碰过流，状态完全已知，
            // 只是那一块数据永远补不回来了。两条路的结论是同一个，也就是 Session.failed
            // 上那条既定策略：只要有一块没落进去，这个文件就是残的。残件对用户没有价值，
            // 留着只会让人在 Documents/ExampleApp/ 里翻到一个打不开的文件。
            //
            // 与进程被杀留下的孤儿区别对待：那种字节是好的、只是被截断，而且我们没机会
            // 跑任何清理代码，只能事后放出来；这里我们还活着、有机会处理。删除必须排在
            // close() 之后——流还开着就删，是在删一个自己正握着的句柄。
            //
            // 删不掉也照样回 path: null。调用方要的是「保存没成功」这个结论，不是二次异常。
            // 但别把「最坏也有孤儿回收兜底」当成普遍成立：releaseOrphans() 第一行就是
            // SDK_INT < Q 直接 return，这层兜底只有 API ≥ 29 那条 MediaStore 腿有。
            // legacy（API ≤ 28）没有任何回收机制，File.delete() 返回 false 时
            // （返回值被丢弃，也没有日志）这个残件就永久留在 Documents/ExampleApp/ 里了。
            deleteArtifact(session);
            call.resolve(nullValued("path"));
            return;
        }
        try {
            if (session.uri != null) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContext().getContentResolver().update(session.uri, values, null, null);
            } else if (session.file != null) {
                // API ≤ 28 得手动通知媒体库，否则文件管理器里要等下次全盘扫描才出现。
                MediaScannerConnection.scanFile(
                        getContext(), new String[]{ session.file.getAbsolutePath() }, null, null);
            }
            JSObject result = new JSObject();
            result.put("path", RELATIVE_PATH + "/" + session.displayName);
            call.resolve(result);
        } catch (Exception e) {
            call.resolve(nullValued("path"));
        }
    }

    @PluginMethod
    public void discard(PluginCall call) {
        enqueue(call, () -> discardOnFileThread(call));
    }

    void discardOnFileThread(PluginCall call) {
        Session session = takeSession(call.getString("id"));
        if (session != null) {
            synchronized (session) { session.close(); }
            deleteArtifact(session);
        }
        // 契约是 discard() → {}。PluginCall.resolve() 无参不写 data 字段，
        // 桥那头 resolve 出来的就是 undefined 而不是 {}。
        call.resolve(new JSObject());
    }

    private synchronized void enqueue(PluginCall call, Runnable work) {
        try {
            fileIo.execute(work);
        } catch (RejectedExecutionException error) {
            call.reject("Local recording unavailable");
        }
    }

    @Override
    protected synchronized void handleOnDestroy() {
        if (!fileIo.isShutdown()) {
            // Drain accepted writes before closing; never make the UI wait for storage.
            fileIo.execute(() -> {
                synchronized (sessions) {
                    for (Session session : sessions.values()) session.close();
                    sessions.clear();
                }
            });
            fileIo.shutdown();
        }
        super.handleOnDestroy();
    }

    // ─── 内部 ────────────────────────────────────────────────────────

    /**
     * JSONObject.put(key, null) 是「删掉这个键」，桥上出去就成了 undefined。
     * 契约写的是 `{ id: null }`，所以显式塞 JSON null。
     */
    private static JSObject nullValued(String key) {
        JSObject result = new JSObject();
        result.put(key, JSONObject.NULL);
        return result;
    }

    /**
     * 把这个 session 在磁盘/媒体库里留下的东西抹掉。调用前必须先 close()：
     * 流还开着就删，是在删一个自己正握着的句柄。
     *
     * 两条调用路（用户主动 discard、落盘写失败）处置完全相同，所以只留一份实现——
     * 各写各的话，迟早只有一边跟上后来的改动。删不掉就算了：这是收尾清理，
     * 不能因为它把调用方的结论变成异常。
     */
    private void deleteArtifact(Session session) {
        try {
            if (session.uri != null) getContext().getContentResolver().delete(session.uri, null, null);
            else if (session.file != null) session.file.delete();
        } catch (Exception ignored) { }
    }

    private Session session(String id) {
        if (id == null) return null;
        synchronized (sessions) { return sessions.get(id); }
    }

    private Session takeSession(String id) {
        if (id == null) return null;
        synchronized (sessions) { return sessions.remove(id); }
    }

    /**
     * 集合是 {@link MediaStore.Files}，目录是 `Documents/`——两个都不是直觉选项，但组合是被
     * MediaProvider 逼出来的唯一解。真机（API 36）上把四种组合都撞过一遍：
     *
     * <pre>
     * Audio + Music/ + audio/webm      → Unsupported MIME type audio/webm
     * Audio + Music/ + video/webm      → MIME 与集合不符（Audio 只收音频）
     * Audio + Music/ + audio/x-matroska→ 能插，但用户的「会议.webm」变成「会议.webm.mka」
     * Files + Music/ + (任意)          → Primary directory Music not allowed;
     *                                    allowed directories are [Download, Documents]
     * </pre>
     *
     * 根子在 `.webm` 于 Android 的 MIME 表里只有 `video/webm` 一个身份——WebM 是容器，
     * 装音频还是视频它不看。所以「录音就该进 Music/」这条路在系统层面是不通的：
     * `Music/` 只属于 Audio 集合，Audio 集合只收音频 MIME。
     *
     * Files 是不分类型的并集视图，任何 MIME 都收，但只放行 `Download/` 与 `Documents/`
     * 两个一级目录。取 `Documents/` 的理由见
     * {@link RecordingKeepAlivePlugin#STORAGE_LOCATION}。
     *
     * 代价是 WebM 录音在系统里归到「文件/文档」而不是「音乐」。这是 Android 的分类，
     * 不是我们能选的——用户要的是能在文件管理器里找到原件，这条满足。
     */
    private Session beginMediaStore(String requested, String mimeType) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        Uri collection = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        ContentValues values = new ContentValues();
        // API ≥ 29 的 MediaStore 自己就会给重名加 " (1)"，这里不用手动试序号。
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, requested);
        // 有扩展名就不写 MIME，理由见 mimeForInsert()：写了会被改名。
        String insertMime = mimeForInsert(requested, mimeType);
        if (insertMime != null) values.put(MediaStore.MediaColumns.MIME_TYPE, insertMime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, RELATIVE_PATH);
        // 写完才置 0：中途别让用户在文件管理器里点开一个半截文件。
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);

        Uri uri = resolver.insert(collection, values);
        if (uri == null) throw new IOException("MediaStore insert failed");
        OutputStream stream = resolver.openOutputStream(uri);
        if (stream == null) {
            // 插进去了但打不开：留着就是个永远 pending 的空条目，直接删。
            try { resolver.delete(uri, null, null); } catch (Exception ignored) { }
            throw new IOException("MediaStore stream unavailable");
        }

        Session session = new Session();
        session.uri = uri;
        session.stream = stream;
        session.displayName = displayNameOf(uri, requested);
        return session;
    }

    private String displayNameOf(Uri uri, String fallback) {
        String[] projection = { MediaStore.MediaColumns.DISPLAY_NAME };
        try (Cursor cursor = getContext().getContentResolver().query(uri, projection, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception ignored) { }
        return fallback;
    }

    private Session beginLegacy(String requested) throws IOException {
        // API ≤ 28 没有 MediaStore 的 RELATIVE_PATH，只能自己在外部存储里拼同一条相对路径。
        File dir = new File(Environment.getExternalStorageDirectory(), RELATIVE_PATH);
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("mkdirs failed");

        String base = baseName(requested);
        String ext = extension(requested, "webm");
        File target = null;
        for (int i = 0; i < MAX_SEQUENCE; i++) {
            File candidate = new File(dir, uniqueName(base, ext, i));
            if (!candidate.exists()) { target = candidate; break; }
        }
        if (target == null) throw new IOException("no free filename");

        Session session = new Session();
        session.file = target;
        session.stream = new FileOutputStream(target);
        session.displayName = target.getName();
        return session;
    }

    /** 把上次异常退出留下的 IS_PENDING=1 条目放出来。只动本应用自己插入的行。 */
    private void releaseOrphans() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        try {
            ContentResolver resolver = getContext().getContentResolver();
            // 跟 beginMediaStore 同一个集合。Files 是并集视图，历史上落进 Audio 的行
            // （如果有的话）也在里面，换过来不会漏掉旧孤儿。
            Uri collection = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            String[] projection = { MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DATE_ADDED };
            String selection = MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ? AND "
                    + MediaStore.MediaColumns.IS_PENDING + " = 1";
            String[] args = { ORPHAN_PATH_PREFIX };
            long now = System.currentTimeMillis() / 1000L;

            // 查询本身就带 IS_PENDING=1，配合 MediaStore 的 own-package 可见性规则，
            // 扫到的只会是本应用插入的行。
            try (Cursor cursor = resolver.query(collection, projection, selection, args, null)) {
                while (cursor != null && cursor.moveToNext()) {
                    long id = cursor.getLong(0);
                    if (!isOrphan(cursor.getLong(1), now)) continue;
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    resolver.update(ContentUris.withAppendedId(collection, id), values, null, null);
                }
            }
        } catch (Exception ignored) {
            // 扫不动就算了。这只是个收尾优化，失败不该影响启动。
        }
    }
}
