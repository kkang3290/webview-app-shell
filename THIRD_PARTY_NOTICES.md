# 第三方组件与许可边界

本项目原创代码按 MIT 发布；此声明不会重新许可第三方 SDK、工具链、复制代码或生成应用中包含的组件。

以下是直接依赖及按平台启用的主要集成清单，**不是已完成的全量许可证/SBOM 审核**。正式发布前应基于实际锁文件和生成产物补充各组件的版权、许可证全文与必要 NOTICE。

| 组件 | 使用方式 | 发布前检查 |
| --- | --- | --- |
| Capacitor（core / cli / android / ios） | npm 依赖、生成原生容器 | 保留上游许可证与版权 |
| Electron / electron-builder | 桌面运行时下载、打包 | Electron/Chromium/Node 及打包依赖的第三方声明 |
| Gradle wrapper | 本仓库包含 wrapper 脚本与 jar | Apache-2.0 脚本声明已保留；核验 jar 来源/摘要及分发要求 |
| RootEncoder | Android 屏幕 RTMPS 推流，按能力启用 | 核实所固定版本的许可证、NOTICE 和其传递依赖 |
| HaishinKit | iOS 广播扩展推流，Swift Package | 核实固定版本与传递依赖的许可证 |
| 极光 / 个推及厂商推送 SDK | Android 可选依赖 | SDK 授权、隐私披露、厂商分发及数据处理条款 |
| 微信 OpenSDK / miniprogram-ci | Android 微信能力、小程序上传 | SDK 与开发平台协议、隐私与分发要求 |
| Apple / HarmonyOS SDK | 本机构建工具链 | 开发者协议、签名与商店分发限制 |
| nsh | 外部可执行工具 | 所选工具版本的许可及生成运行时依赖 |

- 不要把 SDK 的服务端 secret 放入客户端；某些厂商要求的客户端标识不等于可公开的服务端密钥。
- 动态依赖、构建时下载和系统 SDK 不一定出现在 npm 锁文件中，需另行审查。
- 维护者须确认本仓库从其他项目迁入的代码具有再发布权限；当前目录没有原始 Git 历史，无法在此证明全部来源。
