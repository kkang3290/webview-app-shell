package org.appshell;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import com.getcapacitor.PluginCall;
import java.lang.ref.WeakReference;
import java.lang.reflect.Field;
import org.junit.Test;

public class SystemAudioCaptureTest {
    @Test
    public void lateNativeInitializationCannotResolveOrFailTheNextSession() throws Exception {
        SystemAudioPlugin plugin = new SystemAudioPlugin();
        Field active = SystemAudioPlugin.class.getDeclaredField("active");
        Field session = SystemAudioPlugin.class.getDeclaredField("sessionId");
        Field pending = SystemAudioPlugin.class.getDeclaredField("pending");
        active.setAccessible(true);
        session.setAccessible(true);
        pending.setAccessible(true);
        // The stale callback must never touch the call, so no Android/JSObject mock is needed.
        Class<?> unsafeClass = Class.forName("sun.misc.Unsafe");
        Field unsafeField = unsafeClass.getDeclaredField("theUnsafe");
        unsafeField.setAccessible(true);
        PluginCall nextCall = (PluginCall) unsafeClass.getMethod("allocateInstance", Class.class)
            .invoke(unsafeField.get(null), PluginCall.class);
        active.set(null, new WeakReference<>(plugin));
        session.set(plugin, "next");
        pending.set(plugin, nextCall);
        try {
            SystemAudioPlugin.started("cancelled");
            SystemAudioPlugin.failed("cancelled", "interrupted");
            assertSame(nextCall, pending.get(plugin));
            assertEquals("next", session.get(plugin));
        } finally {
            active.set(null, new WeakReference<>(null));
        }
    }

    @Test
    public void pcmUsesSignedLittleEndianAndOnlyTheSamplesRead() {
        assertArrayEquals(new byte[] {0, -128, -1, 127, -1, -1, 0, 0},
            SystemAudioCapture.pcmBytes(new short[] {-32768, 32767, -1, 0, 42}, 4));
    }

    @Test
    public void staleSessionCannotOwnANewCapture() throws Exception {
        SystemAudioPlugin plugin = new SystemAudioPlugin();
        Field active = SystemAudioPlugin.class.getDeclaredField("active");
        active.setAccessible(true);
        active.set(null, new WeakReference<>(plugin));
        Field session = SystemAudioPlugin.class.getDeclaredField("sessionId");
        session.setAccessible(true);
        try {
            session.set(plugin, "first");
            assertTrue(SystemAudioPlugin.isActive("first"));
            session.set(plugin, "second");
            assertFalse(SystemAudioPlugin.isActive("first"));
            assertFalse(SystemAudioPlugin.isActive(null));
            assertTrue(SystemAudioPlugin.isActive("second"));
            session.set(plugin, null);
            assertFalse(SystemAudioPlugin.isActive("second"));
        } finally {
            active.set(null, new WeakReference<>(null));
        }
    }

}
