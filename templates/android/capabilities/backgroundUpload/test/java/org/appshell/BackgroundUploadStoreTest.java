package org.appshell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Properties;

public class BackgroundUploadStoreTest {
    private static void delete(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    @Test
    public void onlyFilesInsideAppStorageCanBeUploaded() throws Exception {
        File app = Files.createTempDirectory("appshell-app-").toFile();
        File outside = Files.createTempFile("appshell-outside-", ".txt").toFile();
        try {
            File inside = new File(app, "files/rec.m4a");
            //noinspection ResultOfMethodCallIgnored
            inside.getParentFile().mkdirs();
            Files.write(inside.toPath(), new byte[] { 1 });
            assertEquals(inside.getCanonicalFile(),
                BackgroundUploadStore.resolveSource(inside.getPath(), Arrays.asList(app, null)));
            assertThrows(IOException.class, () ->
                BackgroundUploadStore.resolveSource(outside.getPath(), Arrays.asList(app)));
            assertThrows(IOException.class, () ->
                BackgroundUploadStore.resolveSource(app.getPath() + "/files/../../" + outside.getName(), Arrays.asList(app)));
            assertThrows(IOException.class, () ->
                BackgroundUploadStore.resolveSource(new File(app, "files/missing").getPath(), Arrays.asList(app)));
        } finally {
            delete(app);
            //noinspection ResultOfMethodCallIgnored
            outside.delete();
        }
    }

    @Test
    public void recordsRoundTripWithHeadersAndSortByCreation() throws Exception {
        File root = Files.createTempDirectory("appshell-uploads-").toFile();
        try {
            Properties second = new Properties();
            second.setProperty("id", "b");
            second.setProperty("createdAt", "2026-11-10T02:00:00.000Z");
            Properties first = new Properties();
            first.setProperty("id", "a");
            first.setProperty("createdAt", "2026-11-10T01:00:00.000Z");
            first.setProperty("header.Content-Type", "audio/mp4");
            BackgroundUploadStore.save(root, second);
            BackgroundUploadStore.save(root, first);
            assertEquals("a", BackgroundUploadStore.list(root).get(0).getProperty("id"));
            assertEquals("audio/mp4", BackgroundUploadStore.headers(BackgroundUploadStore.load(root, "a")).get("Content-Type"));
            BackgroundUploadStore.delete(root, "a");
            assertEquals(1, BackgroundUploadStore.list(root).size());
            assertThrows(IllegalArgumentException.class, () -> BackgroundUploadStore.recordFile(root, "../x"));
        } finally {
            delete(root);
        }
    }

    @Test
    public void onlyTransientFailuresAreRetried() {
        assertTrue(BackgroundUploadStore.retryable(500));
        assertTrue(BackgroundUploadStore.retryable(503));
        assertTrue(BackgroundUploadStore.retryable(429));
        assertFalse(BackgroundUploadStore.retryable(403));
        assertFalse(BackgroundUploadStore.retryable(404));
        assertTrue(BackgroundUploadStore.validHeaderName("x-oss-meta-id"));
        assertFalse(BackgroundUploadStore.validHeaderName("Content-Length"));
        assertFalse(BackgroundUploadStore.validHeaderName("bad header"));
        assertEquals("audio/mp4", BackgroundUploadStore.contentType(java.util.Collections.singletonMap("content-type", "audio/mp4")));
        assertEquals(null, BackgroundUploadStore.contentType(java.util.Collections.singletonMap("x-a", "1")));
    }

    @Test
    public void releaseBuildsOnlyUploadOverHttps() {
        assertTrue(BackgroundUploadPlugin.allowedUrl("https://oss.example.com/a?sig=1", false));
        assertFalse(BackgroundUploadPlugin.allowedUrl("http://127.0.0.1:19196/a", false));
        assertTrue(BackgroundUploadPlugin.allowedUrl("http://127.0.0.1:19196/a", true));
        assertFalse(BackgroundUploadPlugin.allowedUrl("http://example.com/a", true));
        assertFalse(BackgroundUploadPlugin.allowedUrl("http://127.0.0.1.evil.com/a", true));
    }
}
