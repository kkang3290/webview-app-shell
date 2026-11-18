# 微信小程序（webview 引擎）

`miniprogram` 是 `webview` 的目标，不是第三个引擎；`nsh` 不支持它。小程序页面用 `<web-view>` 加载已经部署的 HTTPS 网站，**不会把 React/Vue 转成 WXML，也不会内置 Web dist**。

## 配置

在现有完整 webview 配置中显式增加：

```json
{
  "miniprogram": {
    "appId": "wx0000000000000000",
    "version": "0.1.0",
    "libVersion": "3.7.6",
    "entryPath": "/login",
    "extension": null
  },
  "environments": {
    "test": {
      "miniprogram": {
        "siteOrigin": "https://test.example.com",
        "apiOrigin": "https://api.test.example.com"
      }
    }
  }
}
```

这只是新增字段片段，其余 webview 配置仍须完整。`version` 是小程序独立版本线，不读取 `app.version` 或 Web 版本环境变量。
`libVersion` 锁定基础库；`siteOrigin` 不含尾斜线、路径、查询、凭据；`apiOrigin` 供业务原生页使用，不用则写 `null`。
`entryPath` 是站内路径，可带查询/hash，拒绝 URL、协议相对地址、路径穿越、反斜线、控制字符及多层编码绕过。

小程序是可选目标（与 Harmony 相同的 opt-in）：不启用时顶层及每个环境的 `miniprogram` 省略或写 `null`，0.17.0 之前写的配置不用补字段。
启用后每个环境都必须写 `miniprogram` 对象；不启用却在某个环境写了对象会报错。不从 `desktop` 或其他环境回退。
**启用需要 app-shell ≥ 0.17.0**：更旧的 CLI 不认识 `miniprogram` 字段，业务 CI 固定版本要先升级。

## 命令与产物

```sh
appshell doctor miniprogram
appshell prebuild miniprogram --env test
appshell build miniprogram --env test
appshell publish miniprogram --env test --kind app --robot 1 --notes '小程序网页壳首版' --dry-run
```

- `prebuild`：生成 `.appshell/miniprogram/`，用微信开发者工具导入该目录（不是内层 `miniprogram/`）。
- `build`：再输出 `.appshell/out/<App>-miniprogram-<version>-<env>.zip` 及 `.sha256`。这是**源码工程归档，不是 wxapkg**；本地生成不需要上传密钥、微信登录或 Web 构建工具。
- `publish`：构建后用锁定的 `miniprogram-ci` 编译上传开发版本。`--robot` 是 1–30 整数，`--notes` 必须显式提供、非空且至多 1024 UTF-8 字节；不要在说明中放敏感数据。
- `--dry-run`：生成工程/归档、返回计划，不加载上传 SDK、不读取私钥、不连接微信上传。
- 无 `--type` 区分；本地 `prebuild/build` 可 `--allow-dirty`（来源清单明确记录），真实 publish 和 dry-run publish 均要求干净提交。
- 不支持 `webbundle`、`--candidate`、`--os`、`--simulator`。小程序不走 Artifact Service：`publish` 接受但不使用 `--token-env`，其他命令带 `--token-env` 仍报错。

工程根的 `appshell-build.json` 记录 AppID、小程序版本、基础库版本、环境、源码提交、dirty、时间、工程摘要。
上传前再次核验当前源码与摘要。清单不能证明远程网站内容固定为该提交；网站有自己的部署与版本。
所有生成目录应加入业务仓库 `.gitignore`，扩展命令不能修改已跟踪源码。

### 真上传前置

1. 微信后台确认主体支持 `web-view`，配置业务域名；网页内 iframe 也受域名要求约束。
2. 下载该小程序的**代码上传私钥**，在构建机上通过单一变量指定：

   ```sh
   export APPSHELL_WX_MP_KEY_PATH=/secure/location/private.wx-example.key
   appshell publish miniprogram --env test --kind app --robot 1 --notes '小程序网页壳首版'
   ```

3. 设置上传出口 IP 白名单。私钥不能放在生成工程或扩展目录内，不读 AppSecret，不把凭据写入配置/包/日志。
4. 上传成功之后，在微信后台分别管理体验版、提审、审核和正式发布。**上传不等于任何一个后续状态。**

业务域名、请求/socket/upload/download 合法域名是微信控制台配置，app-shell 不会自动开通。

## 原生业务扩展

