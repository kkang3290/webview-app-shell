package org.appshell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.List;

public class PermissionsPluginTest {
    private static final List<String> DECLARED = Arrays.asList("microphone", "notifications");

    @Test
    public void notificationsAndPhotosOnlyNeedRuntimeRequestOnSomeVersions() {
        assertFalse(PermissionsPlugin.needsRuntimeRequest("notifications", 32));
        assertTrue(PermissionsPlugin.needsRuntimeRequest("notifications", 33));
        assertTrue(PermissionsPlugin.needsRuntimeRequest("photos", 28));
        assertFalse(PermissionsPlugin.needsRuntimeRequest("photos", 29));
        assertTrue(PermissionsPlugin.needsRuntimeRequest("camera", 24));
    }

    @Test
    public void namesMustBeKnownAndDeclared() {
        assertEquals(Arrays.asList("microphone", "notifications"),
            PermissionsPlugin.parseNames(Arrays.asList("microphone", "notifications", "microphone"), DECLARED));
        assertThrows(IllegalArgumentException.class, () -> PermissionsPlugin.parseNames(Arrays.asList("camera"), DECLARED));
        assertThrows(IllegalArgumentException.class, () -> PermissionsPlugin.parseNames(Arrays.asList("contacts"), DECLARED));
        assertThrows(IllegalArgumentException.class, () -> PermissionsPlugin.parseNames(Arrays.asList(), DECLARED));
        assertThrows(IllegalArgumentException.class, () -> PermissionsPlugin.parseNames(null, DECLARED));
    }
}
