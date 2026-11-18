package org.appshell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;

import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class RecordingKeepAlivePluginTest {

    @Test
    public void grantedWinsOverEverything() {
        assertEquals("granted", RecordingKeepAlivePlugin.derivePermissionState(true, false, false));
        assertEquals("granted", RecordingKeepAlivePlugin.derivePermissionState(true, true, true));
    }

    @Test
    public void neverAskedIsPromptNotDenied() {
        // 首装时 rationale 恒为 false，只有 asked 标记能把「没问过」和「永久拒绝」分开。
        assertEquals("prompt", RecordingKeepAlivePlugin.derivePermissionState(false, false, false));
    }

    @Test
    public void rationaleMeansStillAskable() {
        assertEquals("prompt-with-rationale", RecordingKeepAlivePlugin.derivePermissionState(false, true, true));
        // rationale 优先于 asked：这一档决定了「软拒绝一次」不会被当成永久拒绝，
        // 也是四种输入组合里唯一由语句先后顺序决定答案的那个。
        assertEquals("prompt-with-rationale", RecordingKeepAlivePlugin.derivePermissionState(false, true, false));
    }

    @Test
    public void askedWithoutRationaleIsPermanentlyDenied() {
        assertEquals("denied", RecordingKeepAlivePlugin.derivePermissionState(false, false, true));
    }

    @Test
    public void storageNeedsNoPermissionFromQ() {
        assertEquals("unsupported", RecordingKeepAlivePlugin.storageState(29, false, false, true));
        assertEquals("unsupported", RecordingKeepAlivePlugin.storageState(36, false, false, false));
    }

    @Test
    public void storageFallsBackToRuntimePermissionBelowQ() {
        assertEquals("prompt", RecordingKeepAlivePlugin.storageState(28, false, false, false));
        assertEquals("granted", RecordingKeepAlivePlugin.storageState(24, true, false, true));
    }

    @Test
    public void askedKeyIsNamespaced() {
        assertEquals("permission_asked.android.permission.RECORD_AUDIO",
                RecordingKeepAlivePlugin.askedKey("android.permission.RECORD_AUDIO"));
    }

    @Test
    public void storageLocationIsAFixedContract() {
        // Web 的文案和后续任务的落盘逻辑都按这个相对路径写，改它是跨仓库破坏性变更。
        // 一级目录还受 MediaProvider 约束（Files 集合只放行 Download/ 与 Documents/），
        // 见 RecordingLocalFilePluginTest#theFolderMustBeOneFilesCollectionAccepts。
        assertEquals("Documents/" + AppShellConfig.STORAGE_DIR, RecordingKeepAlivePlugin.STORAGE_LOCATION);
    }

    @Test
    public void methodNameMapsToPermission() {
        assertEquals("android.permission.RECORD_AUDIO", RecordingKeepAlivePlugin.permissionForMethod("requestMicrophone"));
        assertEquals("android.permission.POST_NOTIFICATIONS", RecordingKeepAlivePlugin.permissionForMethod("requestNotifications"));
        assertEquals("android.permission.WRITE_EXTERNAL_STORAGE", RecordingKeepAlivePlugin.permissionForMethod("requestStorage"));
        assertNull(RecordingKeepAlivePlugin.permissionForMethod("start"));
    }

    @Test
    public void aliasTableMatchesThePluginAnnotation() {
        // alias 是散在注解外面的第二份真相。写错一个字 Capacitor 不会报错，只会安静地把请求
        // 丢掉（getPermissionStringsForAliases 返回空数组），系统框压根不弹。
        // 只能靠反射把「方法名 → alias → 权限」这条链和注解本身钉在一起。
        Map<String, String> declared = new HashMap<>();
        CapacitorPlugin annotation = RecordingKeepAlivePlugin.class.getAnnotation(CapacitorPlugin.class);
        for (Permission perm : annotation.permissions()) {
            declared.put(perm.alias(), perm.strings()[0]);
        }

        for (String method : new String[] { "requestMicrophone", "requestNotifications", "requestStorage" }) {
            String alias = RecordingKeepAlivePlugin.aliasForMethod(method);
            assertEquals(method, RecordingKeepAlivePlugin.permissionForMethod(method), declared.get(alias));
        }
        assertNull(RecordingKeepAlivePlugin.aliasForMethod("start"));
    }

    @Test
    public void confirmCopyFallsBackWhenWebSendsNothing() {
        assertEquals("需要您确认", PermissionConfirmDialog.orDefault(null, PermissionConfirmDialog.DEFAULT_TITLE));
        assertEquals("需要您确认", PermissionConfirmDialog.orDefault("   ", PermissionConfirmDialog.DEFAULT_TITLE));
        assertEquals("自定义", PermissionConfirmDialog.orDefault("自定义", PermissionConfirmDialog.DEFAULT_TITLE));
    }

    @Test
    public void usageBannerKeepsTheDisclosureVisibleBeforeTheSystemDialog() {
        assertEquals("权限申请说明", PermissionUsageBanner.orDefault(null, PermissionUsageBanner.DEFAULT_TITLE));
        assertEquals("自定义", PermissionUsageBanner.orDefault("自定义", PermissionUsageBanner.DEFAULT_TITLE));
        assertEquals(180L, PermissionUsageBanner.REQUEST_DELAY_MS);
    }

    // ---- outcome：跟 Web 的契约（recordingPermissions.ts 的 settle 只认这三个字面量） ----

    @Test
    public void outcomeStringsAreTheOnesWebAccepts() {
        // settle() 只把 granted / blocked / dismissed 当数，别的一律丢掉自己按状态推。
        assertEquals("granted", RecordingKeepAlivePlugin.outcomeForState("granted"));
        assertEquals("dismissed", RecordingKeepAlivePlugin.outcomeForState("prompt"));
        assertEquals("blocked", RecordingKeepAlivePlugin.outcomeForState("denied"));
        assertEquals("blocked", RecordingKeepAlivePlugin.outcomeForState("prompt-with-rationale"));
    }

    @Test
    public void unknownStateFallsBackToBlocked() {
        // 一道权限闸的兜底方向是拦住，不是放行：认不出来就当没给，让 Web 去引导设置。
        assertEquals("blocked", RecordingKeepAlivePlugin.outcomeForState(null));
        assertEquals("blocked", RecordingKeepAlivePlugin.outcomeForState("unsupported"));
    }

    // ---- 系统框回来之后的判定 ----

    @Test
    public void backingOutOfTheSystemDialogIsNotADenial() {
        // 用户在系统权限框上按返回键：AndroidX 回来的结果 map 是空的，Capacitor 的
        // validatePermissions 一条都不写，它那份状态还停在 prompt。
        // 这一路绝不能记成「问过了」——记了状态就是 denied，后续系统框再也不会出现。
        assertEquals("dismissed", RecordingKeepAlivePlugin.outcomeAfterRequest(false, false, false, "prompt"));
        // 而且这次之后 asked 不落（permissionCallback 里的 markAsked 由它把门），
        // getStatus 读到的仍然是 prompt，下一次照样能重新请求。
        assertFalse(RecordingKeepAlivePlugin.verdictArrived("prompt"));
    }

    @Test
    public void systemDialogVerdictsAreRecordedAsAsked() {
        // 真给了答复的三种：授权、软拒绝（还能再问）、永久拒绝。
        assertEquals("granted", RecordingKeepAlivePlugin.outcomeAfterRequest(true, false, false, "granted"));
        assertEquals("blocked", RecordingKeepAlivePlugin.outcomeAfterRequest(false, true, false, "prompt-with-rationale"));
        // 关键的一档：首次请求就被勾了「不再询问」，rationale 仍是 false，
        // 全靠 Capacitor 那份 denied 把它跟「按返回键」分开。
        assertEquals("blocked", RecordingKeepAlivePlugin.outcomeAfterRequest(false, false, false, "denied"));
    }

    @Test
    public void alreadyAskedStaysAskedEvenWithoutAVerdict() {
        // 之前已经被永久拒绝过，这次的系统框根本不弹、直接空 map 回来：
        // 不能因为「这次没答复」就把旧结论洗掉。
        assertEquals("blocked", RecordingKeepAlivePlugin.outcomeAfterRequest(false, false, true, "prompt"));
    }

    @Test
    public void capacitorStateIsTheOnlySignalThatSeparatesDenialFromBackPress() {
        // granted / rationale 两个布尔在这两种情况下取值完全一样，只有第四个参数不同。
        assertEquals("dismissed", RecordingKeepAlivePlugin.outcomeAfterRequest(false, false, false, "prompt"));
        assertEquals("blocked", RecordingKeepAlivePlugin.outcomeAfterRequest(false, false, false, "denied"));
        // 取不到 Capacitor 状态时按「没答复」算：宁可多问一次，也别把用户永久锁在门外。
        assertEquals("dismissed", RecordingKeepAlivePlugin.outcomeAfterRequest(false, false, false, null));
    }

    @Test
    public void confirmDialogThatCannotBeShownStillSettles() {
        List<Boolean> results = new ArrayList<>();
        PermissionConfirmDialog.Callback once = PermissionConfirmDialog.settleOnce(results::add);
        PermissionConfirmDialog.showOrSettle(() -> {
            throw new IllegalStateException("BadTokenException: token is not valid");
        }, once);
        assertEquals(Collections.singletonList(false), results);
    }

    @Test
    public void confirmDialogSettlesAtMostOnce() {
        List<Boolean> results = new ArrayList<>();
        PermissionConfirmDialog.Callback once = PermissionConfirmDialog.settleOnce(results::add);
        once.onResult(true);
        once.onResult(false);
        assertEquals(Collections.singletonList(true), results);
    }

}
