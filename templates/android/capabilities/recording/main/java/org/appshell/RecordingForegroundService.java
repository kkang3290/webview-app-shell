package org.appshell;

import android.Manifest;
import android.content.pm.PackageManager;
import androidx.core.content.ContextCompat;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/** Shared foreground lifetime for WebView microphone and native playback capture. */
public class RecordingForegroundService extends Service {
    static final String ACTION_START = "org.appshell.recording.START";

    static final String ACTION_SYSTEM_START = "org.appshell.recording.SYSTEM_START";
    private static final StartDemand KEEP_ALIVE_DEMAND = new StartDemand();
    private static volatile RecordingForegroundService active;
    private volatile SystemAudioCapture systemCapture;
    private volatile String systemSessionId;
    private boolean keepAlive;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    enum KeepAliveStopAction {
        STOP_SERVICE,
        KEEP_SYSTEM_AUDIO
    }

    enum QueuedStartDisposition {
        START_REQUESTED_MODE,
        ACKNOWLEDGE_AND_STOP,
        ACKNOWLEDGE_AND_KEEP_ACTIVE_MODE
    }

    /** Process-local desired state closes the gap before Service.onStartCommand runs. */
    static final class StartDemand {
        private long generation;
        private boolean desired;

        synchronized long start() {
            desired = true;
            return ++generation;
        }

        synchronized void stop() {
            desired = false;
            generation++;
        }

        synchronized void fail(long failedGeneration) {
            if (generation != failedGeneration) return;
            desired = false;
            generation++;
        }

        synchronized boolean isDesired() {
            return desired;
        }
    }

    private static final String CHANNEL_ID = "recording";
    private static final int NOTIFICATION_ID = 1001;
    // JS 停不下来（WebView 崩溃等）时的兜底：别让 wake lock 永远拿着
    private static final long WAKE_LOCK_TIMEOUT_MS = 6 * 60 * 60 * 1000L;

