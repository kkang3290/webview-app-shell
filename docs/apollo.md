# Apollo 配置模式

可选适配，需要自行部署 Apollo 并强制 ConfigService 客户端鉴权；普通本地构建不依赖此服务。以下全部域名、namespace 与路径为占位示例，不表示已部署。

业务仓库放 `appshell.source.json`（代替 `appshell.config.json`，两者只能有一个）后，构建配置、工具链、签名材料、上传凭据全部来自 Apollo。仓库里只剩“配置在哪”。选了 Apollo 就**不回退**任何本地文件、环境变量或其他环境：缺配置、读不到、未发布、版本对不上都会在构建开始前失败。

## 仓库入口

```json
{
  "schemaVersion": 1,
  "source": "apollo",
  "appId": "appshell",
  "cluster": "default",
  "namespace": "example.build",
  "keyringFileEnv": "APPSHELL_APOLLO_KEYRING_FILE",
  "environments": {
    "test": { "endpoint": "https://apollo.test.example.com" },
    "pre":  { "endpoint": "https://apollo.pre.example.com" },
    "prod": { "endpoint": "https://apollo.example.com" }
  }
}
```

- 每个环境对应一套 Apollo（示例按 test / pre / prod 分开部署）。每套 Apollo 里的构建配置只写**自己这个环境**：`environments` 里只有这一个键。
- `cluster` 是 Apollo 的集群名（一般 `default`），不是 Kubernetes 集群。

## 钥匙串（唯一留在 Apollo 外面的东西）

Apollo 不能从自己里面取自己的访问密钥，所以每台机器 / 每个 CI 任务要有一份钥匙串 JSON：

```json
{ "appshell": "<该环境的 AccessKey>" }
```

用 `keyringFileEnv` 指定的环境变量指向它（绝对路径）。每个环境使用自己的钥匙串，不要把 Portal 登录密码交给 CI。app-shell 会移除子进程可见的钥匙串路径变量；这不是沙箱，同机不可信代码仍不能与私钥共享运行环境。

## 一个应用，多个 namespace

使用一个专用 `appshell` 应用即可。namespace 是同一应用内部的配置分组，不是额外应用。构建配置和材料仍分组保存，避免 `config` / `lock` 把签名内容当公开配置导出。

**AccessKey 是 appId 级读取权限**：持有 `appshell` 密钥的主体能读取该环境下全部 namespace，包括以后加入的其他平台材料。单应用方案便于管理，但不具备平台间密钥读取隔离；只给可信、隔离的构建机使用，不向不可信 MR job 提供此密钥。如果以后需要平台间隔离，再拆 appId，代码同样支持。

| appId | namespace（properties 格式） | 内容 |
| --- | --- | --- |
| `appshell` | `example.build` | 构建配置，不存签名密码/材料 |
| `appshell` | `example.harmony` | 鸿蒙签名材料，按需创建 |
| `appshell` | `example.android`（按需创建） | Android keystore |
| `appshell` | `example.appleAsc`（按需创建） | ASC API 密钥 |
| `appshell` | `example.wechat`（按需创建） | 小程序上传私钥 |
| `appshell` | `example.artifact`（按需创建） | Artifact 发布令牌 |

初始化阶段 `_credentials` 为 `{}`；没有材料不填假引用，也不把 debug Profile 当生产签名。其他业务可在同一应用使用自己的前缀，但仍共享同一 appId 读取权限。

### 构建配置 `example.build`

每个 `appshell.config.json` 顶层字段一项，值是 JSON；另加三项：

| 配置项 | 值 |
| --- | --- |
| `schemaVersion` | `1` |
| `app`、`web`、`environments`、`android`、`ios`、`harmony`… | 与 docs/config.md 相同的 JSON，同样严格校验 |
| `_tools` | 构建机上的工具链，如 `{"harmony":{"nodeHome":…,"sdkHome":…,"hvigorw":…,"javaHome":…,"hapSignTool":…},"desktop":{"macIdentity":null,"macKeychain":null,"winCertSha1":null}}`；没有写 `{}` |
| `_credentials` | 每种凭据在哪、期望哪个版本，如 `{"harmony":{"appId":"appshell","namespace":"example.harmony","version":"harmony-debug-2026-11"}}`；没有写 `{}` |

Apollo 模式下这几个指向本机的字段**不能写**（会报未知字段）：`android.signing`、`harmony.toolchainEnv`、`harmony.signing`。

### 凭据

用 `appshell credentials pack` 在本机把材料打成 Apollo 可导入的文本，不要手写：

