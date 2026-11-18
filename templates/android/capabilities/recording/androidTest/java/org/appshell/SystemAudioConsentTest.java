package org.appshell;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;

import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionConfig;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.SdkSuppress;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class SystemAudioConsentTest {
    @Test
    @SdkSuppress(minSdkVersion = Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    public void audioCaptureKeepsTheSystemAppOrDisplayChoice() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        MediaProjectionManager manager = context.getSystemService(MediaProjectionManager.class);
        Intent consent = SystemAudioPlugin.captureIntent(manager);
        Intent systemChoice = manager.createScreenCaptureIntent();
        assertEquals(systemChoice.getComponent(), consent.getComponent());
        assertEquals(systemChoice.getAction(), consent.getAction());
        Bundle extras = consent.getExtras();
        MediaProjectionConfig display = MediaProjectionConfig.createConfigForDefaultDisplay();
        assertFalse(extras != null && extras.keySet().stream().map(extras::get).anyMatch(display::equals));
    }
}
