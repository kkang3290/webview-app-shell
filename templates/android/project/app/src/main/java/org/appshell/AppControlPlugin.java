package org.appshell;

import android.app.Activity;
import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

@CapacitorPlugin(name = "AppControl")
public class AppControlPlugin extends Plugin {
    static final String IMAGE_RELATIVE_PATH = Environment.DIRECTORY_PICTURES + "/" + AppShellConfig.STORAGE_DIR;

    @PluginMethod
    public void shareText(PluginCall call) {
        String text = call.getString("text");
        if (text == null || text.trim().isEmpty()) {
            call.reject("Share text is required");
            return;
        }
        Intent send = new Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_SUBJECT, call.getString("title", AppShellConfig.APP_NAME))
            .putExtra(Intent.EXTRA_TEXT, text);
        getActivity().runOnUiThread(() -> {
            try {
                startActivityForResult(call, Intent.createChooser(send, null), "shareResult");
            } catch (ActivityNotFoundException error) {
                call.reject("System sharing is unavailable");
            }
        });
    }

    @ActivityCallback
    private void shareResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject response = new JSObject();
        response.put("cancelled", result.getResultCode() == Activity.RESULT_CANCELED);
        call.resolve(response);
    }

    @PluginMethod
    public void saveImage(PluginCall call) {
        String encoded = call.getString("data");
        if (encoded == null || encoded.trim().isEmpty()) {
            call.reject("Image data is required");
            return;
        }
        final byte[] bytes;
        try {
            bytes = Base64.decode(encoded, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            call.reject("Invalid image data");
            return;
        }
        if (bytes.length == 0) {
            call.reject("Image data is empty");
            return;
        }
        String filename = imageFilename(call.getString("filename"));
        new Thread(() -> {
            try {
                Uri uri = writeImage(filename, bytes);
                JSObject response = new JSObject();
                response.put("uri", uri.toString());
                call.resolve(response);
            } catch (Exception error) {
                call.reject("Unable to save image");
            }
        }).start();
    }

    /**
     * 把一张 PNG 交给系统分享面板（微信、相册、其他应用）。Android 的 WebView 没有 Web Share API，
     * 图片分享只能走原生：写进应用缓存目录，经 FileProvider 以只读临时授权发出去。
     */
    @PluginMethod
    public void shareImage(PluginCall call) {
        String encoded = call.getString("data");
        if (encoded == null || encoded.trim().isEmpty()) {
            call.reject("Image data is required");
            return;
        }
        final byte[] bytes;
        try {
            bytes = Base64.decode(encoded, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            call.reject("Invalid image data");
            return;
        }
        if (bytes.length == 0) {
            call.reject("Image data is empty");
            return;
        }
        String filename = imageFilename(call.getString("filename"));
        String title = call.getString("title", AppShellConfig.APP_NAME);
        new Thread(() -> {
            final Uri uri;
            try {
                File directory = new File(getContext().getCacheDir(), "appshell-share");
                // 只留这一次要分享的图：上一次的接收方早已读完
                File[] stale = directory.listFiles();
                if (stale != null) for (File file : stale) //noinspection ResultOfMethodCallIgnored
                    file.delete();
                if (!directory.mkdirs() && !directory.isDirectory()) throw new IOException("cache directory unavailable");
                File file = new File(directory, filename);
                try (OutputStream out = new FileOutputStream(file)) {
                    out.write(bytes);
                }
                uri = androidx.core.content.FileProvider.getUriForFile(
                    getContext(), getContext().getPackageName() + ".fileprovider", file);
            } catch (Exception error) {
                call.reject("Unable to prepare image");
                return;
            }
            Intent send = new Intent(Intent.ACTION_SEND)
                .setType("image/png")
                .putExtra(Intent.EXTRA_STREAM, uri)
                .putExtra(Intent.EXTRA_SUBJECT, title)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            send.setClipData(android.content.ClipData.newRawUri(title, uri));
            Intent chooser = Intent.createChooser(send, null).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().runOnUiThread(() -> {
                try {
                    startActivityForResult(call, chooser, "shareResult");
                } catch (ActivityNotFoundException error) {
                    call.reject("System sharing is unavailable");
                }
            });
        }).start();
    }

    static String imageFilename(String raw) {
        String filename = FileNames.sanitize(raw, AppShellConfig.APP_NAME + "-summary.png");
        if (!filename.toLowerCase().endsWith(".png")) filename += ".png";
        return FileNames.truncateKeepingExtension(filename, FileNames.MAX_NAME_LENGTH);
    }

    private Uri writeImage(String filename, byte[] bytes) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return writeModernImage(filename, bytes);
        }
        if (getContext().checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            throw new SecurityException("Storage permission is required");
        }
        File directory = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), AppShellConfig.STORAGE_DIR);
        if (!directory.exists() && !directory.mkdirs()) throw new IOException("Image directory unavailable");
        File file = new File(directory, filename);
        int sequence = 1;
        while (file.exists()) file = new File(directory, imageFilename(FileNames.baseName(filename) + " (" + sequence++ + ").png"));
        try (OutputStream stream = new FileOutputStream(file)) {
            stream.write(bytes);
        }
        MediaScannerConnection.scanFile(getContext(), new String[]{file.getAbsolutePath()}, new String[]{"image/png"}, null);
        return Uri.fromFile(file);
    }

    private Uri writeModernImage(String filename, byte[] bytes) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, filename);
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
        values.put(MediaStore.Images.Media.RELATIVE_PATH, IMAGE_RELATIVE_PATH);
        values.put(MediaStore.Images.Media.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("Image insert failed");
        try {
            OutputStream stream = resolver.openOutputStream(uri);
            if (stream == null) throw new IOException("Image stream unavailable");
            try (OutputStream output = stream) {
                output.write(bytes);
            }
            ContentValues published = new ContentValues();
            published.put(MediaStore.Images.Media.IS_PENDING, 0);
            resolver.update(uri, published, null, null);
            return uri;
        } catch (Exception error) {
            resolver.delete(uri, null, null);
            if (error instanceof IOException) throw (IOException) error;
            throw new IOException("Image write failed", error);
        }
    }

    @PluginMethod
    public void exitApp(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            call.resolve();
            getActivity().finishAndRemoveTask();
        });
    }
}
