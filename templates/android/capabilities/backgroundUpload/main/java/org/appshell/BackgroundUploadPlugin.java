package org.appshell;

import android.util.Base64;

import androidx.work.BackoffPolicy;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.Iterator;
import java.util.Properties;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/**
 * 后台上传（iOS 同名同语义）：enqueue / get / list / cancel / remove，事件 progress / state。
 * 任务交给 WorkManager：页面关了、App 被杀、断网后恢复都会继续；4xx 不重试，交回业务重新签名。
 */
@CapacitorPlugin(name = "BackgroundUpload")
public class BackgroundUploadPlugin extends Plugin {
    static final long MAX_INLINE_BYTES = 10L * 1024 * 1024;
    private static volatile BackgroundUploadPlugin current;

    @Override
    public void load() {
        current = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (current == this) current = null;
    }

    private File root() {
        return BackgroundUploadStore.root(getContext().getFilesDir());
    }

    private static String workName(String id) {
        return "appshell-upload-" + id;
    }

    @PluginMethod
    public void enqueue(PluginCall call) {
        String id = call.getString("id", UUID.randomUUID().toString());
        String url = call.getString("url");
        String method = call.getString("method");
        JSObject file = call.getObject("file");
        JSObject headers = call.getObject("headers", new JSObject());
        try {
            BackgroundUploadStore.checkId(id);
            if (!allowedUrl(url, debuggable())) throw new IOException("url must be https (debug builds may also use http://127.0.0.1)");
            if (!"PUT".equals(method) && !"POST".equals(method)) throw new IOException("method must be PUT or POST");
            if (file == null) throw new IOException("file is required");
            // 先校验请求头，再落暂存文件：被拒的请求不留下孤儿文件。
            java.util.Map<String, String> headerMap = new java.util.TreeMap<>();
            for (Iterator<String> keys = headers.keys(); keys.hasNext(); ) {
                String name = keys.next();
                if (!BackgroundUploadStore.validHeaderName(name)) throw new IOException("invalid header " + name);
                headerMap.put(name, headers.getString(name));
            }
            if (BackgroundUploadStore.contentType(headerMap) == null) {
                throw new IOException("headers must include Content-Type (signed URLs usually sign it; platforms default differently)");
            }
            File root = root();
            if (BackgroundUploadStore.recordFile(root, id).exists()) throw new IOException("upload " + id + " already exists");
            File source;
            if (file.has("data")) {
                byte[] bytes = Base64.decode(file.getString("data"), Base64.DEFAULT);
                if (bytes.length > MAX_INLINE_BYTES) throw new IOException("inline data is limited to 10 MiB; write a file and pass file.path");
                source = BackgroundUploadStore.stagedFile(root, id);
                try (OutputStream out = new FileOutputStream(source)) {
                    out.write(bytes);
                }
            } else {
                File external = getContext().getExternalFilesDir(null);
                source = BackgroundUploadStore.resolveSource(file.getString("path"), Arrays.asList(
                    getContext().getFilesDir().getParentFile(), external == null ? null : external.getParentFile()));
            }
            Properties record = new Properties();
            record.setProperty("id", id);
            record.setProperty("url", url);
            record.setProperty("method", method);
            record.setProperty("source", source.getAbsolutePath());
            record.setProperty("label", call.getString("label", ""));
            record.setProperty("state", "queued");
            record.setProperty("sent", "0");
            record.setProperty("total", Long.toString(source.length()));
            record.setProperty("attempts", "0");
            record.setProperty("createdAt", BackgroundUploadStore.isoNow());
            for (java.util.Map.Entry<String, String> header : headerMap.entrySet()) {
                record.setProperty("header." + header.getKey(), header.getValue());
            }
            BackgroundUploadStore.save(root, record);
            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(BackgroundUploadWorker.class)
                .setInputData(new Data.Builder().putString("id", id).build())
                // 不挂「已联网」约束：它要求系统验证过的网络，内网、需网页登录的 Wi-Fi、连不上联网检测地址的
                // 设备上会永远不跑。没网由 Worker 自己判断并退避重试。
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .addTag("appshell-upload")
                .build();
            WorkManager.getInstance(getContext()).enqueueUniqueWork(workName(id), ExistingWorkPolicy.KEEP, request);
            call.resolve(toJs(record));
        } catch (IOException | IllegalArgumentException e) {
            call.reject(e.getMessage(), "INVALID");
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        try {
            call.resolve(toJs(BackgroundUploadStore.load(root(), call.getString("id"))));
        } catch (IOException | IllegalArgumentException e) {
            call.reject(e.getMessage(), "NOT_FOUND");
        }
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray uploads = new JSArray();
        for (Properties record : BackgroundUploadStore.list(root())) uploads.put(toJs(record));
        call.resolve(new JSObject().put("uploads", uploads));
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        try {
            Properties record = BackgroundUploadStore.load(root(), id);
            WorkManager.getInstance(getContext()).cancelUniqueWork(workName(id));
            String state = record.getProperty("state");
            if ("queued".equals(state) || "running".equals(state)) {
                record.setProperty("state", "cancelled");
                record.setProperty("finishedAt", BackgroundUploadStore.isoNow());
                BackgroundUploadStore.save(root(), record);
                dispatchState(record);
            }
            call.resolve(toJs(record));
        } catch (IOException | IllegalArgumentException e) {
            call.reject(e.getMessage(), "NOT_FOUND");
        }
    }

    /** 删除已结束任务的记录（以及 enqueue 时暂存的 data 文件；业务自己的文件不动）。 */
    @PluginMethod
    public void remove(PluginCall call) {
        String id = call.getString("id");
        try {
            Properties record = BackgroundUploadStore.load(root(), id);
            String state = record.getProperty("state");
            if ("queued".equals(state) || "running".equals(state)) {
                call.reject("cancel the upload before removing it", "BUSY");
                return;
            }
            BackgroundUploadStore.delete(root(), id);
            call.resolve();
        } catch (IOException | IllegalArgumentException e) {
            call.reject(e.getMessage(), "NOT_FOUND");
        }
    }

    private boolean debuggable() {
        return (getContext().getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    /** 正式包只收 https；Debug 包额外允许本机回环的 http，便于对着本机测试服务联调。 */
    static boolean allowedUrl(String url, boolean debuggable) {
        if (url == null) return false;
        if (url.startsWith("https://")) return true;
        return debuggable && (url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:"));
    }

    static JSObject toJs(Properties record) {
        JSObject out = new JSObject();
        JSObject response = new JSObject();
        for (String key : record.stringPropertyNames()) {
            String value = record.getProperty(key);
            if (key.startsWith("header.") || key.equals("url") || key.equals("source")) continue;
            if (key.startsWith("response.")) {
                response.put(key.substring(9), value);
            } else if (key.equals("sent") || key.equals("total")) {
                out.put(key, Long.parseLong(value));
            } else if (key.equals("status") || key.equals("attempts")) {
                out.put(key, Integer.parseInt(value));
            } else {
                out.put(key, value);
            }
        }
        out.put("responseHeaders", response);
        return out;
    }

    static void dispatchState(Properties record) {
        BackgroundUploadPlugin plugin = current;
        if (plugin != null) plugin.notifyListeners("state", toJs(record));
    }

    static void dispatchProgress(String id, long sent, long total) {
        BackgroundUploadPlugin plugin = current;
        if (plugin != null) plugin.notifyListeners("progress", new JSObject().put("id", id).put("sent", sent).put("total", total));
    }
}
