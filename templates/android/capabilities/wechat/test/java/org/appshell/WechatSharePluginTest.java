package org.appshell;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import com.tencent.mm.opensdk.modelmsg.WXMiniProgramObject;

import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.Test;

public class WechatSharePluginTest {
    @Test
    public void mapsBackendVersionsToWechatTypes() {
        assertEquals(WXMiniProgramObject.MINIPTOGRAM_TYPE_RELEASE,
            WechatSharePlugin.miniProgramType("release"));
        assertEquals(WXMiniProgramObject.MINIPROGRAM_TYPE_PREVIEW,
            WechatSharePlugin.miniProgramType("trial"));
        assertEquals(WXMiniProgramObject.MINIPROGRAM_TYPE_TEST,
            WechatSharePlugin.miniProgramType("develop"));
        assertThrows(IllegalArgumentException.class,
            () -> WechatSharePlugin.miniProgramType("unknown"));
    }

    @Test
    public void acceptsOnlyHttpsFallbackUrls() {
        assertTrue(WechatSharePlugin.isHttpsUrl("https://example.com/s/example"));
        assertFalse(WechatSharePlugin.isHttpsUrl("http://example.com/s/example"));
        assertFalse(WechatSharePlugin.isHttpsUrl("javascript:alert(1)"));
        assertFalse(WechatSharePlugin.isHttpsUrl("not a url"));
    }

    @Test
    public void trimsAndBoundsCardText() {
        assertEquals("ExampleApp", WechatSharePlugin.truncate("  ExampleApp  ", 20));
        assertEquals("Exa", WechatSharePlugin.truncate("ExampleApp", 3));
    }

    @Test
    public void brandCoverIsPassedUnchangedAndEmptyOrOversizedCoversAreRejected() throws Exception {
        byte[] cover = Files.readAllBytes(Path.of("src/main/res/raw/wechat_share_cover.jpg"));
        assertTrue(cover.length < 128 * 1024);
        assertEquals(0xff, cover[0] & 0xff);
        assertEquals(0xd8, cover[1] & 0xff);
        try (var input = new FilterInputStream(new ByteArrayInputStream(cover)) {
            @Override
            public int read(byte[] buffer) throws IOException {
                return super.read(buffer, 0, Math.min(buffer.length, 7));
            }
        }) {
            assertArrayEquals(cover, WechatSharePlugin.readCover(input));
        }
        byte[] limit = new byte[128 * 1024];
        assertArrayEquals(limit, WechatSharePlugin.readCover(new ByteArrayInputStream(limit)));
        assertNull(WechatSharePlugin.readCover(new ByteArrayInputStream(new byte[limit.length + 1])));
        assertNull(WechatSharePlugin.readCover(new ByteArrayInputStream(new byte[0])));
        try (var failed = new FilterInputStream(new ByteArrayInputStream(cover)) {
            @Override
            public int read(byte[] buffer) throws IOException {
                throw new IOException("Unreadable resource");
            }
        }) {
            assertThrows(IOException.class, () -> WechatSharePlugin.readCover(failed));
        }
    }
}
