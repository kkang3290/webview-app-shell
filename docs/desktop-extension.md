# 业务扩展：通用能力组覆盖不了的原生代码

外壳的原则是「原生只给原语、业务留在网页」（见 [capabilities-v2.md](capabilities-v2.md)）。但已有的应用往往带着一批
成熟的原生业务代码（本地文件处理、专用窗口、专有支付），在它们被拆成通用能力之前，可以作为**业务扩展**随包带上：
代码留在业务仓库，外壳负责构建、装配、打包。出包仍然只有 `appshell build / publish` 一条命令。

## 桌面（`desktop.extension`）

```jsonc
"desktop": {
  "extension": {
    "command": ["node", "desktop/scripts/build-extension.ts"],  // 构建扩展，产出 dir；不经过 shell
    "dir": "desktop/extension",                                  // 构建产物目录（要进 .gitignore）
    "asarUnpack": ["bin/**"]                                     // 不进 asar 的文件（要被执行的二进制）；没有写 []
  }
}
```

`command` 运行时带上该环境的 `buildEnv` 以及 `APPSHELL_ENV` / `APPSHELL_DEBUG`（`1` 或 `0`）/ `APPSHELL_ELECTRON_VERSION`。

产物目录约定：

| 文件 | 作用 |
| --- | --- |
| `main.js`（必须） | 主进程模块，CommonJS，只能 `require('electron')` 与 Node 内置模块（依赖自己打包进去） |
| `preload.js`（可选） | 主窗口的预加载脚本，CommonJS 单文件，只能 `require('electron')`。外壳把它拼在自己的预加载后面，**只在主窗口执行** |
| 其余文件 | 原样放进应用的 `extension/` 目录；运行时用 `__dirname` 找。命中 `asarUnpack` 的在 `app.asar.unpacked/extension/` 下 |

`main.js` 导出三个可选的钩子：

```ts
// 同步，app ready 之前：protocol.registerSchemesAsPrivileged、提前挂 open-url / second-instance 等
export function beforeReady(base: { electron, shellConfig, extensionDir }): void
// app ready 之后、本地站点启动之前：要赶在页面加载和启动口令 cookie 写入之前做的事（如按条件清会话数据）
export function ready(base): Promise<void> | void
// 外壳的插件注册完、主窗口创建之前
export function setup(context: typeof base & {
  siteOrigin: string                       // 本地站点的源
  userDataDir: string
  mainWindow(): BrowserWindow | null
  isTrusted(contents: WebContents): boolean   // 是本应用窗口且仍在本站点源上
  isSameOrigin(url: string): boolean
}): Promise<Hooks | void> | Hooks | void

interface Hooks {
  // 在外壳的默认选项上调整主窗口；preload / contextIsolation / nodeIntegration / sandbox 不可改（外壳会改回去）
  windowOptions?(options: BrowserWindowConstructorOptions): BrowserWindowConstructorOptions
  // 主窗口建好、加载页面之前（每次重建都会调）
  mainWindowCreated?(window: BrowserWindow): void
}
```

`shellConfig` 是包内的 `appshell.json`：`appName` / `appId` / `environment` / `apiPath` / `apiTarget` /
`publicOrigin` / `appVersion` / `scheme` / `window` / `permissions` / `capabilities` / `hotUpdate` / `debug`。

规则与边界：

- 外壳已经做了的事不要重复：单实例锁、深链 scheme 登记、本地站点、热更新、主窗口的创建与加载。
- 扩展自己注册的 IPC 要自己校验发送方（用 `context.isTrusted(event.sender)`，或只认 `context.mainWindow()`）。
- 扩展后注册的会话级处理器（`setPermissionRequestHandler`、`setWindowOpenHandler`、应用菜单）会替换外壳的默认实现——
  这是允许的，但站外导航与弹窗的限制要自己保持。
- 扩展可以再挂 `before-quit` 等应用事件；与外壳的监听并存。
- 扩展的依赖（类型、打包工具）由 `command` 自己负责装好；外壳不替它跑 `npm install`。
- 构建不能改动受版本控制的文件（release 包会校验工作区仍然干净）。


## iOS（`ios.extension`）

