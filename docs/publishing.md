# 可选发布适配

本项目不提供默认托管服务。`build` 和 `webbundle` 在本机输出产物即可；将 `release` 设为 `null`，无需配置制品服务。

## 安装包与 WebBundle

```json
{
  "release": {
    "artifactService": "https://artifacts.example.com",
    "artifactProject": "example-app"
  }
}
```

这是配置片段；域名必须替换成自己部署的兼容服务。此 API 是现有客户端适配约定，不等于任意对象存储或公共包仓库协议。

```sh
# 在本机/CI secret store 预先安全注入 ARTIFACT_TOKEN，不在命令行写令牌值
appshell publish android --env test --kind app --token-env ARTIFACT_TOKEN
appshell publish desktop --env test --kind webbundle --token-env ARTIFACT_TOKEN
```

文件模式必须显式指定 `--token-env`；Apollo 模式只使用 `_credentials.artifact`，不回退本地令牌。`--candidate` 发布不可变候选版本但不修改渠道。

版本格式为 `<version>-<lane>.<artifactEnvironment>`。平台标识使用 `android`、`macos`、`windows`、`linux`、`harmony`、`*-webbundle` 等；架构和文件格式随目标确定。

## Artifact API 约定

`src/artifact.mjs` 是协议实现的最终依据。管理请求发送 `Authorization: Bearer <token>`，正文为 JSON；服务需返回 `{ item: ... }`。典型流程：

1. `POST /api/v1/projects/{project}/releases`，正文 `{ version, notes }`；返回 release。409 时客户端用 `GET /api/v1/projects/{project}/releases/{version}` 读取已有版本。
2. release 包含 `version`、`status`（`draft` / 已发布 / `yanked`）、`artifacts`。artifact 包含 `platform`、`architecture`、`format`、`status`、`sha256`，未完成项可有 `uploadId`。
3. `POST /api/v1/projects/{project}/releases/{version}/artifacts`，正文 `{ platform, architecture, format, fileName, contentType, sizeBytes, sha256 }`；返回 `{ uploadId, url, method, headers }` 上传票据。
4. 将文件正文上传到票据的 `url`，使用票据方法和请求头；然后 `POST /api/v1/uploads/{uploadId}/complete`，正文 `{}`。
5. 不完整上传可经 `DELETE /api/v1/uploads/{uploadId}` 删除。
6. `POST /api/v1/projects/{project}/releases/{version}/publish`，正文 `{}`，将草稿变成不可变发布。
7. 非候选发布使用 `PUT /api/v1/projects/{project}/channels/stable`，正文 `{ environment, version, platform, architecture }` 绑定渠道。
8. `GET /v1/projects/{project}/latest?environment=...&channel=stable&platform=...&architecture=...&format=...` 返回 `{ item: { version, artifacts: [{ sha256, downloadUrl }] } }`。
9. `GET <downloadUrl>.sha256` 内容必须精确为 `<hex sha256>  <basename>\n`，用于发布后回读验证。

服务端必须自行实现身份验证、项目级授权、文件大小限制、票据有效期、不可变性和渠道并发控制。上传/下载 URL 是受信任服务给出的地址，当前客户端的网络限制与资源上限仍需加强，见 [审计](open-source-audit.md)。

## 热更新查询

客户端热更新不直接消费上述 latest 响应，应用后端需提供简化响应：

```json
{ "version": "1.0.1", "url": "https://downloads.example.com/example-webbundle.zip" }
```

- Android/iOS：`latestUrl` 配置每个环境的查询地址，使用 zip。
- 桌面：向 `apiTarget + apiPath + latestPath` 查询，使用 ustar 格式 tar.gz。
- 下载包旁需有 `.sha256`，包内必须包含 `appshell-build.json` 与 `index.html`。
- iOS 可配置 `bundleAppId` 复用 Android 包；CLI 未提供单独的 iOS WebBundle 发布通道。
- 摘要不是发布者签名；存储、后端和 TLS 信任链被攻破时，当前机制不能独立证明发布者身份。

## 其他平台

- `publish ios --kind app` 上传 App Store Connect / TestFlight，不使用 Artifact 服务。
- `publish miniprogram --kind app --robot 1 --notes ...` 上传微信，不使用 Artifact 服务。
- nsh iOS 自动发布尚未接入，需本地构建后另行分发。
- `publish-file` 可直接发布普通文件，无需应用配置；仍要求兼容制品服务和显式令牌。

所有发布都会对外上传文件；`--dry-run` 只构建和打印计划，不上传。发布账号、托管地址、命名空间与 npm 包名的可用性需维护者自行确认。
