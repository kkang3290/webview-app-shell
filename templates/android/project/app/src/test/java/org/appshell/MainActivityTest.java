package org.appshell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class MainActivityTest {
    private static final AppShellConfig.RootPage[] ROOT_PAGES = {
        new AppShellConfig.RootPage("/", new String[0]),
        new AppShellConfig.RootPage("/timeline", new String[] { "id" }),
        new AppShellConfig.RootPage("/chat", new String[0]),
        new AppShellConfig.RootPage("/profile", new String[] { "tab=thoughts", "tab=actions", "tab=people", "tab=facts" }),
        new AppShellConfig.RootPage("/login", new String[0]),
    };
    private static final AppShellConfig.Shortcut[] SHORTCUTS = {
        new AppShellConfig.Shortcut("record", "录音", android.R.drawable.ic_btn_speak_now, "/"),
        new AppShellConfig.Shortcut("chat", "对话", android.R.drawable.sym_action_chat, "/chat"),
    };

    @Test
    public void rootTabsDoNotReopenOldWebViewHistory() {
        String origin = "https://localhost";
        for (String path : new String[] { "/", "/profile", "/profile?tab=activity", "/profile?tab=unknown", "/timeline", "/chat?session=7", "/login" }) {
            assertTrue(path, MainActivity.isRootPage(origin + path, origin, ROOT_PAGES));
        }
        for (String path : new String[] { "/profile?tab=facts", "/profile?tab=thoughts", "/profile?tab=actions", "/profile?x=1&tab=people", "/settings", "/settings/voiceprint?feature=7", "/moments/7", "/timeline?id=7" }) {
            assertFalse(path, MainActivity.isRootPage(origin + path, origin, ROOT_PAGES));
        }
        assertFalse(MainActivity.isRootPage("https://example.com/profile", origin, ROOT_PAGES));
        assertFalse(MainActivity.isRootPage("https://localhost:1234/profile", origin, ROOT_PAGES));
        assertFalse(MainActivity.isRootPage(null, origin, ROOT_PAGES));
        assertFalse(MainActivity.isRootPage("invalid url", origin, ROOT_PAGES));
        assertTrue(MainActivity.isRootPage("http://localhost:5199/profile", "http://localhost:5199", ROOT_PAGES));
    }

    @Test
    public void rootBackRequiresSecondPressWithinWindow() {
        assertFalse(MainActivity.shouldReturnToDesktop(-1L, 1_000L));
        assertTrue(MainActivity.shouldReturnToDesktop(1_000L, 3_000L));
        assertFalse(MainActivity.shouldReturnToDesktop(1_000L, 3_001L));
    }

    @Test
    public void launcherShortcutsOnlyOpenKnownAppRoutes() {
        assertEquals("/", MainActivity.shortcutPath("/", SHORTCUTS));
        assertEquals("/chat", MainActivity.shortcutPath("/chat", SHORTCUTS));
        assertNull(MainActivity.shortcutPath("https://example.com", SHORTCUTS));
    }
}