```bash
# input.json 里有密码：只在本机建，打完就删
umask 077
work=$(mktemp -d)
cat > "$work/harmony-input.json" <<'EOF'
{
  "version": "harmony-debug-2026-11",
  "files": {
    "storeFile": "/secure/appshell/harmony/example-debug/example-debug.p12",
    "certpath": "/secure/appshell/harmony/example-debug/example-debug.cer",
    "profile": "/secure/appshell/harmony/example-debug/example-debug.p7b"
  },
  "fields": { "storePassword": "…", "keyPassword": "…", "keyAlias": "example-debug", "signAlg": "SHA256withECDSA" }
}
EOF
appshell credentials pack --type harmony --input "$work/harmony-input.json" --out "$work/harmony.properties"
```

在 Apollo Portal 对应 appId 下建 properties namespace，切到「文本」编辑，粘贴 `$work/harmony.properties` 的内容并发布，然后删除两个临时文件。

各类型需要的文件与字段：

| `--type` | files | fields |
| --- | --- | --- |
| `harmony` | `storeFile`（.p12）、`certpath`（.cer）、`profile`（.p7b） | `storePassword`、`keyPassword`、`keyAlias`、`signAlg` |
| `android` | `storeFile`（keystore） | `storePassword`、`keyAlias`、`keyPassword` |
| `appleAsc` | `p8` | `keyId`、`issuerId` |
| `wechat` | `privateKey` | 无 |
| `artifact` | 无 | `token` |

文件以 base64 分片存（每片不超过 19000 字符，适应 Apollo 默认的单项长度上限），同时存字节数和 SHA-256；读取时缺片、损坏、多余项、版本不符都直接失败。

**换材料**：新建一个 namespace（例如 `harmony-debug-v2`）发布新版本，再改 `build` 里 `_credentials` 的 namespace 和 version。旧 namespace 先别改，正在跑的流水线还会用到。

## 导入真实材料之前：先验证鉴权

Portal 里能编辑 ≠ ConfigService 拒绝未授权读取；建了 AccessKey 也不代表服务端在强制校验。先发布 `build`（可以先不放凭据），每个环境跑：

```bash
APPSHELL_APOLLO_KEYRING_FILE=/path/keyring.json appshell apollo verify --env test
```

逐个引用的 namespace 检查正确签名可读、无签名被拒、错误密钥被拒。只有凭据来自不同 appId 时，才检查构建配置的密钥读不了它；同 appId 会明确提示没有读取权限隔离。没有在 `_credentials` 引用的空材料 namespace 需单独用非敏感标记测试。**有任何一项 ✗，就不要把签名材料导入 Apollo**。

## 安全须知

- Apollo 的数据库、备份和发布历史会永久保留导入过的材料；base64 不是加密。删掉当前配置不等于材料消失，泄漏时要到华为 / 苹果 / 微信后台吊销重发。
- 能编辑 / 发布 `build` 的人能改构建命令（如 `web.command`），等于能在持有签名材料的构建机上执行代码。只给可信的人。
- 材料只在需要签名的那一步写到仓库外的私有临时目录（目录 0700、文件 0600），结束（含失败、Ctrl+C）即删除；不进环境变量、日志、生成工程、产物清单或 CI artifacts。
- 鸿蒙签名工具只接受命令行传密码，签名那几秒同机其他用户能从进程列表看到：构建机要专用。

## CI：一次读取，全程一致

```bash
appshell lock --env test --out .appshell/lock.json      # 规划任务：读一次构建配置，写公开锁文件（不含凭据）
appshell publish harmony --env test --kind app --lock .appshell/lock.json   # 各平台任务：用锁里的配置
```

锁文件仅应传递经审查不含签名秘密的构建 namespace。凭据仍按 `_credentials.version` 核对；当前尚未用凭据 `releaseKey` 强制锁定，若修改材料却不改 version，现有校验不能发现这种版本漂移，因此不要宣称完整配置冻结已实现。产物清单记录公开构建配置 `configSource`（appId / namespace / releaseKey / 配置摘要）。

## 当前范围

已接入 Apollo：构建配置、鸿蒙工具链与签名、Android 签名、App Store Connect 密钥（iOS 上传 / 构建授权、mac 公证）、小程序上传私钥、Artifact 令牌，以及桌面签名身份（`_tools.desktop`，证书须已在构建机钥匙串 / 证书库里）。

尚未接入（Apollo 模式下会明确失败或沿用构建机现有状态，不会悄悄读环境变量）：从 Apollo 导入苹果分发证书 / 描述文件到临时钥匙串、Windows PFX 导入、nsh 引擎（Apollo 模式直接拒绝）。
