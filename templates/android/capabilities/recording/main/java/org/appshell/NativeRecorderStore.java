package org.appshell;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;
import java.util.UUID;

/**
 * NativeRecorder 的落盘部分（纯 Java，便于 JVM 单测）。与 iOS 同一语义：
 * 每段 PCM 先写 chunk-%08d.pcm，再推事件；Web 补拉 readChunks、确认 ack 后才删除。
 * 会话元数据用 Properties 文件——本地 JVM 单测里 org.json 是桩实现。
 */
final class NativeRecorderStore {
    static final String ROOT_DIR = "appshell-recordings";
    static final String META_FILE = "session.properties";
    static final String ARCHIVE_FILE = "recording.m4a";

    private NativeRecorderStore() {}

    static final class Chunk {
        final int seq;
        final byte[] pcm;

        Chunk(int seq, byte[] pcm) {
            this.seq = seq;
            this.pcm = pcm;
        }
    }

    static final class Page {
        final int lastSeq;
        final int sampleRate;
        final List<Chunk> chunks;
        final boolean hasMore;

        Page(int lastSeq, int sampleRate, List<Chunk> chunks, boolean hasMore) {
            this.lastSeq = lastSeq;
            this.sampleRate = sampleRate;
            this.chunks = chunks;
            this.hasMore = hasMore;
        }
    }

    static File root(File filesDir) {
        return new File(filesDir, ROOT_DIR);
    }

    /** 只接受 UUID 形式的会话 ID，挡住 Web 传来的路径穿越。 */
    static File sessionDir(File root, String id) throws IOException {
        try {
            if (!UUID.fromString(id).toString().equalsIgnoreCase(id)) throw new IllegalArgumentException();
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new IOException("invalid sessionId");
        }
        File dir = new File(root, id.toUpperCase(java.util.Locale.ROOT));
        if (!dir.isDirectory()) throw new IOException("unknown session " + id);
        return dir;
    }

    static File createSession(File root) throws IOException {
        File dir = new File(root, UUID.randomUUID().toString().toUpperCase(java.util.Locale.ROOT));
        if (!dir.mkdirs()) throw new IOException("cannot create " + dir);
        return dir;
    }

    static String chunkName(int seq) {
        return String.format(java.util.Locale.ROOT, "chunk-%08d.pcm", seq);
    }

    static void writeChunk(File dir, int seq, byte[] pcm, int length) throws IOException {
        File tmp = new File(dir, chunkName(seq) + ".tmp");
        try (OutputStream out = new FileOutputStream(tmp)) {
            out.write(pcm, 0, length);
        }
        replace(tmp, new File(dir, chunkName(seq)));
    }

    /** 同目录 rename 是原子的（minSdk 24 没有 java.nio.file）。 */
    private static void replace(File tmp, File target) throws IOException {
        if (!tmp.renameTo(target)) throw new IOException("cannot replace " + target);
    }

    static byte[] readAll(File file) throws IOException {
        byte[] data = new byte[(int) file.length()];
        try (InputStream in = new FileInputStream(file)) {
            int offset = 0;
            while (offset < data.length) {
                int read = in.read(data, offset, data.length - offset);
                if (read < 0) throw new IOException("short read " + file);
                offset += read;
            }
        }
        return data;
    }

    static void writeMeta(File dir, Properties meta) throws IOException {
        File tmp = new File(dir, META_FILE + ".tmp");
        try (OutputStream out = new FileOutputStream(tmp)) {
            meta.store(out, null);
        }
        replace(tmp, new File(dir, META_FILE));
    }

    static Properties readMeta(File dir) throws IOException {
        Properties meta = new Properties();
        try (InputStream in = new FileInputStream(new File(dir, META_FILE))) {
            meta.load(in);
        }
        return meta;
    }

    static int intMeta(Properties meta, String key) {
        try {
            return Integer.parseInt(meta.getProperty(key, "0"));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    static Page readChunks(File dir, int afterSeq, int limit) throws IOException {
        Properties meta = readMeta(dir);
        int lastSeq = intMeta(meta, "lastSeq");
        List<Chunk> chunks = new ArrayList<>();
        int seq = afterSeq + 1;
        while (seq <= lastSeq && chunks.size() < limit) {
            File file = new File(dir, chunkName(seq));
            if (file.isFile()) chunks.add(new Chunk(seq, readAll(file)));
            seq++;
        }
        return new Page(lastSeq, intMeta(meta, "sampleRate"), chunks, seq <= lastSeq);
    }

    static int deleteChunks(File dir, int uptoSeq) {
        int removed = 0;
        File[] files = dir.listFiles();
        if (files == null) return 0;
        for (File file : files) {
            String name = file.getName();
            if (!name.startsWith("chunk-") || !name.endsWith(".pcm")) continue;
            try {
                int seq = Integer.parseInt(name.substring(6, name.length() - 4));
                if (seq <= uptoSeq && file.delete()) removed++;
            } catch (NumberFormatException ignored) {
                // 不是我们写的文件，不动
            }
        }
        return removed;
    }

    static List<Properties> list(File root) {
        List<Properties> sessions = new ArrayList<>();
        File[] dirs = root.listFiles(File::isDirectory);
        if (dirs == null) return sessions;
        for (File dir : dirs) {
            try {
                Properties meta = readMeta(dir);
                meta.setProperty("filePath", new File(dir, ARCHIVE_FILE).getAbsolutePath());
                sessions.add(meta);
            } catch (IOException ignored) {
                // 半成品目录（建了还没写元数据）跳过
            }
        }
        return sessions;
    }

    static void deleteRecursively(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    /** 16 位小端 PCM 的峰值电平 0..1（保留三位小数）。 */
    static double level(byte[] pcm, int length) {
        int peak = 0;
        for (int i = 0; i + 1 < length; i += 2) {
            int sample = (short) ((pcm[i] & 0xff) | (pcm[i + 1] << 8));
            peak = Math.max(peak, Math.abs(sample));
        }
        return Math.round(peak / 32768.0 * 1000) / 1000.0;
    }
}
