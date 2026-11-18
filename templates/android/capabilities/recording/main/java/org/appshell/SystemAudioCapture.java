package org.appshell;

import android.Manifest;
import android.os.Build;
import androidx.annotation.RequiresApi;
import androidx.annotation.RequiresPermission;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/** PCM16 mono at 16 kHz, the same wire format as the desktop recorder. */
final class SystemAudioCapture {
    static final int SAMPLE_RATE = 16_000;
    static final int CHUNK_SAMPLES = 1_600;
    private static final String TAG = "AppShell/SystemAudio";
    private final String sessionId;
    private final MediaProjection projection;
    private final Runnable started;
    private final Consumer<String> interrupted;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicInteger acknowledged = new AtomicInteger();
    private volatile int sequence;
    private volatile boolean stopped;
    private volatile boolean projectionCallbackRegistered;
    private volatile AudioRecord recorder;
    private final Runnable startupTimeout;
    private final MediaProjection.Callback callback = new MediaProjection.Callback() {
        @Override public void onStop() { if (!stopped) interrupted.accept("projection_stopped"); }
    };

    SystemAudioCapture(String sessionId, MediaProjection projection, Runnable started, Consumer<String> interrupted) {
        this.sessionId = sessionId;
        this.projection = projection;
        this.started = started;
        this.interrupted = interrupted;
        startupTimeout = () -> {
            if (!stopped) {
                Log.e(TAG, "capture initialization exceeded 10000ms");
                interrupted.accept("initialization_timeout");
            }
        };
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    @RequiresPermission(Manifest.permission.RECORD_AUDIO)
    void start() {
        projection.registerCallback(callback, main);
        projectionCallbackRegistered = true;
        main.postDelayed(startupTimeout, 10_000);
        // Audio policy / AudioRecord initialization can block on an OEM audio service.
        // Keep consent callbacks, cancellation, and the WebView responsive while it runs.
        new Thread(this::capture, "appshell-system-audio").start();
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    @RequiresPermission(Manifest.permission.RECORD_AUDIO)
    private void capture() {
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO);
        long startedAt = SystemClock.elapsedRealtime();
        AudioRecord input = null;
        try {
            input = createRecorder();
            if (stopped) return;
            input.startRecording();
            if (input.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                throw new IllegalStateException("Audio capture did not start");
            }
            // AudioRecord.startRecording/stop share an internal lock. Publish only
            // after startup, so a timed-out start cannot block the UI through stop().
            synchronized (this) {
                if (stopped) return;
                recorder = input;
            }
            Log.i(TAG, "capture initialized in " + (SystemClock.elapsedRealtime() - startedAt) + "ms");
            main.post(() -> {
                main.removeCallbacks(startupTimeout);
                if (!stopped) started.run();
            });
            read(input);
        } catch (RuntimeException error) {
            if (!stopped) {
                Log.e(TAG, "capture failed", error);
                main.post(() -> { if (!stopped) interrupted.accept("capture_failed"); });
            }
        } finally {
            // The reader owns release, including an initialization that finishes after cancel.
            synchronized (this) {
                recorder = null;
            }
            if (input != null) input.release();
        }
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    @RequiresPermission(Manifest.permission.RECORD_AUDIO)
    private AudioRecord createRecorder() {
        AudioPlaybackCaptureConfiguration capture = new AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .build();
        int minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minimum <= 0) throw new IllegalStateException("Unsupported audio format");
        AudioRecord input = new AudioRecord.Builder()
            .setAudioFormat(new AudioFormat.Builder().setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setBufferSizeInBytes(Math.max(minimum * 2, CHUNK_SAMPLES * 4))
            .setAudioPlaybackCaptureConfig(capture).build();
        if (input.getState() != AudioRecord.STATE_INITIALIZED) {
            input.release();
            throw new IllegalStateException("Audio capture unavailable");
        }
        return input;
    }

    private void read(AudioRecord input) {
        short[] samples = new short[CHUNK_SAMPLES];
        int peak = 0;
        int nonzeroSamples = 0;
        while (!stopped) {
            int count = input.read(samples, 0, samples.length, AudioRecord.READ_BLOCKING);
            if (stopped) return;
            if (count <= 0 || sequence - acknowledged.get() >= 50) {
                // Bound the bridge queue to five seconds if the WebView stops consuming audio.
                String reason = count <= 0 ? "audio_read_failed" : "bridge_backpressure";
                Log.e(TAG, reason + " read=" + count + " pending=" + (sequence - acknowledged.get()));
                main.post(() -> { if (!stopped) interrupted.accept(reason); });
                return;
            }
            byte[] bytes = pcmBytes(samples, count);
            int sent = ++sequence;
            for (int index = 0; index < count; index++) {
                int amplitude = Math.abs((int) samples[index]);
                peak = Math.max(peak, amplitude);
                if (amplitude != 0) nonzeroSamples++;
            }
            if (sent == 1 || sent % 100 == 0) {
                // Signal statistics only; never log PCM or recognized content.
                Log.i(TAG, "pcm sequence=" + sent + " peak=" + peak + " nonzero=" + nonzeroSamples);
                peak = 0;
                nonzeroSamples = 0;
            }
            String pcm = Base64.encodeToString(bytes, Base64.NO_WRAP);
            main.post(() -> { if (!stopped) SystemAudioPlugin.data(sessionId, pcm, sent); });
        }
    }

    static byte[] pcmBytes(short[] samples, int count) {
        byte[] bytes = new byte[count * 2];
        for (int i = 0; i < count; i++) {
            bytes[i * 2] = (byte) samples[i];
            bytes[i * 2 + 1] = (byte) (samples[i] >> 8);
        }
        return bytes;
    }

    void acknowledge(int received) {
        if (received > 0 && received <= sequence) acknowledged.accumulateAndGet(received, Math::max);
    }

    void stop() {
        if (stopped) return;
        stopped = true;
        synchronized (this) {
            if (recorder != null) {
                try { recorder.stop(); } catch (RuntimeException ignored) { }
            }
        }
        main.removeCallbacksAndMessages(null);
        if (projectionCallbackRegistered) {
            projectionCallbackRegistered = false;
            try { projection.unregisterCallback(callback); } catch (RuntimeException ignored) { }
        }
        // Consent can be revoked concurrently by the system. stop() is cleanup and must
        // not crash the service merely because MediaProjection has already terminated.
        try { projection.stop(); } catch (RuntimeException ignored) { }
    }
}
