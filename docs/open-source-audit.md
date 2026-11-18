# 开源准备审计

日期：2026-11-18。范围：当前目录中的第一方源代码、模板、文档、示例、npm 锁文件与打包文件列表。结论：**完成本地信息清理和基础回归；不应据此宣称已通过生产安全审计或全平台验收。**

## 已完成

- 清除内部服务域名、私有下载/Git 地址、业务产品名、实际微信 AppID、内部迁移/部署/验收记录；占位域名使用 `example.com`。
- 删除 Finder `.DS_Store`；没有删除核心平台、原生插件或 Android 测试。
- npm 包名改为 `webview-app-shell`，Android 模板与生成器命名空间统一为 `org.appshell`；SDK、文档与模板路径同步更新。
- 添加 MIT、贡献/安全说明、第三方组件清单、完整基础配置示例。
- `release: null` 允许本地构建不依赖制品服务；发布前显式拒绝缺失配置，不先启动构建。
- 删除发布令牌对其他工具登录态的读取；文件模式要求 `--token-env`，Apollo 缺凭据不回退本地环境。
- 修复制品客户端接受明文 HTTP origin 的问题：在发出带 Bearer 的管理请求前验证 HTTPS origin；拒绝 URL 内凭据、路径、查询和片段。
- 修复桌面静态文件仅做字符串路径前缀校验的问题：读取前解析真实路径并校验包含关系，SPA index 也验证；异步读取失败不泄露本地路径。
- 增加 npm 权威锁文件和 `.npmrc` 安装脚本禁用策略；固定包管理器版本。
- 新增本地回归测试，原先 `npm test` 为 0 测试的状态已改变。

## 验证结果

| 检查 | 结果 / 边界 |
| --- | --- |
| `npm test` / `npm run check` | 13 个 Node 测试通过：CLI 示例、环境校验、发布禁用、令牌来源、静态服务 symlink 越界、HTTPS origin、信息清理 |
| JS 语法 | 35 个第一方 JS/MJS/CJS 模块通过 `node --check` |
| Ruby 语法 | `templates/ios/configure.rb` 通过 `ruby -c` |
| `npm ci --ignore-scripts` | 成功；1346 个包安装，存在多项 deprecated 警告；未执行依赖 lifecycle scripts |
| `npm pack --dry-run` | 已检查文件白名单；包含 LICENSE 与示例，不包含 node_modules、签名材料、环境文件或 Finder 元数据 |
| 凭据/标识扫描 | 未发现私钥正文、常见 token 格式、个人主目录路径或非占位微信 AppID；模式扫描不能证明所有秘密不存在 |
| Git 历史 | 当前目录不是 Git 仓库，不能扫描原仓库历史或确认代码来源授权 |
| 平台构建/设备/上传 | 未执行 Gradle/Xcode/Hvigor 编译、Electron 实际运行、真机测试或真实发布 |
| `npm audit --json` | 非零退出：91 个受影响包条目，详见下节；不能标记为通过 |

最初锁文件生成因本机默认 npm 缓存权限失败；改用独立缓存后生成成功，未删除/覆盖原缓存。没有执行 `npm audit fix --force`、npm 发布、Git 提交或推送。

## 高优先级：依赖链风险（未修复）

本次审计计数是 npm 按包汇总的受影响条目，含传递依赖与风险传播，不是 91 个独立可利用漏洞：

| 级别 | 条目数 |
| --- | ---: |
| critical | 41 |
| high | 29 |
| moderate | 19 |
| low | 2 |
| 合计 | 91 |

主要已定位链：