    private PowerManager.WakeLock wakeLock;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        active = this;
        String action = intent == null ? null : intent.getAction();
        if (ACTION_SYSTEM_START.equals(action)) {
            startSystemAudio(intent);
        } else if (ACTION_START.equals(action)) {
            startKeepAlive();
        } else {
            acknowledgeUnknownStart();
        }
        return START_NOT_STICKY;
    }

    static long requestKeepAliveStart() {
        return KEEP_ALIVE_DEMAND.start();
    }

    static void failKeepAliveStart(long generation) {
        KEEP_ALIVE_DEMAND.fail(generation);
    }

    /** Stop only an already-running keepalive; never create a service just to stop it. */
    static boolean stopKeepAliveIfActive() {
        KEEP_ALIVE_DEMAND.stop();
        RecordingForegroundService service = active;
        if (service == null) return false;
        service.runOnServiceThread(service::stopKeepAliveOnServiceThread);
        return true;
    }

    private void startKeepAlive() {
        QueuedStartDisposition disposition = queuedStartDisposition(
            KEEP_ALIVE_DEMAND.isDesired(), systemCapture != null || systemSessionId != null);
        if (disposition != QueuedStartDisposition.START_REQUESTED_MODE) {
            acknowledgeStaleStart(true, false, disposition);
            return;
        }
        keepAlive = true;
        startAsForeground();
        acquireWakeLock();
    }

    private void acknowledgeStaleStart(
        boolean microphoneRequest,
        boolean systemAudioRequest,
        QueuedStartDisposition disposition
    ) {
        // A queued startForegroundService still needs one legal promotion after
        // STOP wins. Android 14 forbids type NONE, so acknowledge the exact type
        // represented by the accepted request, then restore any real active mode.
        try {
            startAsForeground(foregroundServiceType(
                Build.VERSION.SDK_INT, microphoneRequest, systemAudioRequest));
        } catch (RuntimeException error) {
            // Permission or while-in-use eligibility can disappear while the start
            // is queued. The legal promotion above is the primary path; stop the
            // orphan promptly and leave an explicit diagnostic if Android rejects it.
            Log.w("AppShell/Recording", "stale foreground start could not be promoted", error);
        }
        if (disposition == QueuedStartDisposition.ACKNOWLEDGE_AND_STOP) {
            stopSelf();
        } else {
            startAsForeground();
        }
    }

    static QueuedStartDisposition queuedStartDisposition(boolean requestDesired, boolean otherModeActive) {
        if (requestDesired) return QueuedStartDisposition.START_REQUESTED_MODE;
        return otherModeActive
            ? QueuedStartDisposition.ACKNOWLEDGE_AND_KEEP_ACTIVE_MODE
            : QueuedStartDisposition.ACKNOWLEDGE_AND_STOP;
    }

    private void acknowledgeUnknownStart() {
        if (keepAlive || systemCapture != null) {
            startAsForeground();
            return;
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED) {
            acknowledgeStaleStart(
                true, false, QueuedStartDisposition.ACKNOWLEDGE_AND_STOP);
            return;
        }
        Log.w("AppShell/Recording", "unknown foreground start without a legal service type");
        stopSelf();
    }

    private void runOnServiceThread(Runnable action) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            if (active == this) action.run();
            return;
        }
        mainHandler.post(() -> {
            if (active == this) action.run();
        });
    }

    private void stopKeepAliveOnServiceThread() {
        keepAlive = false;
        if (keepAliveStopAction(systemCapture != null) == KeepAliveStopAction.STOP_SERVICE) {
            stopSelf();
            return;
        }
        // A system-only capture does not use the microphone FGS type. Keeping it
        // would re-apply the Android 14 while-in-use microphone restriction after
        // the Web microphone has already stopped or the screen has locked.
        startAsForeground();
    }

    static KeepAliveStopAction keepAliveStopAction(boolean systemAudioActive) {
        return systemAudioActive ? KeepAliveStopAction.KEEP_SYSTEM_AUDIO : KeepAliveStopAction.STOP_SERVICE;
    }

    private void startSystemAudio(Intent intent) {
        String id = intent.getStringExtra("sessionId");
        QueuedStartDisposition disposition = queuedStartDisposition(
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && SystemAudioPlugin.isActive(id),
            keepAlive || systemCapture != null
        );
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                || disposition != QueuedStartDisposition.START_REQUESTED_MODE) {
            acknowledgeStaleStart(false, true, disposition);
            return;
        }
        if (systemCapture != null) {
            SystemAudioPlugin.failed(id, "busy");
            return;
        }
        systemSessionId = id;
        try {
            // Android 14+: consent first, then the typed foreground service, then projection.
            startAsForeground();
            acquireWakeLock();
            MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
            Intent consent = intent.getParcelableExtra("resultData");
            if (manager == null || consent == null) throw new IllegalStateException("Missing projection consent");
            MediaProjection projection = manager.getMediaProjection(intent.getIntExtra("resultCode", 0), consent);
            if (projection == null) throw new IllegalStateException("Projection unavailable");
            systemCapture = new SystemAudioCapture(id, projection, () -> SystemAudioPlugin.started(id), reason -> {
                SystemAudioPlugin.failed(id, reason);
                stopSystemAudio(id);
            });
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                throw new SecurityException("Audio permission revoked");
            }
            systemCapture.start();
        } catch (RuntimeException error) {
            SystemAudioPlugin.failed(id, "failed");
            stopSystemAudio(id);
        }
    }

    static void acknowledgeSystemAudio(String id, int sequence) {
        RecordingForegroundService service = active;
        if (service == null || id == null || !id.equals(service.systemSessionId)) return;
        SystemAudioCapture capture = service.systemCapture;
        if (capture != null) capture.acknowledge(sequence);
    }

    static void stopSystemAudio(String id) {
        RecordingForegroundService service = active;
        if (service == null || id == null || !id.equals(service.systemSessionId)) return;
        service.systemSessionId = null;
        SystemAudioCapture capture = service.systemCapture;
        service.systemCapture = null;
        if (capture != null) capture.stop();
        if (!service.keepAlive) {
            service.stopSelf();
        } else {
            // Drop mediaProjection as soon as native playback capture ends. The service
            // may still be keeping the Web microphone alive, so keep only its real type.
            service.startAsForeground();
        }
    }

    @Override
    public void onDestroy() {
        if (systemSessionId != null) SystemAudioPlugin.failed(systemSessionId, "interrupted");
        if (systemCapture != null) systemCapture.stop();
        systemCapture = null;
        systemSessionId = null;
        if (active == this) active = null;
        mainHandler.removeCallbacksAndMessages(null);
        releaseWakeLock();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    private void startAsForeground() {
        startAsForeground(foregroundServiceType(Build.VERSION.SDK_INT, keepAlive, systemSessionId != null));
    }

    private void startAsForeground(int type) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.recording_notification_channel),
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }

        Intent openApp = new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
            this, 0, openApp, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.recording_notification_title))
            .setContentText(getString(R.string.recording_notification_text))
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();

        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type);
    }

    static int foregroundServiceType(int sdkInt, boolean microphoneActive, boolean systemAudioActive) {
        int type = 0;
        if (sdkInt >= Build.VERSION_CODES.R && microphoneActive) {
            type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        }
        if (sdkInt >= Build.VERSION_CODES.Q && systemAudioActive) {
            type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
        }
        return type;
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (powerManager == null) return;
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "appshell:recording");
        wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }
}
