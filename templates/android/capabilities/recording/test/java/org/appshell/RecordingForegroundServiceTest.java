package org.appshell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.pm.ServiceInfo;
import android.os.Build;
import org.junit.Test;

public class RecordingForegroundServiceTest {
    @Test
    public void stoppingWithoutAnActiveServiceIsAnIdempotentNoOp() {
        assertFalse(RecordingForegroundService.stopKeepAliveIfActive());
    }

    @Test
    public void pendingStartCanBeCancelledBeforeServiceIsActive() {
        RecordingForegroundService.StartDemand demand = new RecordingForegroundService.StartDemand();

        demand.start();
        demand.stop();

        assertFalse(demand.isDesired());
        assertEquals(
            RecordingForegroundService.QueuedStartDisposition.ACKNOWLEDGE_AND_STOP,
            RecordingForegroundService.queuedStartDisposition(demand.isDesired(), false)
        );
    }

    @Test
    public void failedOlderStartCannotCancelANewerStart() {
        RecordingForegroundService.StartDemand demand = new RecordingForegroundService.StartDemand();
        long older = demand.start();
        demand.start();

        demand.fail(older);

        assertTrue(demand.isDesired());
        assertEquals(
            RecordingForegroundService.QueuedStartDisposition.START_REQUESTED_MODE,
            RecordingForegroundService.queuedStartDisposition(demand.isDesired(), false)
        );
    }

    @Test
    public void staleStartsUseTheirLegalForegroundServiceType() {
        assertEquals(
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            RecordingForegroundService.foregroundServiceType(Build.VERSION_CODES.UPSIDE_DOWN_CAKE, true, false)
        );
        assertEquals(
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            RecordingForegroundService.foregroundServiceType(Build.VERSION_CODES.UPSIDE_DOWN_CAKE, false, true)
        );
    }

    @Test
    public void staleSystemStartKeepsAnAlreadyActiveMicrophoneMode() {
        assertEquals(
            RecordingForegroundService.QueuedStartDisposition.ACKNOWLEDGE_AND_KEEP_ACTIVE_MODE,
            RecordingForegroundService.queuedStartDisposition(false, true)
        );
        assertEquals(
            RecordingForegroundService.QueuedStartDisposition.ACKNOWLEDGE_AND_STOP,
            RecordingForegroundService.queuedStartDisposition(false, false)
        );
    }

    @Test
    public void stoppingKeepAliveRetainsAnActiveSystemAudioCapture() {
        assertEquals(
            RecordingForegroundService.KeepAliveStopAction.KEEP_SYSTEM_AUDIO,
            RecordingForegroundService.keepAliveStopAction(true)
        );
        assertEquals(
            RecordingForegroundService.KeepAliveStopAction.STOP_SERVICE,
            RecordingForegroundService.keepAliveStopAction(false)
        );
    }

    @Test
    public void systemOnlyCaptureDoesNotClaimMicrophone() {
        assertEquals(
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            RecordingForegroundService.foregroundServiceType(Build.VERSION_CODES.UPSIDE_DOWN_CAKE, false, true)
        );
    }

    @Test
    public void mixedCaptureDeclaresBothActiveTypes() {
        assertEquals(
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                | ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            RecordingForegroundService.foregroundServiceType(Build.VERSION_CODES.UPSIDE_DOWN_CAKE, true, true)
        );
    }

    @Test
    public void serviceTypeRespectsPlatformAvailabilityAndActiveModes() {
        assertEquals(0, RecordingForegroundService.foregroundServiceType(Build.VERSION_CODES.P, true, true));
        assertEquals(
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            RecordingForegroundService.foregroundServiceType(Build.VERSION_CODES.Q, true, true)
        );
        assertEquals(
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            RecordingForegroundService.foregroundServiceType(Build.VERSION_CODES.R, true, false)
        );
        assertEquals(0, RecordingForegroundService.foregroundServiceType(Build.VERSION_CODES.R, false, false));
    }
}
