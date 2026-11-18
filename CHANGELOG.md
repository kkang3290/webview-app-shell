# 更新日志

## Unreleased — 开源整理

- 使用 MIT 许可证，移除内部部署地址、业务产品标识、真实示例 AppID、内部迁移及验收记录。
- npm 包名改为 `webview-app-shell`；SDK 导入路径为 `webview-app-shell/web`。
- Android 模板命名空间改为 `org.appshell`；生成应用的 applicationId / Bundle ID 仍由配置决定。
- Android 安全区 CSS 变量改为 `--appshell-native-safe-top`，录音权限偏好存储名改为 `appshell_permissions`。
- 制品发布令牌必须通过 `--token-env` 显式指定，移除对其他工具登录状态的读取；Apollo 模式缺凭据时不回退本地环境。
- `release` 可为 `null`，本地构建不再要求配置制品服务。
- 增加通用配置示例、开源元数据和回归测试。

以上标识调整可能影响从旧外壳升级的应用；迁移时需要核对 Web 导入、CSS、扩展类引用、固定快捷方式及权限状态，不应直接覆盖已发布应用。

## 0.17.2 — 开源整理前的功能基线

保留 Android / iOS / Electron / HarmonyOS / 微信小程序及 nsh 引擎的构建实现，支持按能力组装配录音、权限、上传、推送、热更新、屏幕共享和桌面系统集成。

此版本号表示代码基线，不表示开源整理后已完成全部平台重新验收。当前验证范围和未解决事项见 [开源准备审计](docs/open-source-audit.md)。
