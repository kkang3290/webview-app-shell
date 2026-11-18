package org.appshell;

import android.content.res.Resources;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.tencent.mm.opensdk.constants.Build;
import com.tencent.mm.opensdk.modelmsg.SendMessageToWX;
import com.tencent.mm.opensdk.modelmsg.WXMediaMessage;
import com.tencent.mm.opensdk.modelmsg.WXMiniProgramObject;
import com.tencent.mm.opensdk.openapi.IWXAPI;
import com.tencent.mm.opensdk.openapi.WXAPIFactory;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.util.UUID;

/** Minimal Capacitor adapter for sharing a mini-program card to a WeChat chat. */
@CapacitorPlugin(name = "WechatShare")
public class WechatSharePlugin extends Plugin {
    private static final int THUMB_MAX_BYTES = 128 * 1024;
    private static final int MAX_TITLE_LENGTH = 128;
    private static final int MAX_DESCRIPTION_LENGTH = 256;

    private IWXAPI api;

    @Override
    public void load() {
        String appId = getContext().getString(R.string.wechat_app_id);
        api = WXAPIFactory.createWXAPI(getContext(), appId, true);
        api.registerApp(appId);
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", isMiniProgramShareAvailable());
        call.resolve(result);
    }

    @PluginMethod
    public void shareMiniProgram(PluginCall call) {
        if (api == null || !api.isWXAppInstalled()) {
            call.reject("WeChat is not installed", "WECHAT_NOT_INSTALLED");
            return;
        }
        if (api.getWXAppSupportAPI() < Build.MINIPROGRAM_SUPPORTED_SDK_INT) {
            call.reject("This WeChat version cannot share mini programs", "WECHAT_SHARE_UNAVAILABLE");
            return;
        }

        try {
            String userName = required(call, "userName");
            String path = required(call, "path");
            String webpageUrl = required(call, "webpageUrl");
            String title = truncate(required(call, "title"), MAX_TITLE_LENGTH);
            String description = truncate(call.getString("description", AppShellConfig.APP_NAME), MAX_DESCRIPTION_LENGTH);
            if (!isHttpsUrl(webpageUrl)) {
                throw new IllegalArgumentException("webpageUrl must use HTTPS");
            }

            WXMiniProgramObject object = new WXMiniProgramObject();
            object.webpageUrl = webpageUrl;
            object.userName = userName;
            object.path = path;
            object.withShareTicket = false;
            object.miniprogramType = miniProgramType(required(call, "version"));

            WXMediaMessage message = new WXMediaMessage(object);
            message.title = title;
            message.description = description;
            message.thumbData = coverThumb();
            if (message.thumbData == null) {
                call.reject("Unable to prepare share cover", "WECHAT_SHARE_FAILED");
                return;
            }

            SendMessageToWX.Req request = new SendMessageToWX.Req();
            request.transaction = "miniprogram-" + UUID.randomUUID();
            request.message = message;
            request.scene = SendMessageToWX.Req.WXSceneSession;
            if (!api.sendReq(request)) {
                call.reject("Unable to open WeChat sharing", "WECHAT_SHARE_FAILED");
                return;
            }

            // WeChat no longer reports a trustworthy final share result. This only means its UI opened.
            JSObject result = new JSObject();
            result.put("status", "opened");
            call.resolve(result);
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage(), "WECHAT_SHARE_INVALID_PARAMS");
        } catch (RuntimeException error) {
            call.reject("Unable to open WeChat sharing", "WECHAT_SHARE_FAILED");
        }
    }

    private boolean isMiniProgramShareAvailable() {
        return api != null
            && api.isWXAppInstalled()
            && api.getWXAppSupportAPI() >= Build.MINIPROGRAM_SUPPORTED_SDK_INT;
    }

    static int miniProgramType(String version) {
        if ("release".equals(version)) return WXMiniProgramObject.MINIPTOGRAM_TYPE_RELEASE;
        if ("trial".equals(version)) return WXMiniProgramObject.MINIPROGRAM_TYPE_PREVIEW;
        if ("develop".equals(version)) return WXMiniProgramObject.MINIPROGRAM_TYPE_TEST;
        throw new IllegalArgumentException("Unsupported mini-program version");
    }

    static boolean isHttpsUrl(String value) {
        try {
            URI uri = URI.create(value);
            return "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null;
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    static String truncate(String value, int maxLength) {
        String trimmed = value == null ? "" : value.trim();
        if (trimmed.length() <= maxLength) return trimmed;
        return trimmed.substring(0, maxLength);
    }

    private static String required(PluginCall call, String name) {
        String value = truncate(call.getString(name), Integer.MAX_VALUE);
        if (value.isEmpty()) throw new IllegalArgumentException(name + " is required");
        return value;
    }

    // 与小程序转发使用同一品牌封面；直接读取原始 JPEG，不重绘、不按屏幕密度缩放。
    private byte[] coverThumb() {
        try (InputStream input = getContext().getResources().openRawResource(R.raw.wechat_share_cover)) {
            return readCover(input);
        } catch (IOException | Resources.NotFoundException ignored) {
            return null;
        }
    }

    static byte[] readCover(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (output.size() + count > THUMB_MAX_BYTES) return null;
            output.write(buffer, 0, count);
        }
        return output.size() == 0 ? null : output.toByteArray();
    }
}
