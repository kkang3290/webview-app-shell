package org.appshell;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class AppControlPluginTest {
    @Test
    public void imageFilenameStaysInPngAndDropsPaths() {
        assertEquals("summary.png", AppControlPlugin.imageFilename("../summary"));
        assertEquals("summary.png", AppControlPlugin.imageFilename("summary.png"));
    }

    @Test
    public void imageFilenameFallsBackAndCapsLength() {
        assertEquals(AppShellConfig.APP_NAME + "-summary.png", AppControlPlugin.imageFilename(null));
        StringBuilder longName = new StringBuilder();
        for (int i = 0; i < 200; i++) longName.append('x');
        String filename = AppControlPlugin.imageFilename(longName.toString());
        assertEquals(128, filename.length());
        assertEquals(true, filename.endsWith(".png"));
    }
}
