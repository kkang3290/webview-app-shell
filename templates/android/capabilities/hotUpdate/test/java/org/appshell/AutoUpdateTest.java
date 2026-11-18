package org.appshell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AutoUpdateTest {
    @Test
    public void versionsCompareNumericallyAndRejectMalformed() {
        assertTrue(AutoUpdate.isNewer("1.0.10", "1.0.9"));
        assertFalse(AutoUpdate.isNewer("1.0.9", "1.0.9"));
        assertFalse(AutoUpdate.isNewer("1.0.x", "1.0.1"));
        assertFalse(AutoUpdate.isNewer("1.0.2", null));
    }

    @Test
    public void latestResponseFollowsProtojsonDefaults() {
        AutoUpdate.Latest latest = AutoUpdate.parseLatest("{\"platform\":\"android-webbundle\",\"version\":\"1.0.1500\",\"url\":\"https://a/b\"}");
        assertEquals("1.0.1500", latest.version);
        assertEquals("https://a/b", latest.url);
        assertNull(AutoUpdate.parseLatest("{\"platform\":\"android-webbundle\"}"));
        assertNull(AutoUpdate.parseLatest("{\"version\":\"latest\",\"url\":\"https://a\"}"));
    }

    @Test
    public void downloadUrlsMustBeHttps() {
        assertEquals("https://api.test/v1/x", AutoUpdate.resolveUrl("/v1/x", "https://api.test/api/v1/app/releases/latest"));
        assertNull(AutoUpdate.resolveUrl("http://evil.test/x", "https://api.test/latest"));
    }

    @Test
    public void checksumAndBadListParsing() {
        String hex = "ab".repeat(32);
        assertEquals(hex, AutoUpdate.parseSha256(hex.toUpperCase() + "  bundle.zip\n"));
        assertNull(AutoUpdate.parseSha256("not a hash"));
        String bad = AutoUpdate.addBad(AutoUpdate.addBad("", "1.0.2"), "1.0.3");
        assertTrue(AutoUpdate.isBad(bad, "1.0.2"));
        assertTrue(AutoUpdate.isBad(bad, "1.0.3"));
        assertFalse(AutoUpdate.isBad(bad, "1.0.4"));
        assertEquals(bad, AutoUpdate.addBad(bad, "garbage"));
    }
}
