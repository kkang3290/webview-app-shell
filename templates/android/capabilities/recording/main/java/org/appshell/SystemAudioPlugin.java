package org.appshell;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjectionConfig;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.ref.WeakReference;

/** Android 10+ playback capture. Registered only where the native API exists. */
@CapacitorPlugin(name = "SystemAudio")
public class SystemAudioPlugin extends Plugin {
    private static WeakReference<SystemAudioPlugin> active = new WeakReference<>(null);
    private PluginCall pending;
    private String sessionId;
    // A cancelled consent activity must return before another consent can be launched.
    private boolean consentOpen;
    private long consentGrantedAt;

    @PluginMethod
    public void start(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            String id = call.getString("sessionId");
            if (id == null || id.isEmpty() || id.length() > 100) {
                call.reject("Invalid capture session");
                return;
            }
            if (sessionId != null || consentOpen) {
                resolveStart(call, false, "busy");
                return;
            }
            if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
                    != PackageManager.PERMISSION_GRANTED) {
                resolveStart(call, false, "denied");
                return;
            }
            active = new WeakReference<>(this);
            sessionId = id;
            pending = call;
            consentOpen = true;
            consentGrantedAt = 0L;
            try {
                MediaProjectionManager manager = (MediaProjectionManager)
                    getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
                Log.i("AppShell/SystemAudio", "screen capture consent requested");
                startActivityForResult(call, captureIntent(manager), "captureConsent");
            } catch (RuntimeException error) {
                consentOpen = false;
                failed(id, "failed");
            }
        });
    }

    static Intent captureIntent(MediaProjectionManager manager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14 defaults to sharing one app. Selecting ExampleApp there can
            // return RESULT_CANCELED and never start playback capture, so request
            // the display explicitly for this system-audio-only projection.
            return manager.createScreenCaptureIntent(
                MediaProjectionConfig.createConfigForDefaultDisplay());
        }
        return manager.createScreenCaptureIntent();
    }

    @ActivityCallback
    private void captureConsent(PluginCall call, ActivityResult result) {
        Log.i("AppShell/SystemAudio", "screen capture consent returned; granted="
            + (result.getResultCode() == Activity.RESULT_OK));
        consentOpen = false;
        if (call == null || call != pending || sessionId == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            failed(sessionId, "cancelled");
            return;
        }
        consentGrantedAt = SystemClock.elapsedRealtime();
        try {
            Intent intent = new Intent(getContext(), RecordingForegroundService.class)
                .setAction(RecordingForegroundService.ACTION_SYSTEM_START)
                .putExtra("sessionId", sessionId)
                .putExtra("resultCode", result.getResultCode())
                .putExtra("resultData", result.getData());
            ContextCompat.startForegroundService(getContext(), intent);
        } catch (RuntimeException error) {
            failed(sessionId, "failed");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            String id = call.getString("sessionId");
            if (owns(id)) {
                failed(id, "cancelled");
                RecordingForegroundService.stopSystemAudio(id);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void acknowledge(PluginCall call) {
        RecordingForegroundService.acknowledgeSystemAudio(
            call.getString("sessionId"), call.getInt("sequence", 0));
        call.resolve();
    }

    static boolean isActive(String id) {
        SystemAudioPlugin plugin = active.get();
        return plugin != null && plugin.owns(id);
    }

    private boolean owns(String id) { return id != null && id.equals(sessionId); }

    static void started(String id) {
        SystemAudioPlugin plugin = active.get();
        if (plugin == null || !plugin.owns(id) || plugin.pending == null) return;
        PluginCall call = plugin.pending;
        plugin.pending = null;
        JSObject result = new JSObject();
        result.put("started", true);
        if (plugin.consentGrantedAt > 0L) {
            result.put("captureReadyMs", SystemClock.elapsedRealtime() - plugin.consentGrantedAt);
        }
        call.resolve(result);
    }

    static void data(String id, String pcm, int sequence) {
        SystemAudioPlugin plugin = active.get();
        if (plugin == null || !plugin.owns(id)) return;
        JSObject event = new JSObject();
        event.put("sessionId", id);
        event.put("pcm", pcm);
        event.put("sequence", sequence);
        plugin.notifyListeners("data", event);
    }

    static void failed(String id, String reason) {
        SystemAudioPlugin plugin = active.get();
        if (plugin == null || !plugin.owns(id)) return;
        plugin.sessionId = null;
        if (plugin.pending != null) {
            PluginCall call = plugin.pending;
            plugin.pending = null;
            resolveStart(call, false, reason);
        } else if (!"cancelled".equals(reason)) {
            JSObject event = new JSObject();
            event.put("sessionId", id);
            event.put("reason", reason);
            plugin.notifyListeners("error", event);
        }
    }

    private static void resolveStart(PluginCall call, boolean started, String reason) {
        JSObject result = new JSObject();
        result.put("started", started);
        if (reason != null) result.put("reason", reason);
        call.resolve(result);
    }

    @Override
    protected void handleOnDestroy() {
        getActivity().runOnUiThread(() -> {
            String id = sessionId;
            if (id != null) {
                failed(id, "cancelled");
                RecordingForegroundService.stopSystemAudio(id);
            }
            if (active.get() == this) active.clear();
        });
        super.handleOnDestroy();
    }
}
