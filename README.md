# webview-app-shell

配置驱动的跨平台应用外壳与构建 CLI。将 Web 应用打包为 Android、iOS、macOS、Windows、HarmonyOS 应用，或生成加载已部署网站的微信小程序。

业务项目维护 Web 代码、`appshell.config.json` 和图标资源；原生工程由模板生成到 `.appshell/<平台>`。录音、权限、上传、推送等能力按需编入，不需要在每个应用中复制维护原生插件。

> 当前版本：0.17.2。开源整理版尚未完成全部平台的重新编译与真机验收。已有实现不等于完整验证。

## 引擎与平台

| 引擎 | Android | iOS | macOS / Windows | HarmonyOS | 微信小程序 | Web |
| --- | --- | --- | --- | --- | --- | --- |
| `webview` | Capacitor | Capacitor / WKWebView | Electron | ArkWeb | 远程网站 `web-view` | 使用业务自身构建 |
| `nsh` | nsh | nsh | nsh（另支持 Linux） | — | — | nsh |

`nsh` 使用 TSX / Rust 和原生控件，外壳负责版本锁定、环境注入与产物整理；它不是 WebView。参见 [架构](docs/design.md)。

## 安装

需要 Node.js ≥ 22.18。此目录可直接作为本地 npm 开发依赖安装；这里不假定已存在公开 npm 发布或托管仓库：

```sh
# 在业务项目中，使用本仓库的实际路径
npm install --save-dev /path/to/webview-app-shell
npx appshell --help
```

各平台还需要对应工具链：

- Android：JDK 21、Android SDK，设置 `JAVA_HOME` 和 `ANDROID_HOME`。
- iOS：macOS、Xcode、CocoaPods、可加载 `xcodeproj` 的 Ruby；真机签名需要开发者账号。
- 桌面：electron-builder 下载对应 Electron 运行时；跨平台打包依赖宿主系统与签名工具。
- HarmonyOS：[DevEco / Hvigor 与签名配置](docs/harmony.md)。
- 微信小程序：本地生成无需密钥；真实上传需要有 `web-view` 资质的小程序和上传私钥。

未预置业务服务器。依赖下载、SDK、用户配置的后端及显式发布操作仍可能访问网络。

## 接入应用

1. 从 [完整基础配置](examples/basic/appshell.config.json) 开始，按 [配置说明](docs/config.md) 填写。
2. 配置严格校验，未注明可省略的字段必须显式提供；未知字段报错。仅本地构建可写 `"release": null`，不需要制品服务。
3. 准备资源：Android res 覆盖目录至少包含 `ic_launcher`、`ic_launcher_round`、`appshell_splash_mark`；iOS 目录包含 `AppIcon.appiconset`；桌面目录包含 1024×1024 的 `icon.png`。示例只包含配置，不附应用图标。
4. 将 `/.appshell/` 和 Web 输出目录加入业务仓库 `.gitignore`。
5. 在已提交的业务 Git 仓库运行命令。调试可用 `--allow-dirty`，热更新和发布要求干净源码。

```sh
npx appshell doctor android
npx appshell build android --env test --type debug --allow-dirty
npx appshell build ios --env test --type debug --simulator --allow-dirty
npx appshell prebuild ios --env test --allow-dirty
npx appshell build desktop --env test --type debug --allow-dirty
npx appshell build desktop --env test --type release --os win32
```

`prebuild` 生成工程；`build` 生成并编译。产物与 `.sha256` 在 `.appshell/out/`。生成目录会被重建，不要在其中保存手工修改或签名材料。

Web 构建收到 `APPSHELL_PLATFORM`、`APPSHELL_ENV`、`APPSHELL_APP_ID` 及所选环境的 `buildEnv`。这些值可能进入客户端，不能包含服务端秘密。

## 能力组

| 能力 | Android | iOS | 桌面 | HarmonyOS |
| --- | --- | --- | --- | --- |
| 权限、主题等基础能力 | 支持 | 支持 | 支持 | 部分支持 |
| `recording` | 原生 PCM / AAC、前台服务、输入设备选择 | 原生 PCM / AAC、配置后支持后台录音 | 页面采集、主进程落盘 | Web 录音长时任务辅助；无 NativeRecorder |
| `hotUpdate` | WebBundle、确认与回退 | WebBundle、可共用 Android 包 | WebBundle、确认与回退 | 不支持 |
| `backgroundUpload` | WorkManager | 后台 URLSession | 持久化主进程队列 | 不支持 |
| `push` | 极光 / 个推及厂商通道 | APNs | 不支持 | 不支持 |
| `wechat` | 登录、支付、分享 | 需业务扩展 | 不支持 | 不支持 |
| `screenCapture` | MediaProjection / RTMPS | ReplayKit 广播扩展 / RTMPS | 选源、快照、getDisplayMedia | 不支持 |
| `windows` / `system` | 不支持这两个插件 | 不支持这两个插件 | 多窗口、托盘、主窗口及退出控制 | 不支持 |

`permissions` 声明 microphone、camera、notifications、photos、location。不同平台并非完整对等，网页必须按插件是否存在降级。后台运行还受设备、操作系统和厂商策略限制。

### Web SDK

