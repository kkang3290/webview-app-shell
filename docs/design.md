# 架构

## 目标与边界

将可复用的原生容器、插件、工程生成、版本注入和产物整理集中维护。业务项目保留 Web / TSX 源码与配置，不需要提交生成的 Gradle / Xcode / Hvigor 工程。

- **配置驱动**：`appshell.config.json` 严格校验；平台与环境显式选择。
- **工程是生成物**：`.appshell/<平台>` 可以重建，不能保存独有源码或密钥。
- **能力组**：只复制并注册启用的能力；平台不支持时不暴露假插件。
- **业务和原生分离**：原生负责采集、持久化、窗口与系统权限；业务流程留在网页或受信任的业务扩展。
- **本地构建独立**：`release: null` 时不需要制品服务；发布适配是可选网络集成。

## 模块

| 目录/模块 | 职责 |
| --- | --- |
| `bin/appshell.mjs` / `src/cli.mjs` | CLI 入口、参数解析与平台分派 |
| `src/config.mjs` | 本地配置读取与严格校验 |
| `src/source.mjs` / `src/apollo.mjs` | 可选 Apollo 远程配置与锁文件 |
| `src/context.mjs` / `src/credentials.mjs` | 操作级工具链、签名/上传材料与清理 |
| `src/web.mjs` | Web 构建、源码状态与清单 |
| `src/{android,ios,desktop,harmony,miniprogram,nsh}.mjs` | 平台工程生成与构建 |
| `src/publish.mjs` / `src/artifact.mjs` | 发布计划与可选制品 API 客户端 |
| `templates/` | 原生容器、插件和生成工程模板 |
| `web/` | 不依赖 Capacitor npm 包的 Web SDK 与 TypeScript 类型 |

## WebView 构建流程

```text
选择配置来源与环境
  → 严格校验配置、工具链与所需凭据
  → 检查业务 Git 源码状态
  → 执行配置中的 Web 构建命令，注入 APPSHELL_* 与 buildEnv
  → 写 appshell-build.json（身份、环境、版本、源码提交、dirty、摘要）
  → 复制平台模板、能力组与业务资源
  → 生成平台配置和插件注册
  → 调用 Gradle / Xcode / electron-builder / Hvigor
  → 整理安装包与 SHA-256 到 .appshell/out
```

Android/iOS 使用锁定的 Capacitor 依赖。Android Java 命名空间固定为 `org.appshell`，与用户配置的 applicationId 无关；微信回调以 activity-alias 映射。

桌面使用 Electron 主进程的回环同源站点，代理所配置的 API/WebSocket；preload 暴露能力白名单，IPC 校验发送方。扩展模块属于可信代码，不能用于运行不可信插件。

HarmonyOS 通过 ArkWeb 将包内静态资源映射到配置的 HTTPS origin，并明确分流 API 路径。网页录音长时任务辅助不等于独立原生采集。

微信小程序只生成远程网站容器，不运行本地 Web dist；原生页面由业务扩展生成，上传与网站部署是不同流程。

## nsh 引擎

锁定本机 nsh 版本，将应用复制到生成目录，写入 `appshell.env.json` 后调用 nsh 打包。界面由 TSX / Rust 与原生控件实现。nsh 0.4.0 的 OTA 分发未接入，`ota` 必须为 `null`。

## 数据与信任边界

- 配置中的构建命令、扩展代码、Gradle/Xcode 脚本等均有本机执行权限，只能来自可信维护者。
- WebBundle 会成为拥有已启用原生桥权限的页面代码。当前摘要校验不提供独立签名信任链。
- 录音先落盘再交付，后台挂起时可补拉；应用需负责完整文件、未完成会话和上传历史的保留/删除策略。
- 签名材料与服务端凭据不能进入 Web 构建变量、客户端配置、发布说明、日志或包。
- Apollo、制品 API、推送、微信与 Apple 服务是可选/显式集成，不提供任何预设业务账号或托管服务。

## 验证

Node 测试只能覆盖可执行的 CLI/配置/SDK/纯逻辑，不能证明平台模板可编译或设备行为正确。开源整理后的所有平台都需要重新构建；录音、锁屏、来电、蓝牙、推送点击、弱网上传、更新回退和签名发布需分别验收。

已知限制与未解决事项见 [开源准备审计](open-source-audit.md)。