- `miniprogram-ci@2.1.31 → @babel/traverse@7.21.4`：恶意待编译代码触发的执行风险，公告 [GHSA-67hx-6x53-jw92](https://github.com/advisories/GHSA-67hx-6x53-jw92)。小程序源码编译/上传路径可达；此处未演示利用。
- `miniprogram-ci → download@8.0.0 → decompress@4.2.1`：解压越界/链接问题，[GHSA-mp2f-45pm-3cg9](https://github.com/advisories/GHSA-mp2f-45pm-3cg9)、[GHSA-hrh2-vp3x-79xf](https://github.com/advisories/GHSA-hrh2-vp3x-79xf)。下载/解压路径相关，具体调用输入仍需逐项核对。
- `miniprogram-ci → cos-nodejs-sdk-v5 → fast-xml-parser@4.2.5` 以及另一份 `4.5.7`：XML 注入/资源消耗等公告；上传 SDK 处理网络响应的链路相关，具体条件未逐项证明。
- `miniprogram-ci → request@2.88.2 → form-data@2.3.3`：旧网络库与 multipart 风险，[GHSA-fjxv-7rqg-78g4](https://github.com/advisories/GHSA-fjxv-7rqg-78g4)。
- `miniprogram-ci → protobufjs@6.11.6`：多个代码生成、原型与递归资源消耗公告。
- 直接依赖 `@capacitor/cli@8.5.3` 经 `xcode` 被标为 moderate，audit 提示可检查 8.6.2；`electron-builder@26.18.0` 也被传播标记，audit 建议的 25.1.0 是回退且跨主版本，不能自动照做。

**可达性边界**：这些 npm 依赖用于 CLI、构建与上传；`src/miniprogram.mjs` 仅在真正上传时动态加载 `miniprogram-ci`。不能把它们直接当成生成客户端的运行时漏洞，但安装后和持有签名材料的 runner 上仍需认真处理。生成客户端依赖还包括 Electron/Chromium、Gradle/Maven、Swift 包和系统 SDK，它们不在这份 npm 审计的完整覆盖内。

**暂缓原因**：此任务不盲目升级/降级 SDK；npm 对多条链报告没有现成自动修复，强制 overrides 可能破坏官方编译上传工具。需单独评估升级、可选化/隔离小程序工具、逐项兼容的传递修复与真实平台测试。**这不是生产使用豁免**。复审期限：下一次公开发布之前，最迟 2026-12-02；未处置前不要把签名凭据交给不可信代码/共享 runner。

安装脚本涉及 `@parcel/watcher`、`@swc/core`、`core-js`、`electron-winstaller`、`fsevents`、`less`、`protobufjs` 等。当前均未授权执行；部分可选平台功能可能需要审查后单独安装步骤，不能将禁用脚本的安装成功等同于全部功能可用。

## 高优先级：更新链缺少独立签名（设计边界，未修复）

当前更新包和旁挂 `.sha256` 均经服务端/存储获取，摘要用于完整性，不是独立发布者身份验证。一旦可修改更新源和 checksum，就能下发自洽的恶意网页；这些页面将拥有应用已启用的原生桥权限。

位置：`templates/desktop/lib/webbundle.js`、Android `WebBundleUpdaterPlugin.java`、iOS `WebBundleUpdaterPlugin.swift`。

建议：引入嵌入客户端的发布公钥、签名 manifest、内容摘要、版本/环境绑定、密钥轮换与防回退策略。此项改变更新协议与兼容性，本次只明确风险，没有静默改协议。

## 中优先级：网络/解压资源上限不足（未修复）

- 桌面更新下载 `collect()` 不限制响应总量；`extractTarGz()` 使用同步 `gunzipSync()` 全量展开，缺少解压总字节/条目上限，恶意或损坏包可能导致主进程内存耗尽、阻塞或磁盘占满。
- Android 更新下载和 ZIP 拷贝缺少总字节、条目数、展开大小限制。
- iOS ZIP 声明了条目和总大小限制，但 DEFLATE 在校验实际结果前一次性解压，声明大小不等于实际内存上限；下载也需资源预算。
- Artifact 客户端管理响应无显式超时/响应大小上限；上传使用全量 `readFileSync`，服务返回的上传票据/下载地址未统一做严格 HTTPS、重定向和资源限制。管理 origin 已修复，不表示票据链全部修复。

建议：流式下载/校验、限制压缩与展开大小/条目数、全请求期限、明确重定向策略、限制可信 URL。可在拒绝时安全清理 staging，不影响当前有效资源。

## 中优先级：生成目录的父路径符号链接（未修复）

`workDir()` 直接拼接 `<root>/.appshell/<platform>`；Android/iOS/桌面等随后递归清理/写入。若 `.appshell` 父目录是指向仓库外的符号链接，字符串路径仍在仓库里但实际操作可能越界。小程序已有更严格的逐层 symlink 检查，其余平台未统一。

位置：`src/util.mjs` 的 `workDir` / `outDir`，`src/android.mjs`、`src/ios.mjs`、`src/desktop.mjs` 中的 `rmSync` / 写入。

前提：本机工作区已存在不可信的链接或被并发修改；不是任意远程请求直接触发。建议统一真实路径根检查、最小深度和由工具创建的所有权标记；拒绝不可信父路径，避免仅用名称推断可删目录。

## 发布前流程阻塞项

1. **代码权属与第三方许可**：MIT 文件已经添加，但当前目录没有原始提交历史，不能证明所有迁入代码的再分发权。`THIRD_PARTY_NOTICES.md` 是待核验清单，不是全量法律许可完成证明；Gradle jar 等二进制来源和原始摘要需核验。
2. **缺原仓库测试与 CI**：已新增 13 个基本回归，不等于恢复了旧 Node 测试集合。没有自动 CI、完整多平台夹具和真机覆盖。Android Java/Kotlin namespace 和 SDK 导入路径变更尤其需要重新构建验证。
3. **包/仓库身份**：没有指定公开仓库地址与维护者安全联系方式；包名改为中性名称并不证明 npm 名称可注册。正式发布前补 repository、bugs、安全渠道和版本策略。
4. **迁移兼容性**：Android namespace、权限 preferences 名、CSS 变量和 npm 导入路径变化会影响旧应用、扩展和固定快捷方式。已有应用必须显式迁移，不能当作无行为变化的更新。
5. **配置体验**：当前配置仍要求完整 Android/iOS 段，即使只做其他目标；基础示例不附图标或可运行 Web 工程。已有 README 明确这一点，但这还不是完整的“一条命令入门”。
6. **API/文档不完全对齐**：iOS 已有热更新运行时，但 CLI 仍拒绝独立 iOS WebBundle 通道；文档说明了共用 Android 包的限制。桌面 `listScreenSources` 类型缺少实现已支持的 `includeOwnWindows` 参数，可在后续 API 修订补齐。
7. **隐私与保留策略**：录音、上传记录和屏幕回放包含敏感数据，部分存储会保留签名 URL/请求头用于重试。业务需制定删除/过期/退出账号处理策略，并评估本地存储保护；不能仅依靠“位于 app 目录”视为加密。

## 建议下一步

先处理依赖链与更新资源预算，再补多平台构建 CI 和最小可运行示例；最后完成权属/第三方许可核验、安全报告渠道及实际公开发布。不要将本次清理结果描述为“没有安全问题”。
