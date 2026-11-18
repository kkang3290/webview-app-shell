# HarmonyOS 目标

app-shell 的 HarmonyOS 目标是 `webview` 引擎的第一方 ArkWeb 壳。业务仓库只维护 Web 和 `appshell.config.json`；app-shell 每次在业务仓库生成 `.appshell/harmony`，不依赖或修改独立的 Harmony 工程。

## 命令

```sh
appshell doctor harmony
appshell prebuild harmony --env test
appshell build harmony --env test --type debug
appshell build harmony --env prod --type release
appshell publish harmony --env test --kind app --dry-run
```

`prebuild` 只构建 Web 并生成 ArkTS/Hvigor 工程，不要求已安装 Harmony SDK。`build` 需要 DevEco/Hvigor 工具链；`release` 与 `publish` 需要签名。`--dry-run` 仍会构建，只是不上传。Harmony 暂不支持 `webbundle`、`--os`、`--simulator` 或 `nsh` 引擎。

## 工具链文件

配置中的 `harmony.toolchainEnv` 必须指向一个环境变量；环境变量值是本机 JSON 文件的绝对路径。字段必须全部存在：

```json
{
  "nodeHome": "/path/to/DevEco/tools/node",
  "sdkHome": "/path/to/DevEco/sdk",
  "hvigorw": "/path/to/DevEco/tools/hvigor/bin/hvigorw",
  "javaHome": "/path/to/jdk",
  "hapSignTool": "/path/to/hap-sign-tool.jar"
}
```

macOS 上 DevEco Studio 26.0.0 的实际路径：`nodeHome` = `Contents/tools/node`、`sdkHome` = `Contents/sdk`、`hvigorw` = `Contents/tools/hvigor/bin/hvigorw`、`javaHome` = `Contents/jbr/Contents/Home`（DevEco 自带 JBR）、`hapSignTool` = `Contents/sdk/default/openharmony/toolchains/lib/hap-sign-tool.jar`（均以 `/Applications/DevEco-Studio.app/` 为前缀）。建议放在 `~/.config/appshell/harmony-toolchain.json`，在 shell 配置里导出对应环境变量。

模板代码受 ArkTS 严格模式约束：对象字面量必须对应显式声明的接口或类，不支持结构化类型；改模板后必须用真实 Hvigor 编译验证，Node 单测覆盖不到这一层。

app-shell 不扫描常见安装目录，也不在多个环境变量之间回退。路径和模板的 SDK 版本必须与当前配置一致。SDK 不存在时 `doctor harmony` 会失败并列出路径。

## 签名

- `--type debug`：**永远不签名**，产出 `*-debug-unsigned.hap`，任何人不需要签名材料就能检查构建。
- `--type release` 与 `publish`：**必须签名**。Hvigor 先出未签名包，app-shell 再直接调 `hap-sign-tool sign-app -mode localSign` 签名，随后 `verify-app` 并重新核对包名、版本和内置清单。
- 不走 Hvigor 自带签名：DevEco 写进 `build-profile.json5` 的 `storePassword` / `keyPassword` 是用本机 `material/` 目录加密的十六进制串，换一台机器或 CI 就解不开。app-shell 生成的 `build-profile.json5` 里不含任何签名信息。
- 要装到手机上测试，用 `--type release` 配**调试证书 + 调试 Profile**（Profile 里登记了设备）；发布证书 + 发布 Profile 只能走 AppGallery 分发。

### 签名材料从哪来

全部在华为 AppGallery Connect（AGC）和 DevEco Studio 里办，需要企业开发者账号：

| 文件 | 怎么得到 |
| --- | --- |
| `.p12`（私钥库）+ keyAlias + 两个密码 | DevEco Studio → Build → Generate Key and CSR，自己设定密码与别名，同时得到 `.csr`。**华为后台不保存这些**，丢了只能重新生成证书 |
| `.cer`（应用证书） | AGC →「证书、APP ID 和 Profile」→ 证书 → 新增，上传 `.csr`，选调试或发布类型，下载 |
| `.p7b`（Profile） | 同一页面 → Profile → 添加，选 APP ID（包名，如 `com.example.app`）、上一步的证书、类型；调试 Profile 还要勾选已登记的设备（设备 UDID：`hdc shell bm get --udid`） |
| `signAlg` | 与密钥类型一致：DevEco 默认生成 ECC 密钥，对应 `SHA256withECDSA` |

### 本机配置

材料放在仓库之外，例如 `~/.config/appshell/harmony/<应用>-<debug|release>/`（目录 `700`，私钥与 JSON `600`），签名 JSON（密码是明文，所以必须只在本机或 CI 密钥里）：

```json
{
  "storeFile": "/secure/appshell/harmony/example-debug/app.p12",
  "storePassword": "…",
  "keyAlias": "…",
  "keyPassword": "…",
  "profile": "/secure/appshell/harmony/example-debug/app.p7b",
  "certpath": "/secure/appshell/harmony/example-debug/app.cer",
  "signAlg": "SHA256withECDSA"
}
```

业务配置只写环境变量名：`"signing": { "configEnv": "APPSHELL_HARMONY_SIGNING" }`；本机 `export APPSHELL_HARMONY_SIGNING=…/signing.json`。没设这个变量时 debug 照常可用，`doctor harmony` 只提示 release 不可用。

### CI

- 需要装好 DevEco Studio（固定 26.0.0）的 **macOS runner**，并确认 runner 中安装了匹配的 SDK。runner 上放一份工具链 JSON，job 里导出 `APPSHELL_HARMONY_TOOLCHAIN`。
- 签名材料放 GitLab 的 **protected + masked** 变量：`.p12` / `.cer` / `.p7b` 用 File 类型，密码与 keyAlias 用普通 masked 变量；job 在临时目录里拼出签名 JSON（`chmod 600`），`after_script` 删除，不进 artifacts / cache。只在受保护分支或 tag 上运行。
- 优先使用 CI secret store；如选择可选的 [Apollo 模式](apollo.md)，必须评估其鉴权、配置历史和备份中的密钥保留风险。
- 签名失败的报错会抹掉密码；但 `hap-sign-tool` 只支持命令行传密码，同机其他用户在签名的几秒内可以从进程列表看到，所以 runner 必须专用。

## 原生能力边界

模板提供：

- 受控 HTTPS origin 的包内静态资源；API/WebSocket 路径继续真实网络访问；缺件不回退远端站点。
- 双重页面/frame 来源校验的通用 `appshellNative` bridge。
- `App`、`Permissions`、`WebRecording` 插件；WebRecording 只维护网页 MediaRecorder/Web Audio 的常亮/长时任务和中断事件。
- 系统文件选择/保存、返回历史、可信外链交系统浏览器。

当前不提供 `NativeRecorder`、进程被杀后的原生 PCM 采集、原生后台上传、推送、微信、系统声音采集或 Web 热更新。SDK 的 `nativeRecorderAvailable()` 在 Harmony 返回 `false`；业务应继续走网页录音和 IndexedDB 恢复。设备验收不能把网页长时任务等同于独立原生录音。

## 安全规则

资源必须来自生成的索引；API 前缀不被本地 SPA fallback 吞掉；资源路径拒绝穿越、编码分隔符、符号链接、特殊文件、隐藏路径和 source map。外部 HTTPS 页面不在拥有敏感 bridge 的 WebView 中加载。页面退出、导航、渲染器异常和系统任务取消会使旧请求失效并释放录音 lease。

实际 HAP 编译、签名、设备安装和真机长录音仍需在具备 DevEco SDK、开发者签名及目标设备后单独验收。