```jsonc
"ios": {
  "extension": {
    "dir": "ios/extension",                             // 目录下（不含子目录）所有 .swift 编进 App target
    "plugins": ["ApplePurchasePlugin"],                 // 要登记的 Capacitor 插件类名（CAPPlugin 子类）
    "systemCapabilities": ["com.apple.InAppPurchase"],  // 标在 target 上的系统能力
    "resources": ["WechatOpenSDKPrivacy.bundle"],       // 随 App 打包的资源（dir 下的文件或 .bundle）
    "packages": [{ "dir": "Packages/WechatOpenSDK", "product": "WechatOpenSDK" }],   // 本地 Swift Package（相对 dir）
    "infoPlist": { "LSApplicationQueriesSchemes": ["weixin"] },                      // 并入 Info.plist
    "entitlements": { "com.apple.developer.associated-domains": ["applinks:example.com"] },
    "linkerFlags": ["-ObjC"],
    "buildScripts": [{ "name": "校验", "script": "python3 \"$APPSHELL_EXTENSION_DIR/scripts/check.py\" \"$TARGET_BUILD_DIR/$WRAPPER_NAME\"" }]
  }
}
```

所有字段必填，没有的写 `[]` / `{}`。

- 源码文件名不能与外壳自己的源码同名。
- 整个扩展目录会拷一份到生成工程的 `ios/extension/`；构建脚本里用 `$APPSHELL_EXTENSION_DIR` 引用它。构建脚本排在所有构建阶段之后
  （包括 CocoaPods 的嵌入框架阶段），可以用 Xcode 的构建变量（`$ACTION`、`$TARGET_BUILD_DIR` 等）。
- 系统交给 App 的链接（自定义 scheme、通用链接）：在插件的 `load()` 里
  `AppShellLinks.shared.subscribe(url:activity:)`；冷启动时先到的链接会在订阅时补发。
- 需要在页面加载前注入脚本的，在插件的 `load()` 里对 `bridge?.webView` 加 `WKUserScript`。
- 需要在某段操作期间挡住下拉刷新的，发通知 `ShellPageRefreshController.busyChanged`（`object` 为 `Bool`）。
- 目前不支持业务自带的扩展 target（分享扩展、小组件）；屏幕共享要的广播上传扩展由能力组 `screenCapture` 生成，见 [screen-capture.md](screen-capture.md)。


## Android（`android.extension`）

```jsonc
"android": {
  "extension": {
    "dir": "android/extension",                        // Android 库模块的源码：只能有 src/（build.gradle 由外壳生成）
    "plugins": ["com.example.app.DrawingPlugin"],      // 要登记的 Capacitor 插件（Plugin 子类）完整类名
    "dependencies": ["com.example:sdk:1.2.3"],          // Maven 坐标，版本写死（不允许 + / latest）
    "repositories": ["https://maven.example.com/releases"],
    "manifestPlaceholders": { "APP_FLAVOR": "pre" }    // 扩展 Manifest 里 ${…} 的值
  }
}
```

所有字段必填，没有的写 `[]` / `{}`。

- 目录布局：`src/main/java`、`src/main/kotlin`（Java 与 Kotlin 都能编，Kotlin 2.2）、`src/main/res`、`src/main/AndroidManifest.xml`
  （可选，库 Manifest 由 Gradle 自动合并进 App）、`src/test/…`（`testDebugUnitTest` 一起跑）。
- 生成工程里是模块 `:appshell-extension`（命名空间 `org.appshell.extension`），依赖 Capacitor、appcompat、core；
  App 依赖它。扩展是库，**不能引用外壳 App 模块里的类**（`AppShellConfig`、`MainActivity` 等）。
- 资源名不要与外壳的冲突（外壳的都以 `appshell_` 或能力组名开头）。


## 桌面的权限文案与签名

- `desktop.mac.usageDescriptions`：Info.plist 里除 `permissions` 推导出的那几条之外的权限说明（同名时以它为准）；
  `desktop.mac.localizedUsageDescriptions`：各语言的权限弹窗文案，键是 `.lproj` 目录名（`zh_CN`、`en`、`es_419`……）。
- 默认不签名（mac 包补 ad-hoc 签名）。签名身份只从打包机的环境变量来：`APPSHELL_MAC_IDENTITY`（Developer ID 证书名；
  公证凭据按 electron-builder 的约定给）、`APPSHELL_WIN_CERT_SHA1`（Windows 证书存储里代码签名证书的 SHA-1 指纹）。
  给了证书而签名失败时构建直接失败，不会悄悄出未签名的包。