```ts
import {
  shellPlatform,
  nativeRecorderAvailable,
  startNativeRecording,
} from 'webview-app-shell/web'

if (nativeRecorderAvailable()) {
  const recorder = await startNativeRecording({
    sampleRate: 16000,
    chunkMs: 500,
    onChunk: async ({ seq, pcm }) => {
      // 交给业务处理；抛错时不确认交付，可稍后补拉。
      await deliverAudio(seq, pcm)
    },
  })
  const { filePath, durationMs } = await recorder.stop()
}
```

原生录音先落盘再推事件；JS 暂停后按序补拉，确认后删除对应 PCM 段。完整文件和未完成会话需要业务设置保留/删除策略。`listNativeRecordings()` / `recoverNativeRecording()` 用于启动恢复。浏览器、HarmonyOS、小程序需另行使用可用的 Web 录音方案。

后台上传由 `enqueueBackgroundUpload()` / `waitForBackgroundUpload()` 提供。必须显式提供 `Content-Type`；签名 URL 过期等 4xx 交回业务处理，5xx 和网络错误退避重试。iOS 用户主动强退与系统终止不是同一种场景，不保证强退后继续上传。

推送应在用户同意后调用 `registerPush()`；实际注册、厂商通道与审核合规需使用自己的账号配置验证。接口类型见 [web/index.d.ts](web/index.d.ts)。

## 桌面

Electron 启动回环 HTTP 站点，静态网页与 API / WebSocket 代理同源；代理目标由 `environments.<环境>.desktop.apiTarget` 显式配置。站点使用每次启动的随机 HttpOnly cookie。它不是同机恶意进程的隔离沙箱。

窗口使用 context isolation、禁用 Node integration，并启用 sandbox。正式包关闭 Electron 的 Node/调试入口。业务扩展是可信原生代码，不受这些限制保护。

桌面使用 `desktop.web` 构建；支持单实例、深链、站外链接交系统浏览器、录音中退出确认和防休眠。macOS 默认 ad-hoc 签名；设置 `APPSHELL_MAC_IDENTITY` 可请求正式签名，公证使用 `APPSHELL_ASC_KEY_*`。Windows 签名使用 `APPSHELL_WIN_CERT_SHA1`。证书需自行安装到构建机。

Android 安全区 CSS 变量为 `--appshell-native-safe-top`；网页也应正确处理标准 `env(safe-area-inset-*)`。

## HarmonyOS 与小程序

- [HarmonyOS](docs/harmony.md)：生成 ArkWeb 工程；debug HAP 不签名，release 必须签名。不提供原生后台录音、推送、微信、后台上传或热更新。
- [微信小程序](docs/miniprogram.md)：加载配置的 HTTPS 网站，不内置 Web dist，不把 React/Vue 转成 WXML；build 输出工程 zip，不是 wxapkg。上传后仍需自行管理体验版、审核和发布。

## 热更新与发布

```sh
# 仅构建热更新包，不上传
npx appshell webbundle android --env test
npx appshell webbundle desktop --env test
```

热更新只替换 Web 资源。原生代码、权限和扩展变化需要重新安装包。校验 appId、环境、干净源码和 SHA-256，并提供启动确认/失败回退。**SHA-256 校验不是独立的发布者数字签名**，更新服务及下载存储属于信任边界。

iOS 可以按 `ios.hotUpdate.bundleAppId` 共用 Android WebBundle；当前 CLI 不提供独立 iOS WebBundle 发布通道。

`publish` 的服务适配不是公共托管服务：

- Android、桌面、HarmonyOS 和普通文件发布：需要自行提供兼容的 [Artifact Service API](docs/publishing.md)，并配置 `release`。
- 文件模式的制品令牌仅从 `--token-env <变量名>` 读取，不读取其他工具的登录态。
- iOS 安装包：App Store Connect / TestFlight，需 `APPSHELL_ASC_KEY_PATH` / `APPSHELL_ASC_KEY_ID` / `APPSHELL_ASC_ISSUER_ID`。
- 小程序：微信，需 `APPSHELL_WX_MP_KEY_PATH`。
- [Apollo 模式](docs/apollo.md)：可选远程配置适配，需要自行部署并强制鉴权。普通使用不需要 Apollo。

`--dry-run` 仍构建，只是不上传。不要在不可信 PR 上提供签名/上传凭据。

## 文档与开发

- [架构](docs/design.md) · [配置](docs/config.md) · [原生扩展](docs/desktop-extension.md)
- [多窗口与系统集成](docs/capabilities-v2.md) · [屏幕共享协议](docs/screen-capture.md)
- [贡献](CONTRIBUTING.md) · [安全](SECURITY.md) · [第三方组件](THIRD_PARTY_NOTICES.md)

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

首次安装禁止依赖安装脚本。审查后仅按需批准；平台工具、构建命令和第三方 SDK 仍执行可信代码。锁文件与依赖审计的当前状态见 [开源准备审计](docs/open-source-audit.md)。

Node 测试不替代 Gradle/Xcode/Hvigor 编译、微信开发者工具或真机验收。修改模板后需运行对应平台构建和设备场景测试；Android 生成工程中的 `./gradlew testDebugUnitTest` 会运行启用能力组的 JVM 测试。

## 许可证

[MIT](LICENSE)。第三方 SDK、工具链和生成应用的分发仍受各自许可证和平台条款约束。
