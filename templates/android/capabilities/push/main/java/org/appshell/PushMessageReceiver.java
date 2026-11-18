package org.appshell;

import android.content.Context;
import android.content.Intent;

import cn.jpush.android.api.CustomMessage;
import cn.jpush.android.api.NotificationMessage;
import cn.jpush.android.service.JPushMessageReceiver;

/** 极光回调 → PushPlugin 事件。点开通知时自己拉起 MainActivity，并把这条通知留给 Web 取。 */
public class PushMessageReceiver extends JPushMessageReceiver {
    @Override
    public void onRegister(Context context, String registrationId) {
        PushPlugin.onToken(context, registrationId);
    }

    @Override
    public void onNotifyMessageArrived(Context context, NotificationMessage message) {
        PushPlugin.onNotification("received", PushPlugin.payload(message.msgId, message.notificationTitle,
            message.notificationContent, message.notificationExtras));
    }

    @Override
    public void onNotifyMessageOpened(Context context, NotificationMessage message) {
        PushPlugin.onOpened(context, PushPlugin.payload(message.msgId, message.notificationTitle,
            message.notificationContent, message.notificationExtras));
        Intent launch = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        context.startActivity(launch);
    }

    @Override
    public void onMessage(Context context, CustomMessage message) {
        // 自定义消息（透传）：不弹通知，直接交给 Web。
        PushPlugin.onNotification("message", PushPlugin.payload(message.messageId, message.title,
            message.message, message.extra));
    }
}
