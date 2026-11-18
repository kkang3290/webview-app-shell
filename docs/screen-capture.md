# 屏幕共享（能力组 `screenCapture`）

三端同名插件 `ScreenCapture`，Web SDK 见 `webview-app-shell/web` 的 `*ScreenCapture*` / `*ScreenSource*`。
提供原生采集、租约续期、回放分段和上传回执校验；推流域名、App Group 和扩展 ID 来自配置。

| | Android | iOS | 桌面 |
| --- | --- | --- | --- |
| 采集 | MediaProjection 整屏 | ReplayKit 广播上传扩展（独立 target） | 页面 `getDisplayMedia`（原生只选来源） |
| 推流 | 原生 H.264 → RTMPS（RootEncoder） | 扩展里 H.264 → RTMPS（HaishinKit 2.2.5） | 无：页面自己发 |
| 续租 | 前台服务（mediaProjection 类型） | 扩展进程 | — |
| 回放 | 本地分段（≤10 秒、关键帧切分）+ 补传 | 同左（App Group 目录，App 与扩展都会补传） | — |
| 声音 | 不采 | 不采 | 不采 |

## 配置

```jsonc
"capabilities": ["screenCapture", ...],
"screenCapture": {
  "allowedHosts": ["example.com"],     // 推流 / 续租 / 回放上传的主机必须是这些域名或其子域
  "broadcastName": "ExampleApp 课堂"      // iOS 系统广播面板里显示的扩展名
},
"strings": {
  "screenCaptureNotificationChannel": "屏幕共享",
  "screenCaptureNotificationTitle": "正在共享屏幕",
  "screenCaptureNotificationText": "屏幕画面正在发送到课堂",
  "screenCaptureStop": "停止共享"      // Android 前台通知上的按钮
}
```

iOS 广播扩展的 Bundle ID 固定为 `<ios.bundleId>.broadcast`，App Group 固定为 `group.<ios.bundleId>`，不单独配置。
真机签名时 App ID 与扩展 ID 都要在开发者后台启用这个 App Group（自动签名 + `-allowProvisioningUpdates` 会尝试创建；
团队账号没有权限时要手工建描述文件）。

## 手机端接口

```ts
ScreenCapture.capabilities()  // { platform, screens: true, windows: false, stream: ['rtmps'], replay: true }
ScreenCapture.start({
  stream: { url: 'rtmps://…' },
  lease: { renewUrl: 'https://…', publisherId: 'cdp_xxx', token: '<16-256 位 [A-Za-z0-9_-]>', expiresAt: '<ISO 8601，毫秒>' },
  replay: { uploadUrl: 'https://…', serverNow: '<ISO 8601，毫秒>' },   // 可选
})                             // 推流连上后 resolve { state: 'sharing' }；取消 reject DENIED，45 秒连不上 reject FAILED
ScreenCapture.stop()          // { state: 'stopped' }
ScreenCapture.state()         // { state }
// 事件 'state'：requesting / sharing / stopped / failed / denied
```

校验（原生做，不交给网页）：推流必须 `rtmps`、续租 / 回放必须 `https`，主机在 `allowedHosts` 内，端口只能是默认或 443，
不带用户名密码与片段；续租地址不带查询串；回放上传与续租同主机同端口、不带查询串；`publisherId` 只含 `[A-Za-z0-9_-]`（1–128 位，
用作本地目录名）。同一时间只有一次共享。

## 屏幕租约协议 v1（业务后端实现）

**续租 / 停止**：`POST <renewUrl>`，`Content-Type: application/json`，不跟随重定向，5 秒超时：

```json
{ "publisherId": "…", "leaseToken": "…", "action": "renew" | "stop", "refreshPush": true }
```

- `renew` 返回 2xx `{ "url": "rtmps://…"?, "expiresAt": "<ISO 8601>" }`；`refreshPush: true`（首次与断线重连）时必须给新的 `url`。
  `expiresAt` 距现在必须在 0–65 秒之间，否则视为无效。
- 4xx（408 / 425 / 429 除外）视为租约已被撤销，立即停止；其余失败按 1 / 2 / 4 / 5 秒退避重试，直到租约到期。
- 连上后每 20 秒续一次；单次租约最长按 60 秒计。`stop` 在停止时尽力发一次，不等结果。

**回放上传**：每个分段 `POST <uploadUrl>?publisherId=…&seq=<n>&startedAt=<ISO>&durationMs=<n>`，
`Content-Type: video/mp4`、`X-Screen-Lease: <leaseToken>`，正文是独立可解码的 MP4（只有视频）。回执必须是
`{ "seq": n, "bytes": <正文字节数> }`，对上了才删除本地分段。全部传完后 `POST <uploadUrl>?publisherId=…&seq=<分段数>&finish=1&failed=0|1`
（空正文），回执 `{ "finished": true }`。授权被用户取消时也会发一次 0 个分段的 finish。分段在本地最多积压 12 个；
App 重启、回到前台时自动补传。

协议时间常数在 Android `ScreenRecovery.kt` 与 iOS `ScreenLease.swift` 各有一份。后端改变租约长度时需同步检查两端实现。

## 桌面接口

```ts
ScreenCapture.capabilities()       // { platform: 'desktop', screens: true, windows: true, stream: [], replay: false, permission }
ScreenCapture.listSources({ types?: ['screen', 'window'], thumbnailWidth?: 320, icons?: true, includeOwnWindows?: false })   // 默认不列本应用窗口
                                   // { sources: [{ id, kind, name, displayId?, bounds?, scaleFactor?, primary?, thumbnail?, icon? }] }
ScreenCapture.snapshot({ sourceId, maxWidth?: 1920, quality?: 85 })   // { image: 'data:image/jpeg;base64,…', width, height }
ScreenCapture.select({ sourceId })  // 之后 30 秒内、同一窗口的下一次 getDisplayMedia 拿到这个来源（只用一次）
```

没 `select` 过的 `getDisplayMedia` 一律拒绝（不弹 Chromium 自己的选择框），只给画面不给声音。macOS 上首次采集会弹系统的
屏幕录制授权，授权归属是 App 本身（`permission` 为 `denied` 时引导用户去 `SystemShell.openPrivacySettings({ pane: 'screen' })`）。

## 验证要求

需分别验收真实 RTMPS 服务、租约过期/撤销、后台续租、弱网重连、回放补传、授权取消与服务退出。iOS 模拟器不能代替广播扩展真机测试；模拟器软件 H.264 编码可能与真机不同。桌面需测试各 OS 的录屏授权、多显示器坐标和窗口来源。
