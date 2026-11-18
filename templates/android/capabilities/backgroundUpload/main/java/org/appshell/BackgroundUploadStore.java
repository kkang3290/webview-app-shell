package org.appshell;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.TreeMap;
import java.util.regex.Pattern;

/**
 * 后台上传的任务记录（纯 Java，便于 JVM 单测）。每个任务一个 Properties 文件，
 * Worker、插件、App 重启后都从这里读同一份状态。请求头以 header.<名> 存放。
 */
final class BackgroundUploadStore {
    static final String ROOT_DIR = "appshell-uploads";
    static final Pattern ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    static final List<String> STATES = java.util.Arrays.asList("queued", "running", "succeeded", "failed", "cancelled");

    private BackgroundUploadStore() {}

    static File root(File filesDir) {
        File root = new File(filesDir, ROOT_DIR);
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
        return root;
    }

    static void checkId(String id) {
        if (id == null || !ID.matcher(id).matches()) throw new IllegalArgumentException("id must match " + ID.pattern());
    }

    static File recordFile(File root, String id) {
        checkId(id);
        return new File(root, id + ".properties");
    }

    static File stagedFile(File root, String id) {
        checkId(id);
        return new File(root, id + ".bin");
    }

    /**
     * 只允许上传 App 自己目录里的文件：网页不能借上传把系统或其他应用的文件带出去。
     * allowedRoots 传 App 数据目录与 App 专属外部目录。
     */
    static File resolveSource(String path, List<File> allowedRoots) throws IOException {
        if (path == null || path.isEmpty()) throw new IOException("file.path is required");
        File file = new File(path).getCanonicalFile();
        for (File root : allowedRoots) {
            if (root == null) continue;
            String prefix = root.getCanonicalPath() + File.separator;
            if (file.getPath().startsWith(prefix)) {
                if (!file.isFile()) throw new IOException("file not found: " + path);
                return file;
            }
        }
        throw new IOException("file must be inside the app's own storage");
    }

    static void save(File root, Properties record) throws IOException {
        String id = record.getProperty("id");
        File target = recordFile(root, id);
        File tmp = new File(root, id + ".properties.tmp");
        try (OutputStream out = new FileOutputStream(tmp)) {
            record.store(out, null);
        }
        if (!tmp.renameTo(target)) throw new IOException("cannot write " + target);
    }

    static Properties load(File root, String id) throws IOException {
        File file = recordFile(root, id);
        if (!file.isFile()) throw new IOException("unknown upload " + id);
        Properties record = new Properties();
        try (InputStream in = new FileInputStream(file)) {
            record.load(in);
        }
        return record;
    }

    static List<Properties> list(File root) {
        List<Properties> records = new ArrayList<>();
        File[] files = root.listFiles((dir, name) -> name.endsWith(".properties"));
        if (files == null) return records;
        for (File file : files) {
            try {
                records.add(load(root, file.getName().substring(0, file.getName().length() - ".properties".length())));
            } catch (IOException | IllegalArgumentException ignored) {
                // 损坏或外来文件跳过
            }
        }
        records.sort((a, b) -> a.getProperty("createdAt", "").compareTo(b.getProperty("createdAt", "")));
        return records;
    }

    static void delete(File root, String id) {
        //noinspection ResultOfMethodCallIgnored
        recordFile(root, id).delete();
        //noinspection ResultOfMethodCallIgnored
        stagedFile(root, id).delete();
    }

    static Map<String, String> headers(Properties record) {
        Map<String, String> headers = new TreeMap<>();
        for (String key : record.stringPropertyNames()) {
            if (key.startsWith("header.")) headers.put(key.substring(7), record.getProperty(key));
        }
        return headers;
    }

    /** 大小写不敏感地取 Content-Type；签名地址通常把它算进签名，必须由业务显式给出。 */
    static String contentType(Map<String, String> headers) {
        for (Map.Entry<String, String> header : headers.entrySet()) {
            if (header.getKey().equalsIgnoreCase("content-type") && !header.getValue().isEmpty()) return header.getValue();
        }
        return null;
    }

    static boolean validHeaderName(String name) {
        return name != null && name.matches("[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}")
            && !name.toLowerCase(Locale.ROOT).equals("content-length")
            && !name.toLowerCase(Locale.ROOT).equals("host");
    }

    /** 4xx（签名过期、拒绝）不重试，交回业务重新签名；5xx 与网络错误按退避重试。 */
    static boolean retryable(int status) {
        return status == 408 || status == 429 || status >= 500;
    }

    static String isoNow() {
        java.text.SimpleDateFormat iso = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
        iso.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return iso.format(new java.util.Date());
    }
}
