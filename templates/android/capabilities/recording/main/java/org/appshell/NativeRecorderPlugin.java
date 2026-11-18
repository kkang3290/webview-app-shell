package org.appshell;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.media.AudioRecordingConfiguration;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.IOException;
import java.util.Arrays;
import java.util.List;
import java.util.Properties;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 原生录音，与 iOS 的 NativeRecorder 同一接口与语义（见 app-shell 的 web/index.js）：
 * AudioRecord 采集 → 分段先落盘再推 chunk 事件 → Web 补拉 readChunks / 确认 ack → 删除；
 * 同时写完整 m4a。采集期间挂在 RecordingForegroundService（microphone 类型）上，锁屏 / 后台不断。
 */
@CapacitorPlugin(
    name = "NativeRecorder",
    permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class NativeRecorderPlugin extends Plugin implements NativeRecorderSession.Listener {
    static final List<Integer> SAMPLE_RATES = Arrays.asList(8000, 16000, 24000, 48000);

    // 录音属于进程而不是页面：系统在后台回收 Activity 时（前台服务仍保着进程），录音不能跟着停。
    // 会话与工作线程是进程级的；当前的插件实例只负责把事件推给眼下这个 WebView。
    private static final ExecutorService worker = Executors.newSingleThreadExecutor();
    private static NativeRecorderSession session;
    private static AudioManager.AudioRecordingCallback recordingCallback;
    private static volatile NativeRecorderPlugin current;
    private static boolean bluetoothRouted;
    private android.media.AudioDeviceCallback deviceCallback;

    @Override
    public void load() {
        current = this;
        // 耳机连上 / 断开时把新的输入列表推给 Web，界面据此刷新选择器。
        deviceCallback = new android.media.AudioDeviceCallback() {
            @Override
            public void onAudioDevicesAdded(android.media.AudioDeviceInfo[] added) {
                publishInputs();
            }

            @Override
            public void onAudioDevicesRemoved(android.media.AudioDeviceInfo[] removed) {
                publishInputs();
            }
        };
        NativeRecorderInputs.audio(getContext()).registerAudioDeviceCallback(deviceCallback, new Handler(Looper.getMainLooper()));
    }

    private void publishInputs() {
        worker.execute(() -> {
            NativeRecorderSession active = session;
            notifyListeners("inputs", new JSObject().put("inputs",
                NativeRecorderInputs.list(getContext(), active == null ? 0 : active.routedDeviceId())));
        });
    }

    /** 按 inputId 配置会话输入；蓝牙要先把通话链路切过去。inputId 为空表示系统默认。 */
    private void applyInput(NativeRecorderSession target, String inputId) throws IOException {
        if (bluetoothRouted) {
            NativeRecorderInputs.clearRouting(getContext());
            bluetoothRouted = false;
        }
        if (inputId == null) {
            target.setInput(null, false);
            return;
        }
        android.media.AudioDeviceInfo device = NativeRecorderInputs.find(getContext(), inputId);
        if (device == null) throw new IOException("unknown input " + inputId);
        boolean bluetooth = NativeRecorderInputs.isBluetooth(device.getType());
        if (bluetooth) {
            if (!NativeRecorderInputs.routeBluetooth(getContext(), device)) {
                NativeRecorderInputs.clearRouting(getContext());
                throw new IOException("bluetooth input could not be routed");
            }
            bluetoothRouted = true;
        }
        target.setInput(device, bluetooth);
    }

    @PluginMethod
    public void listInputs(PluginCall call) {
        worker.execute(() -> {
            NativeRecorderSession active = session;
            call.resolve(new JSObject().put("inputs",
                NativeRecorderInputs.list(getContext(), active == null ? 0 : active.routedDeviceId())));
        });
    }

    @PluginMethod
    public void setInput(PluginCall call) {
        String inputId = call.getString("inputId");
        worker.execute(() -> {
            if (session == null) {
                call.reject("no active recording", "IDLE");
                return;
            }
            boolean wasRunning = session.isRunning();
            try {
                session.pause();
                applyInput(session, inputId);
                if (wasRunning) session.start();
                notifyState(wasRunning ? "recording" : "paused", "input-changed");
                call.resolve(new JSObject().put("inputs", NativeRecorderInputs.list(getContext(), session.routedDeviceId())));
            } catch (IOException e) {
                call.reject("unable to switch input: " + e.getMessage(), "INPUT_FAILED");
            }
        });
    }

    private File root() {
        return NativeRecorderStore.root(getContext().getFilesDir());
    }

    @PluginMethod
    public void start(PluginCall call) {
        Integer chunkMs = call.getInt("chunkMs");
        Integer sampleRate = call.getInt("sampleRate");
        if (chunkMs == null || chunkMs < 200 || chunkMs > 5000) {
            call.reject("chunkMs must be 200..5000");
            return;
        }
        if (sampleRate == null || !SAMPLE_RATES.contains(sampleRate)) {
            call.reject("sampleRate must be 8000, 16000, 24000 or 48000");
            return;
        }
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "afterMicrophone");
            return;
        }
        worker.execute(() -> startNow(call, sampleRate, chunkMs));
    }

    @PermissionCallback
    private void afterMicrophone(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("microphone permission denied", "PERMISSION_DENIED");
            return;
        }
        worker.execute(() -> startNow(call, call.getInt("sampleRate"), call.getInt("chunkMs")));
    }

    private void startNow(PluginCall call, int sampleRate, int chunkMs) {
        if (session != null) {
            call.reject("a recording is already active", "BUSY");
            return;
        }
        long generation = RecordingForegroundService.requestKeepAliveStart();
        NativeRecorderSession created = null;
        try {
            // 先把前台服务拉起来：Android 12+ 只允许在前台发起，录音必须从可见页面开始。
            ContextCompat.startForegroundService(getContext(),
                new Intent(getContext(), RecordingForegroundService.class).setAction(RecordingForegroundService.ACTION_START));
            created = new NativeRecorderSession(root(), sampleRate, chunkMs, call.getString("label", ""), DISPATCH);
            applyInput(created, call.getString("inputId"));
            created.start();
            session = created;
            watchSilencing();
            notifyState("recording", "started");
            call.resolve(describe(created, "recording"));
        } catch (Exception e) {
            if (created != null) {
                created.finish();
                NativeRecorderStore.deleteRecursively(created.dir);
            }
            if (bluetoothRouted) {
                NativeRecorderInputs.clearRouting(getContext());
                bluetoothRouted = false;
            }
            RecordingForegroundService.failKeepAliveStart(generation);
            RecordingForegroundService.stopKeepAliveIfActive();
            call.reject("unable to start recording: " + e.getMessage(), "START_FAILED");
        }
    }

    @PluginMethod
    public void pause(PluginCall call) {
        worker.execute(() -> {
            if (session == null) {
                call.reject("no active recording", "IDLE");
                return;
            }
            session.pause();
            notifyState("paused", "requested");
            call.resolve(describe(session, "paused"));
        });
    }

    @PluginMethod
    public void resume(PluginCall call) {
        worker.execute(() -> {
            if (session == null) {
                call.reject("no active recording", "IDLE");
                return;
            }
            try {
                session.start();
                notifyState("recording", "resumed");
                call.resolve(describe(session, "recording"));
            } catch (IOException e) {
                call.reject("unable to resume: " + e.getMessage(), "RESUME_FAILED");
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        worker.execute(() -> {
            if (session == null) {
                call.reject("no active recording", "IDLE");
                return;
            }
            NativeRecorderSession finished = session;
            session = null;
            unwatchSilencing();
            Properties summary = finished.finish();
            if (bluetoothRouted) {
                NativeRecorderInputs.clearRouting(getContext());
                bluetoothRouted = false;
            }
            RecordingForegroundService.stopKeepAliveIfActive();
            notifyState("idle", "stopped");
            call.resolve(toJs(summary));
        });
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        worker.execute(() -> {
            JSObject status = session == null ? new JSObject().put("state", "idle")
                : describe(session, session.isRunning() ? "recording" : "paused");
            status.put("microphone", getPermissionState("microphone") == PermissionState.GRANTED ? "granted"
                : getPermissionState("microphone") == PermissionState.DENIED ? "denied" : "prompt");
            call.resolve(status);
        });
    }

    @PluginMethod
    public void readChunks(PluginCall call) {
        String id = call.getString("sessionId");
        Integer after = call.getInt("afterSeq");
        Integer limit = call.getInt("limit");
        if (id == null || after == null || limit == null || limit < 1 || limit > 120) {
            call.reject("sessionId, afterSeq and limit (1..120) are required");
            return;
        }
        worker.execute(() -> {
            try {
                NativeRecorderStore.Page page = NativeRecorderStore.readChunks(
                    NativeRecorderStore.sessionDir(root(), id), after, limit);
                JSArray chunks = new JSArray();
                for (NativeRecorderStore.Chunk chunk : page.chunks) {
                    chunks.put(new JSObject()
                        .put("seq", chunk.seq)
                        .put("sampleRate", page.sampleRate)
                        .put("level", NativeRecorderStore.level(chunk.pcm, chunk.pcm.length))
                        .put("data", Base64.encodeToString(chunk.pcm, Base64.NO_WRAP)));
                }
                call.resolve(new JSObject().put("sessionId", id).put("lastSeq", page.lastSeq)
                    .put("chunks", chunks).put("hasMore", page.hasMore));
            } catch (IOException e) {
                call.reject(e.getMessage(), "NOT_FOUND");
            }
        });
    }

    @PluginMethod
    public void ack(PluginCall call) {
        String id = call.getString("sessionId");
        Integer upto = call.getInt("uptoSeq");
        if (id == null || upto == null) {
            call.reject("sessionId and uptoSeq are required");
            return;
        }
        worker.execute(() -> {
            try {
                int removed = NativeRecorderStore.deleteChunks(NativeRecorderStore.sessionDir(root(), id), upto);
                call.resolve(new JSObject().put("removed", removed));
            } catch (IOException e) {
                call.reject(e.getMessage(), "NOT_FOUND");
            }
        });
    }

    @PluginMethod
    public void listSessions(PluginCall call) {
        worker.execute(() -> {
            JSArray sessions = new JSArray();
            String active = session == null ? null : session.id;
            for (Properties meta : NativeRecorderStore.list(root())) {
                sessions.put(toJs(meta).put("active", meta.getProperty("sessionId", "").equals(active)));
            }
            call.resolve(new JSObject().put("sessions", sessions));
        });
    }

    @PluginMethod
    public void discard(PluginCall call) {
        String id = call.getString("sessionId");
        worker.execute(() -> {
            if (session != null && session.id.equalsIgnoreCase(String.valueOf(id))) {
                call.reject("stop the recording before discarding it", "BUSY");
                return;
            }
            try {
                NativeRecorderStore.deleteRecursively(NativeRecorderStore.sessionDir(root(), id));
                call.resolve();
            } catch (IOException e) {
                call.reject(e.getMessage(), "NOT_FOUND");
            }
        });
    }

    // ─── 采集线程回调 ────────────────────────────────────────────

    /** 转发给当前的插件实例；页面重建期间没有实例时只落盘不推送，回来后 Web 补拉。 */
    private static final NativeRecorderSession.Listener DISPATCH = new NativeRecorderSession.Listener() {
        @Override
        public void onChunk(NativeRecorderSession source, int seq, int startMs, int durationMs, byte[] pcm, int length) {
            NativeRecorderPlugin plugin = current;
            if (plugin != null) plugin.onChunk(source, seq, startMs, durationMs, pcm, length);
        }

        @Override
        public void onFailure(NativeRecorderSession source, String reason) {
            worker.execute(() -> {
                if (session != source) return;
                source.pause();
                NativeRecorderPlugin plugin = current;
                if (plugin != null) plugin.notifyState("interrupted", reason);
            });
        }
    };

    @Override
    public void onChunk(NativeRecorderSession source, int seq, int startMs, int durationMs, byte[] pcm, int length) {
        notifyListeners("chunk", new JSObject()
            .put("sessionId", source.id)
            .put("seq", seq)
            .put("startMs", startMs)
            .put("durationMs", durationMs)
            .put("sampleRate", source.sampleRate)
            .put("level", NativeRecorderStore.level(pcm, length))
            .put("data", Base64.encodeToString(pcm, 0, length, Base64.NO_WRAP)));
    }

    @Override
    public void onFailure(NativeRecorderSession source, String reason) {
        DISPATCH.onFailure(source, reason);
    }

    // ─── 被系统静音（来电、其他 App 抢麦）─────────────────────────

    private void watchSilencing() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || recordingCallback != null) return;
        AudioManager audio = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        recordingCallback = new AudioManager.AudioRecordingCallback() {
            @Override
            public void onRecordingConfigChanged(List<AudioRecordingConfiguration> configs) {
                NativeRecorderSession active = session;
                if (active == null) return;
                int id = active.audioSessionId();
                for (AudioRecordingConfiguration config : configs) {
                    if (config.getClientAudioSessionId() != id) continue;
                    boolean silenced = config.isClientSilenced();
                    active.setSilenced(silenced);
                    NativeRecorderPlugin plugin = NativeRecorderPlugin.current;
                    if (plugin != null) {
                        plugin.notifyState(silenced ? "interrupted" : "recording", silenced ? "system" : "interruption-ended");
                    }
                }
            }
        };
        audio.registerAudioRecordingCallback(recordingCallback, new Handler(Looper.getMainLooper()));
    }

    private void unwatchSilencing() {
        if (recordingCallback == null) return;
        AudioManager audio = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        audio.unregisterAudioRecordingCallback(recordingCallback);
        recordingCallback = null;
    }

    // ─── 工具 ────────────────────────────────────────────────────

    private void notifyState(String state, String reason) {
        JSObject data = new JSObject().put("state", state).put("reason", reason);
        NativeRecorderSession active = session;
        if (active != null) data.put("sessionId", active.id);
        notifyListeners("state", data);
    }

    private static JSObject describe(NativeRecorderSession session, String state) {
        return toJs(session.describe(state));
    }

    static JSObject toJs(Properties meta) {
        JSObject out = new JSObject();
        for (String key : meta.stringPropertyNames()) {
            String value = meta.getProperty(key);
            switch (key) {
                case "lastSeq":
                case "sampleRate":
                case "interruptions":
                    out.put(key, Integer.parseInt(value));
                    break;
                case "durationMs":
                    out.put(key, Long.parseLong(value));
                    break;
                default:
                    out.put(key, value);
            }
        }
        return out;
    }

    @Override
    protected void handleOnDestroy() {
        // 不结束录音：只是这个页面不再接收事件。
        if (current == this) current = null;
        if (deviceCallback != null) {
            NativeRecorderInputs.audio(getContext()).unregisterAudioDeviceCallback(deviceCallback);
            deviceCallback = null;
        }
    }
}
