package org.appshell;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.Properties;

public class NativeRecorderStoreTest {
    private static File tempRoot() throws IOException {
        return Files.createTempDirectory("appshell-recorder-").toFile();
    }

    private static Properties meta(int lastSeq) {
        Properties meta = new Properties();
        meta.setProperty("sessionId", "x");
        meta.setProperty("lastSeq", Integer.toString(lastSeq));
        meta.setProperty("sampleRate", "16000");
        return meta;
    }

    @Test
    public void sessionIdMustBeUuidSoWebCannotEscapeTheRoot() throws Exception {
        File root = tempRoot();
        try {
            File dir = NativeRecorderStore.createSession(root);
            assertEquals(dir, NativeRecorderStore.sessionDir(root, dir.getName()));
            assertEquals(dir, NativeRecorderStore.sessionDir(root, dir.getName().toLowerCase()));
            assertThrows(IOException.class, () -> NativeRecorderStore.sessionDir(root, "../etc"));
            assertThrows(IOException.class, () -> NativeRecorderStore.sessionDir(root, null));
            assertThrows(IOException.class, () ->
                NativeRecorderStore.sessionDir(root, "00000000-0000-4000-8000-000000000000"));
        } finally {
            NativeRecorderStore.deleteRecursively(root);
        }
    }

    @Test
    public void readChunksPagesInOrderAndAckDeletesOnlyConfirmedChunks() throws Exception {
        File root = tempRoot();
        try {
            File dir = NativeRecorderStore.createSession(root);
            for (int seq = 1; seq <= 5; seq++) NativeRecorderStore.writeChunk(dir, seq, new byte[] { (byte) seq, 0 }, 2);
            NativeRecorderStore.writeMeta(dir, meta(5));

            NativeRecorderStore.Page first = NativeRecorderStore.readChunks(dir, 0, 2);
            assertEquals(2, first.chunks.size());
            assertEquals(1, first.chunks.get(0).seq);
            assertTrue(first.hasMore);
            assertEquals(16000, first.sampleRate);

            NativeRecorderStore.Page rest = NativeRecorderStore.readChunks(dir, 2, 10);
            assertEquals(3, rest.chunks.size());
            assertFalse(rest.hasMore);
            assertArrayEquals(new byte[] { 5, 0 }, rest.chunks.get(2).pcm);

            assertEquals(3, NativeRecorderStore.deleteChunks(dir, 3));
            NativeRecorderStore.Page after = NativeRecorderStore.readChunks(dir, 0, 10);
            assertEquals(2, after.chunks.size());
            assertEquals(4, after.chunks.get(0).seq);
            assertTrue(new File(dir, NativeRecorderStore.META_FILE).isFile());
        } finally {
            NativeRecorderStore.deleteRecursively(root);
        }
    }

    @Test
    public void listSkipsHalfCreatedSessions() throws Exception {
        File root = tempRoot();
        try {
            File done = NativeRecorderStore.createSession(root);
            NativeRecorderStore.writeMeta(done, meta(3));
            NativeRecorderStore.createSession(root);
            assertEquals(1, NativeRecorderStore.list(root).size());
            assertTrue(NativeRecorderStore.list(root).get(0).getProperty("filePath").endsWith("recording.m4a"));
        } finally {
            NativeRecorderStore.deleteRecursively(root);
        }
    }

    @Test
    public void levelIsPeakOfSigned16BitLittleEndian() {
        byte[] pcm = { 0x00, 0x40, 0x00, (byte) 0x80, 0x10, 0x00 };
        assertEquals(1.0, NativeRecorderStore.level(pcm, pcm.length), 0.0001);
        assertEquals(0.5, NativeRecorderStore.level(pcm, 2), 0.0001);
        assertEquals(0.0, NativeRecorderStore.level(new byte[4], 4), 0.0);
    }
}
