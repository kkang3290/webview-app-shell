package org.appshell;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Data;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;

/**
 * 一个上传任务。WorkManager 负责「有网再跑、进程被杀后重排、失败退避」；
 * 这里只做一次 HTTP 传输并把结果写回任务记录。
 */
public class BackgroundUploadWorker extends Worker {
    static final int MAX_ATTEMPTS = 8;
    private static final String TAG = "AppShell/Upload";
    private static final int PROGRESS_STEP = 256 * 1024;

    public BackgroundUploadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        String id = getInputData().getString("id");
        File root = BackgroundUploadStore.root(getApplicationContext().getFilesDir());
        Properties record;
        try {
            record = BackgroundUploadStore.load(root, id);
        } catch (IOException | IllegalArgumentException e) {
            return Result.failure();
        }
        if (!"queued".equals(record.getProperty("state")) && !"running".equals(record.getProperty("state"))) {
            return Result.success();
        }
        File source = new File(record.getProperty("source"));
        if (!source.isFile()) {
            update(root, record, "failed", "source file missing");
            return Result.failure();
        }
        if (!hasNetwork()) {
            // 没网不算一次失败，等退避后再看。
            update(root, record, "queued", "waiting for network");
            return Result.retry();
        }
        long total = source.length();
        update(root, record, "running", null);
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(record.getProperty("url")).openConnection();
            connection.setRequestMethod(record.getProperty("method"));
            connection.setDoOutput(true);
            connection.setConnectTimeout(30_000);
            connection.setReadTimeout(120_000);
            connection.setFixedLengthStreamingMode(total);
            for (Map.Entry<String, String> header : BackgroundUploadStore.headers(record).entrySet()) {
                connection.setRequestProperty(header.getKey(), header.getValue());
            }
            long sent = 0;
            long reported = 0;
            byte[] buffer = new byte[64 * 1024];
            try (InputStream in = new FileInputStream(source); OutputStream out = connection.getOutputStream()) {
                int read;
                while ((read = in.read(buffer)) > 0) {
                    if (isStopped()) return Result.success();
                    out.write(buffer, 0, read);
                    sent += read;
                    if (sent - reported >= PROGRESS_STEP || sent == total) {
                        reported = sent;
                        progress(id, sent, total);
                    }
                }
            }
            int status = connection.getResponseCode();
            record.setProperty("status", Integer.toString(status));
            record.setProperty("sent", Long.toString(sent));
            for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet()) {
                if (header.getKey() == null || header.getValue().isEmpty()) continue;
                String name = header.getKey().toLowerCase(Locale.ROOT);
                if (name.equals("etag") || name.startsWith("x-")) record.setProperty("response." + name, header.getValue().get(0));
            }
            if (status >= 200 && status < 300) {
                record.setProperty("attempts", Integer.toString(Integer.parseInt(record.getProperty("attempts", "0")) + 1));
                update(root, record, "succeeded", null);
                return Result.success();
            }
            return retryOrFail(root, record, "HTTP " + status, BackgroundUploadStore.retryable(status));
        } catch (IOException e) {
            Log.w(TAG, "upload " + id + " failed", e);
            return retryOrFail(root, record, e.getClass().getSimpleName() + ": " + e.getMessage(), true);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private boolean hasNetwork() {
        android.net.ConnectivityManager connectivity = (android.net.ConnectivityManager)
            getApplicationContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivity == null) return true;
        android.net.Network network = connectivity.getActiveNetwork();
        android.net.NetworkCapabilities caps = network == null ? null : connectivity.getNetworkCapabilities(network);
        return caps != null && caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private Result retryOrFail(File root, Properties record, String error, boolean retryable) {
        int attempt = Integer.parseInt(record.getProperty("attempts", "0")) + 1;
        record.setProperty("attempts", Integer.toString(attempt));
        if (retryable && attempt < MAX_ATTEMPTS) {
            update(root, record, "queued", error);
            return Result.retry();
        }
        update(root, record, "failed", error);
        return Result.failure();
    }

    private void update(File root, Properties record, String state, String error) {
        record.setProperty("state", state);
        if (error == null) record.remove("error");
        else record.setProperty("error", error);
        if ("succeeded".equals(state) || "failed".equals(state)) record.setProperty("finishedAt", BackgroundUploadStore.isoNow());
        try {
            BackgroundUploadStore.save(root, record);
        } catch (IOException e) {
            Log.w(TAG, "record write failed", e);
        }
        BackgroundUploadPlugin.dispatchState(record);
    }

    private void progress(String id, long sent, long total) {
        setProgressAsync(new Data.Builder().putLong("sent", sent).putLong("total", total).build());
        BackgroundUploadPlugin.dispatchProgress(id, sent, total);
    }
}
