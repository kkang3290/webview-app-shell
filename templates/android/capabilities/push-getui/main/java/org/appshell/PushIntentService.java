package org.appshell;

import android.content.Context;
import android.content.Intent;

import com.igexin.sdk.GTIntentService;
import com.igexin.sdk.message.GTCmdMessage;
import com.igexin.sdk.message.GTNotificationMessage;
import com.igexin.sdk.message.GTTransmitMessage;

import java.nio.charset.StandardCharsets;

/** 个推回调 → Push 插件事件。个推自己弹的通知被点开时拉起 MainActivity；厂商通道的点击走 PushTapActivity。 */
public class PushIntentService extends GTIntentService {
    @Override
    public void onReceiveServicePid(Context context, int pid) {}

    @Override
    public void onReceiveClientId(Context context, String clientId) {
        PushPlugin.onToken(context, clientId);
    }

    @Override
    public void onReceiveMessageData(Context context, GTTransmitMessage message) {
        // 透传：不弹通知，直接交给 Web。
        byte[] bytes = message.getPayload();
        String text = bytes == null ? "" : new String(bytes, StandardCharsets.UTF_8);
        PushPlugin.onNotification("message", PushPlugin.payload(message.getMessageId(), "", "", PushPlugin.parseData(text)));
    }

    @Override
    public void onReceiveOnlineState(Context context, boolean online) {}

    @Override
    public void onReceiveCommandResult(Context context, GTCmdMessage message) {}

    @Override
    public void onNotificationMessageArrived(Context context, GTNotificationMessage message) {
        PushPlugin.onNotification("received", PushPlugin.payload(message.getMessageId(), message.getTitle(),
            message.getContent(), null));
    }

    @Override
    public void onNotificationMessageClicked(Context context, GTNotificationMessage message) {
        PushPlugin.onOpened(PushPlugin.payload(message.getMessageId(), message.getTitle(), message.getContent(), null));
        Intent launch = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        context.startActivity(launch);
    }
}