通用壳只拥有 `pages/web/index`；产品的分享阅读器、扫码入口等由业务仓库保持单一源码，通过命令生成扩展：

```json
{
  "extension": {
    "command": ["node", "scripts/export-miniprogram.ts"],
    "dir": ".appshell/miniprogram-extension"
  }
}
```

命令从业务仓库根运行，不经过 shell，收到 `APPSHELL_PLATFORM=miniprogram`、`APPSHELL_ENV` 和绝对路径 `APPSHELL_EXTENSION_DIR`。
它必须在 `dir` 中生成原生文件及 `appshell-extension.json`，清单的五个键全部显式提供：

```json
{
  "pages": ["pages/share/index", "pages/scan/index"],
  "subPackages": [{ "root": "media/part1", "pages": [] }],
  "window": {},
  "usingComponents": {},
  "appEntry": "lifecycle.ts"
}
```

- 页面用扩展根的相对路径，不含后缀；每页必须有 `.ts`、`.wxml`、JSON 对象 `.json`。全局 `usingComponents` 同样指向本地真实组件，组件 JSON 必须有 `component: true`。
- `subPackages` 只收 `root`、`pages`；支持资源专用分包 `pages: []`。拒绝重复/重叠 root、重复页面和位于分包内的主包页面。
- `window` 只收导航标题/背景/文字样式、导航样式、背景颜色/文字样式、`enablePullDownRefresh`、`onReachBottomDistance`；不会任意合并原生 `app.json` 字段。
- `appEntry` 没有时写 `null`；否则是 `.ts` 生命周期模块，可命名导出 `onLaunch`、`onShow`，通用 App 保留 `this` 和参数调用。**模块不能再次调用 `App()`**。根 `app.wxss` 可提供全局样式。
- 扩展根 `app.ts` / `app.js` / `app.json`、`pages/web`、生成环境和路径工具、项目配置及构建清单保留给通用壳；同名文件、隐藏文件、密钥文件、符号链接及特殊文件会被拒绝。
- 当前不支持透传 `style`、`lazyCodeLoading`、`sitemapLocation`、tabBar、插件等其他 `app.json` 能力。迁移原生项目时应明确处理这些差异，不能直接复制整个旧项目当扩展。

迁移已有小程序时，请通过扩展保留对外路由。`extension: null` 仅表示网页容器，不可直接覆盖已有原生分享、扫码或其他页面。

## 容器及 Web SDK 边界

容器只允许在所选 `siteOrigin` 下加载配置入口或 `pages/web/index?path=${encodeURIComponent(sitePath)}`；
运行时只解开这一层路径参数，再用共享校验拒绝外部 URL 与多层编码穿越；不读取 `src/url` 参数。
无效外部 path 忽略并回到配置入口，加载失败提供同环境重试。通用分享只分享通用入口，不复制当前网页地址、私有路径或 URL 中的凭据。
公开业务分享应交给业务扩展，禁止把登录态和短期签名 URL 放入卡片。

SDK `shellPlatform()` 通过官方标记或 UA `miniProgram` 返回 `miniprogram`；标记可能在 `WeixinJSBridgeReady` 后才出现。
微信普通内置浏览器、仅加载 JSSDK 都不等于小程序。SDK 不伪装 Capacitor，不注册原生录音/支付插件。

- 可先沿用网站已有短信登录与 Web 会话，不必为了套壳先做 `wx.login`。
- `wx.miniProgram.postMessage` 在后退/销毁/分享等特定时机才交付，**不能当实时 RPC 或音频桥**。
- `web-view` 铺满页面并覆盖其他组件，不能叠原生录音工具栏；原生能力应跳转独立原生页面运行完整流程。
- 原生录音、会话交接、微信支付、文件下载/导出兼容不在此版本实现；浏览器 API 是否可用须在目标微信真机验证。
- 网页更新走网站部署，不走 app-shell WebBundle；壳和扩展变化需要重新上传。远程网页同样受微信规则约束。

## 验证状态

执行 `npm run check` 检查当前已有的 Node 回归测试；这些测试不是完整小程序验收。微信开发者工具编译、真机运行、扩展兼容与真实上传需使用自己的资质、域名及上传权限单独验证。

官方参考：[web-view](https://developers.weixin.qq.com/miniprogram/dev/component/web-view.html)、[CI](https://developers.weixin.qq.com/miniprogram/dev/devtools/ci.html)。
