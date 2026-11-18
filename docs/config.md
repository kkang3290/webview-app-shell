# appshell.config.json 字段

除明确可省略的平台段外，字段须显式提供（允许 `null` 的已注明）；未知字段报错。完整示例：[基础配置](../examples/basic/appshell.config.json)。

| 字段 | 说明 |
| --- | --- |
| `schemaVersion` | 固定 `1` |
| `app.name` | 显示名，也用作产物文件名前缀 |
| `app.version` | 三段式公共版本；Android versionName 使用它，iOS / 桌面另有独立版本线 |
| `web.command` | 构建命令数组，不经过 shell，例如 `["npm","run","build:shell"]` |
| `web.outDir` | 构建产物目录（含 `index.html`） |
| `web.version` | Web 版本号（热更新比新旧用）的来源，二选一：`{ "packageJson": "package.json" }` 或 `{ "env": "APPSHELL_WEB_VERSION" }`（CI 自动发热更新时用，如 `1.0.$CI_PIPELINE_IID`；没设就报错） |
| `environments.<名>.buildEnv` | 该环境构建 Web 时额外注入的环境变量；`APPSHELL_` 前缀保留 |
| `environments.<名>.artifactEnvironment` | 发版时 Artifact Service 的环境名 |
| `capabilities` | 能力组数组：`recording` / `hotUpdate` / `wechat` / `backgroundUpload` / `push`，以及通用能力 v2（[capabilities-v2.md](capabilities-v2.md)）：`windows`（桌面多窗口）/ `system`（桌面托盘、主窗口控制、退出确认、隐私设置）/ `screenCapture`（三端屏幕共享，见 [screen-capture.md](screen-capture.md)）。某端没有实现的能力组不会进该端工程，网页按插件是否存在降级 |
| `permissions` | 用到的系统权限：`microphone` / `camera` / `notifications` / `photos` / `location`；`recording` 需要 microphone，`push` 需要 notifications |
| `navigation.nativeBackEvent` | Android 返回键先派发给页面的事件名，页面 `preventDefault` 即拦截 |
| `navigation.rootPages[]` | 根页：`path` + `childQuery`（带这些 query 视为子页，写 `key` 或 `key=value`） |
| `navigation.shortcuts[]` | Android 桌面长按快捷方式，最多 4 个；`icon` 只能用系统图标 |
| `theme.*` | 启动画面与原生底色，`#RRGGBB` |
| `strings.*` | 原生文案；启用 `recording` 时需要通知渠道、标题、正文；启用 `screenCapture` 时需要 `screenCaptureNotificationChannel` / `screenCaptureNotificationTitle` / `screenCaptureNotificationText` / `screenCaptureStop` |
| `screenCapture` | 启用 `screenCapture` 时 `{ allowedHosts, broadcastName }`，否则 `null`。`allowedHosts`：推流 / 续租 / 回放上传允许的域名（含子域）；`broadcastName`：iOS 广播面板里的扩展名 |
| `wechat` | 启用 `wechat` 时 `{ "appId": "wx…" }`，否则 `null` |
| `push` | 启用 `push` 时必填，否则 `null`。`android.provider` 可为 `jpush` 或 `getui`；使用极光时为 `jpush`，`android.appKey` 为极光 AppKey，`android.channels` 可含 `xiaomi {appId, appKey}`、`oppo {appId, appKey, appSecret}`（自动加 OP-）、`vivo {appId, appKey}`、`honor {appId}`、`meizu {appId, appKey}`（自动加 MZ-）、`huawei {servicesFile}`（agconnect-services.json 相对路径）；`ios.provider` 固定 `apns`，`ios.environment` 为 `development` / `production`。**个推**：`android` 写 `{ "provider": "getui", "appId", "channels", "notificationChannel": { id, name }, "tap": { scheme, host, path } }`，`channels` 可含 `huawei {appId}`、`xiaomi {appId, appKey}`、`oppo {appKey, appSecret}`、`vivo {appId, appKey}`、`honor {appId}`；`tap` 是厂商通道点开通知的入口（后端下发的 intent 指向 `scheme://host/path`，URI 查询参数与字符串 extras 作为通知 `data`） |
| `android.applicationId` | 安装包名 |
| `android.versionCode` | 单调递增整数，必须高于已发布的包 |
| `android.storageDir` | 录音与图片在 Documents / Pictures 下的目录名 |
| `android.resources` | res 覆盖目录（图标、启动图标、微信分享封面） |
| `android.nativeHttp` | 是否启用 CapacitorHttp 全局接管 fetch/XHR（`https://localhost` 已被后端 CORS 允许时为 false） |
| `android.legacyActivities` | 从别的工程迁过来时旧版本的入口 Activity 全名（如 `com.example.legacy.MainActivity`），生成不带 LAUNCHER 的 activity-alias，升级后桌面图标仍能找到入口；没有写 `[]` |
| `android.extension` | 业务扩展（Android 库模块）：`dir`（只含 `src/`）、`plugins`（Capacitor 插件完整类名）、`dependencies`（Maven 坐标，版本写死）、`repositories`（额外 https 仓库）、`manifestPlaceholders`；没有写 `null`，见 [desktop-extension.md](desktop-extension.md) |
| `android.signing.propertiesFile` | 签名配置（storeFile/storePassword/keyAlias/keyPassword），可为 `null`；release 必填。相对路径按此文件所在目录解析 |
| `ios.bundleId` / `ios.version` / `ios.buildNumber` | Bundle ID、iOS 自己的版本线（不低于已上架版本，与 `app.version` 分开）与 build 号（以 App Store Connect 线上为准递增） |
| `ios.hotUpdate` | 开了 `hotUpdate` 能力组时必填，否则 `null`：`apply`（`next-launch` 下次冷启动自动切换 / `prompt` 等页面启用）、`latestUrl`（每个环境一条查询最新热更新包的 https 地址，返回 `{version,url}`）、`bundleAppId`（接受的热更新包清单里的 appId；与 Android 共用一份 shell 构建时填 `android.applicationId`） |
| `ios.extension` | 业务扩展（`dir` / `plugins` / `systemCapabilities` / `resources` / `packages` / `infoPlist` / `entitlements` / `linkerFlags` / `buildScripts`），没有写 `null`，见 [desktop-extension.md](desktop-extension.md) |
| `ios.deploymentTarget` | 最低 iOS 版本，如 `17.0` |
| `ios.deviceFamily` | `"1"` iPhone，`"1,2"` iPhone + iPad |
| `ios.teamId` | Apple 团队 ID，可为 `null`（只能出模拟器包） |
| `ios.resources` | 含 `AppIcon.appiconset`（可选 `Splash.imageset`）的目录 |
| `ios.nativeHttp` | `capacitor://localhost` 不在后端 CORS 白名单时设为 true |
| `ios.backgroundRecording` | 启用后写入 `UIBackgroundModes: audio`，`NativeRecorder` 在后台 / 锁屏继续采集；需要 `recording` 能力。上架审核需说明录音用途 |
| `ios.pullToRefresh` | `enabled` + `blockSelector`（页面出现该元素时禁用下拉刷新，可为 `null`） |
| `ios.usageDescriptions` | Info.plist 权限文案，与 `permissions` 一一对应：microphone→`NSMicrophoneUsageDescription`、camera→`NSCameraUsageDescription`、photos→`NSPhotoLibraryAddUsageDescription`、location→`NSLocationWhenInUseUsageDescription`；缺的和多的都报错 |
| `environments.<名>.desktop` | 配置了 `desktop` 时必填，否则 `null`：`apiTarget`（本地站点转发的后端 https 源）、`publicOrigin`（对外链接用的公网站点地址：桌面页面跑在本地站点，自己的 origin 发出去没人打得开）、`buildEnv`（桌面网页版构建的环境变量） |
| `desktop` | 不做桌面端时为 `null`。`appId`（mac Bundle ID / Windows AppUserModelID）、`version`（桌面安装包自己的版本线，与 `app.version` 分开）、`web.command` / `web.outDir`（同源网页版构建）、`apiPath`（同源 API 前缀）、`scheme`（深链 scheme，可 `null`）、`window`（`width` / `height` / `minWidth` / `minHeight`）、`resources`（含 1024×1024 的 `icon.png`）。mac 权限说明复用 `ios.usageDescriptions`，`mac.usageDescriptions` 补桌面专有的（如系统声音），`mac.localizedUsageDescriptions` 给各语言的弹窗文案（键是 `.lproj` 目录名，没有写 `{}`）。`extension`：业务扩展（`command` / `dir` / `asarUnpack`），没有写 `null`，见 [desktop-extension.md](desktop-extension.md)。开了 `hotUpdate` 能力组时 `hotUpdate` 必填：`latestPath`（相对 `apiPath` 的查询路径，返回 `{version,url}`）、`endpointPrefix`（本地端点前缀，如 `/__example`）、`apply`（`next-launch` 下次冷启动自动切换 / `prompt` 等页面启用）；没开写 `null` |
| `miniprogram` | 仅 `webview` 引擎，可选：不用时省略或写 `null`（0.17.2 起可省略）；启用时 `{ appId, version, libVersion, entryPath, extension }`。独立小程序 AppID / 三段式版本 / 锁定基础库版本；`entryPath` 是受控站点下的路径（如 `/login`），不能是外部 URL。详见 [miniprogram.md](miniprogram.md) |
| `miniprogram.extension` | 没有扩展写 `null`；否则 `{ command, dir }`：命令数组生成 `dir` 下的原生页面与声明，不经过 shell；不能覆盖通用壳或生成的环境配置 |
| `environments.<名>.miniprogram` | 顶层未启用时省略或写 `null`（写了对象会报错，不会静默忽略）；启用后每个环境必填 `{ siteOrigin, apiOrigin }`。`siteOrigin` 是网页的 HTTPS origin；原生页 API origin 不用时显式写 `null`。不读取 desktop 配置、不猜测其他环境 |
| `harmony` | 可省略的 webview 平台段；配置后生成 `.appshell/harmony` ArkWeb 工程。必须显式写 `bundleName`、`version`、`versionCode`、`targetSdkVersion`（当前 `26.0.0`）、`compatibleSdkVersion`（当前 `6.1.1(24)`）、`resources`（含 `app_icon.png`）、`web`（browser 构建命令与 `outDir`）、逐环境 `environments.<名>.siteOrigin/buildEnv`、`apiPrefixes`、本端 `capabilities/permissions`、`toolchainEnv`、`signing` 和 `strings`。全局能力是并集；当前本端只支持 `recording` 的 Web 录音辅助与 `microphone`，不提供 NativeRecorder、推送、微信、后台上传或热更新。`harmony.signing` 可为 `null`，只能生成未签名 debug HAP；release/publish 必须签名。工具链 JSON 和签名 JSON 由配置中指定的环境变量指向，不扫描 PATH 或猜测路径。详见 `docs/harmony.md` |
| `release.artifactProject` | Artifact Service 项目 slug |
| `release` | 不使用制品发布时为 `null`；配置对象启用兼容 Artifact Service 的发布适配，不影响 iOS/小程序各自的上传服务 |
| `release.artifactService` | 自行部署的兼容 HTTPS 服务 origin，例如 `https://artifacts.example.com`；见 [发布协议](publishing.md) |
