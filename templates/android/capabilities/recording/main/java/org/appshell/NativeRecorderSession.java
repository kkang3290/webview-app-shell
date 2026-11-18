package org.appshell;

import android.annotation.SuppressLint;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.media.MediaRecorder;
import android.util.Log;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.Properties;
import java.util.TimeZone;

/**
 * 一次原生录音：AudioRecord 采 16 位单声道 PCM，按 chunkMs 切段落盘并回调，
 * 同时用 MediaCodec(AAC-LC) + MediaMuxer 写完整的 m4a 原件。
 * 采集线程独占 AudioRecord / 编码器；对外方法加锁，只改状态、启停线程。
 */
final class NativeRecorderSession {
    interface Listener {
        void onChunk(NativeRecorderSession session, int seq, int startMs, int durationMs, byte[] pcm, int length);

        void onFailure(NativeRecorderSession session, String reason);
    }

    private static final String TAG = "AppShell/NativeRecorder";
    private static final int FRAME_MS = 20;

    final String id;
    final File dir;
    final int sampleRate;
    private final int chunkBytes;
    private final String label;
    private final String startedAt;
    private final Listener listener;

    private final Object lock = new Object();
    private AudioRecord record;
    private Thread thread;
    private volatile boolean running;
    private volatile boolean silenced;
    private AudioDeviceInfo preferredDevice;
    private int audioSource = MediaRecorder.AudioSource.MIC;

    // 以下只在采集线程或停线程之后访问
    private final byte[] pending;
    private int pendingLength;
    private int lastSeq;
    private long framesWritten;
    private long framesPublished;
    private int interruptions;
    private MediaCodec encoder;
    private MediaMuxer muxer;
    private int track = -1;
    private boolean muxerStarted;
    private final MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();

