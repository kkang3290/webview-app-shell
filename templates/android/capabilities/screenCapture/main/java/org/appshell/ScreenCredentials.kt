package org.appshell

import java.net.URI
import org.json.JSONObject

/** 共享 ID 只用作目录名与请求参数：限定字符集，防止路径穿越。 */
internal val SCREEN_ID = Regex("[A-Za-z0-9_-]{1,128}")
private val LEASE_TOKEN = Regex("[A-Za-z0-9_-]{16,256}")

class ScreenReplayCredentials {
    lateinit var uploadUrl: String
    lateinit var serverNow: String
    var clockOffsetMs: Long = 0
}

/**
 * 一次屏幕共享的推流地址与租约（屏幕租约协议 v1，见 docs/screen-capture.md）。
 * 网页每次 start 传进来；原生自己续租，网页进后台也不断。地址主机必须在 appshell.config.json 的
 * screenCapture.allowedHosts 里（本域或子域），回放上传必须与续租同主机：原生不往任意地址发屏幕画面。
 */
class ScreenCredentials {
    lateinit var url: String
    lateinit var renewUrl: String
    lateinit var publisherId: String
    lateinit var leaseToken: String
    lateinit var expiresAt: String
    var replay: ScreenReplayCredentials? = null

    fun valid(allowedHosts: Array<String> = ScreenCredentials.allowedHosts): Boolean = runCatching {
        fun trusted(uri: URI): Boolean {
            val host = uri.host ?: return false
            return allowedHosts.any { host == it || host.endsWith(".$it") } &&
                uri.userInfo == null && uri.fragment == null && (uri.port == -1 || uri.port == 443)
        }
        val push = URI(url); val renew = URI(renewUrl)
        replay?.let {
            val upload = URI(it.uploadUrl)
            check(upload.scheme == "https" && trusted(upload) && upload.host == renew.host && upload.port == renew.port && upload.query == null)
            replayTime(it.serverNow)
        }
        push.scheme == "rtmps" && trusted(push) &&
            renew.scheme == "https" && trusted(renew) && renew.query == null &&
            SCREEN_ID.matches(publisherId) && LEASE_TOKEN.matches(leaseToken)
    }.getOrDefault(false)

    fun json(): JSONObject = JSONObject().put("url", url).put("renewUrl", renewUrl).put("publisherId", publisherId)
        .put("leaseToken", leaseToken).put("expiresAt", expiresAt).apply {
            replay?.let { put("replay", JSONObject().put("uploadUrl", it.uploadUrl).put("serverNow", it.serverNow).put("clockOffsetMs", it.clockOffsetMs)) }
        }

    companion object {
        /** 来自 appshell.config.json screenCapture.allowedHosts；单测里换成测试域名。 */
        @Volatile var allowedHosts: Array<String> = AppShellConfig.SCREEN_CAPTURE_ALLOWED_HOSTS

        fun fromJson(json: JSONObject) = ScreenCredentials().apply {
            url = json.getString("url"); renewUrl = json.getString("renewUrl")
            publisherId = json.getString("publisherId"); leaseToken = json.getString("leaseToken"); expiresAt = json.getString("expiresAt")
            json.optJSONObject("replay")?.let { value ->
                replay = ScreenReplayCredentials().apply { uploadUrl = value.getString("uploadUrl"); serverNow = value.getString("serverNow"); clockOffsetMs = value.optLong("clockOffsetMs") }
            }
        }

        /** 网页 ScreenCapture.start 的参数：{ stream: { url }, lease: { renewUrl, publisherId, token, expiresAt }, replay?: { uploadUrl, serverNow } }。 */
        fun fromStart(options: JSONObject): ScreenCredentials {
            val stream = options.getJSONObject("stream")
            val lease = options.getJSONObject("lease")
            return ScreenCredentials().apply {
                url = stream.getString("url"); renewUrl = lease.getString("renewUrl"); publisherId = lease.getString("publisherId")
                leaseToken = lease.getString("token"); expiresAt = lease.getString("expiresAt")
                val value = options.optJSONObject("replay")
                if (value != null) replay = ScreenReplayCredentials().apply { uploadUrl = value.getString("uploadUrl"); serverNow = value.getString("serverNow") }
            }
        }
    }
}
