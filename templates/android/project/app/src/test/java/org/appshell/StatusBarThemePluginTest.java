package org.appshell;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class StatusBarThemePluginTest {
    @Test
    public void keyboardInsetAlreadyPaddedByTheWindowIsNotSubtractedTwice() {
        // 上层（Capacitor SystemBars）已经按键盘高度留白：这里不再留
        assertEquals(0, StatusBarThemePlugin.bottomPadding(646, 646));
        // 上层没处理：全部由这里留
        assertEquals(646, StatusBarThemePlugin.bottomPadding(646, 0));
        // 上层只留了导航栏，键盘更高：补差额
        assertEquals(600, StatusBarThemePlugin.bottomPadding(646, 46));
        assertEquals(0, StatusBarThemePlugin.bottomPadding(0, 46));
    }
}