    NativeRecorderSession(File root, int sampleRate, int chunkMs, String label, Listener listener) throws IOException {
        this.dir = NativeRecorderStore.createSession(root);
        this.id = dir.getName();
        this.sampleRate = sampleRate;
        this.chunkBytes = sampleRate * chunkMs / 1000 * 2;
        this.pending = new byte[chunkBytes];
        this.label = label;
        this.listener = listener;
        SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT);
        iso.setTimeZone(TimeZone.getTimeZone("UTC"));
        this.startedAt = iso.format(new Date());
        openEncoder();
        writeMeta("recording");
    }

    int audioSessionId() {
        synchronized (lock) {
            return record == null ? 0 : record.getAudioSessionId();
        }
    }

    boolean isRunning() {
        return running;
    }

    /** 指定输入设备（下次 start 生效）。蓝牙麦克风走通话链路，音源要换成 VOICE_COMMUNICATION。 */
    void setInput(AudioDeviceInfo device, boolean communication) {
        synchronized (lock) {
            preferredDevice = device;
            audioSource = communication ? MediaRecorder.AudioSource.VOICE_COMMUNICATION : MediaRecorder.AudioSource.MIC;
        }
    }

    /** 当前实际录音的设备 ID（系统可能没按偏好走），没有在录时返回 0。 */
    int routedDeviceId() {
        synchronized (lock) {
            if (record == null) return 0;
            AudioDeviceInfo routed = record.getRoutedDevice();
            return routed == null ? 0 : routed.getId();
        }
    }

    /** 系统把我们的采集静音（来电、其他 App 抢麦）时由插件置位；期间产出的是静音帧，照常计时。 */
    void setSilenced(boolean value) {
        if (value && !silenced) {
            synchronized (lock) {
                interruptions++;
            }
        }
        silenced = value;
    }

    @SuppressLint("MissingPermission") // 插件在调用前已检查 RECORD_AUDIO
    void start() throws IOException {
        synchronized (lock) {
            if (record != null) return;
            int min = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (min <= 0) throw new IOException("sample rate " + sampleRate + " not supported by this device");
            AudioRecord created = new AudioRecord(audioSource, sampleRate,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min * 2, chunkBytes));
            if (created.getState() != AudioRecord.STATE_INITIALIZED) {
                created.release();
                throw new IOException("AudioRecord init failed");
            }
            if (preferredDevice != null) created.setPreferredDevice(preferredDevice);
            created.startRecording();
            if (created.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                created.release();
                throw new IOException("microphone is in use by another app");
            }
            record = created;
            running = true;
            thread = new Thread(this::capture, "appshell-native-recorder");
            thread.start();
        }
        writeMeta("recording");
    }

    void pause() {
        stopCapture();
        writeMeta("paused");
    }

    /** 停止采集，补发最后不足一段的数据，收尾 m4a。返回摘要所需的数值。 */
    Properties finish() {
        stopCapture();
        drainEncoder(true);
        if (muxer != null) {
            try {
                if (muxerStarted) muxer.stop();
            } catch (IllegalStateException e) {
                Log.w(TAG, "muxer stop failed", e);
            }
            muxer.release();
            muxer = null;
        }
        if (encoder != null) {
            encoder.release();
            encoder = null;
        }
        writeMeta("stopped");
        return meta("stopped");
    }

    Properties describe(String state) {
        return meta(state);
    }

    /** 采集线程因设备错误自行退出时 running 已是 false，但 AudioRecord 仍要在这里释放。 */
    private void stopCapture() {
        Thread joining;
        synchronized (lock) {
            if (record == null) return;
            running = false;
            joining = thread;
        }
        if (joining != null && joining != Thread.currentThread()) {
            try {
                joining.join(2000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        synchronized (lock) {
            if (record != null) {
                try {
                    record.stop();
                } catch (IllegalStateException ignored) {
                    // 已经停了
                }
                record.release();
                record = null;
            }
            thread = null;
        }
        flush();
    }

    private void capture() {
        byte[] frame = new byte[sampleRate * FRAME_MS / 1000 * 2];
        AudioRecord source;
        synchronized (lock) {
            source = record;
        }
        while (running) {
            int read = source.read(frame, 0, frame.length);
            if (read < 0) {
                Log.w(TAG, "AudioRecord.read failed: " + read);
                running = false;
                listener.onFailure(this, "device-error");
                break;
            }
            if (read == 0) continue;
            append(frame, read);
        }
    }

    private void append(byte[] data, int length) {
        encode(data, length);
        framesWritten += length / 2;
        int offset = 0;
        while (offset < length) {
            int take = Math.min(length - offset, chunkBytes - pendingLength);
            System.arraycopy(data, offset, pending, pendingLength, take);
            pendingLength += take;
            offset += take;
            if (pendingLength == chunkBytes) publish();
        }
    }

    private void flush() {
        if (pendingLength > 0) publish();
    }

    private void publish() {
        int length = pendingLength;
        pendingLength = 0;
        int seq = ++lastSeq;
        int durationMs = (int) ((length / 2) * 1000L / sampleRate);
        int startMs = (int) (framesPublished * 1000L / sampleRate);
        framesPublished += length / 2;
        byte[] copy = java.util.Arrays.copyOf(pending, length);
        try {
            // 先落盘再回调：JS 收不到（页面被挂起）也能事后补拉。
            NativeRecorderStore.writeChunk(dir, seq, copy, length);
            writeMeta(running ? "recording" : "paused");
        } catch (IOException e) {
            Log.w(TAG, "chunk write failed", e);
        }
        listener.onChunk(this, seq, startMs, durationMs, copy, length);
    }

    private void writeMeta(String state) {
        try {
            NativeRecorderStore.writeMeta(dir, meta(state));
        } catch (IOException e) {
            Log.w(TAG, "meta write failed", e);
        }
    }

    private Properties meta(String state) {
        Properties meta = new Properties();
        meta.setProperty("sessionId", id);
        meta.setProperty("label", label);
        meta.setProperty("state", state);
        meta.setProperty("lastSeq", Integer.toString(lastSeq));
        meta.setProperty("sampleRate", Integer.toString(sampleRate));
        meta.setProperty("startedAt", startedAt);
        meta.setProperty("durationMs", Long.toString(framesWritten * 1000L / sampleRate));
        meta.setProperty("interruptions", Integer.toString(interruptions));
        meta.setProperty("filePath", new File(dir, NativeRecorderStore.ARCHIVE_FILE).getAbsolutePath());
        return meta;
    }

    // ─── AAC 原件 ────────────────────────────────────────────────

    private void openEncoder() throws IOException {
        MediaFormat format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, 1);
        format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        format.setInteger(MediaFormat.KEY_BIT_RATE, sampleRate >= 24000 ? 64000 : 32000);
        format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, sampleRate * FRAME_MS / 1000 * 2 * 4);
        encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        encoder.start();
        muxer = new MediaMuxer(new File(dir, NativeRecorderStore.ARCHIVE_FILE).getAbsolutePath(),
            MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
    }

    private void encode(byte[] data, int length) {
        if (encoder == null) return;
        int offset = 0;
        while (offset < length) {
            int index = encoder.dequeueInputBuffer(10_000);
            if (index < 0) {
                drainEncoder(false);
                continue;
            }
            ByteBuffer input = encoder.getInputBuffer(index);
            if (input == null) return;
            input.clear();
            int take = Math.min(input.remaining(), length - offset);
            input.put(data, offset, take);
            long ptsUs = (framesWritten + offset / 2) * 1_000_000L / sampleRate;
            encoder.queueInputBuffer(index, 0, take, ptsUs, 0);
            offset += take;
        }
        drainEncoder(false);
    }

    private void drainEncoder(boolean endOfStream) {
        if (encoder == null) return;
        if (endOfStream) {
            int index = encoder.dequeueInputBuffer(10_000);
            if (index >= 0) {
                long ptsUs = framesWritten * 1_000_000L / sampleRate;
                encoder.queueInputBuffer(index, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
            }
        }
        for (int attempts = 0; attempts < 200; attempts++) {
            int index = encoder.dequeueOutputBuffer(info, endOfStream ? 10_000 : 0);
            if (index == MediaCodec.INFO_TRY_AGAIN_LATER) {
                if (!endOfStream) return;
                continue;
            }
            if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                track = muxer.addTrack(encoder.getOutputFormat());
                muxer.start();
                muxerStarted = true;
                continue;
            }
            if (index < 0) continue;
            ByteBuffer output = encoder.getOutputBuffer(index);
            boolean config = (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0;
            if (output != null && muxerStarted && !config && info.size > 0) {
                output.position(info.offset);
                output.limit(info.offset + info.size);
                muxer.writeSampleData(track, output, info);
            }
            encoder.releaseOutputBuffer(index, false);
            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return;
        }
    }
}
