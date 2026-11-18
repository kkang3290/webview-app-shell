import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

import { environment, ConfigError, WEBVIEW_PLATFORMS, NSH_PLATFORMS } from './config.mjs'
import { resolveProject, lockContents, credentialsFor, SOURCE_FILE } from './source.mjs'
import { useContext } from './context.mjs'
import { verifyApollo, packCredentialsCommand } from './apollo-commands.mjs'
import { prebuildHarmony, buildHarmony, doctorHarmony } from './harmony.mjs'
import { AppShellError, PACKAGE_ROOT, log, xcodeprojRuby } from './util.mjs'
import { prebuildAndroid, buildAndroid } from './android.mjs'
import { prebuildIos, buildIos } from './ios.mjs'
import { prebuildDesktop, buildDesktop } from './desktop.mjs'
import { prepareNsh, buildNsh } from './nsh.mjs'
import { prebuildMiniprogram, buildMiniprogram } from './miniprogram.mjs'
import { ArtifactHttpError, createClient, publishRelease, resolveToken } from './artifact.mjs'
import { buildWebBundle, publish } from './publish.mjs'

const USAGE = `appshell — 把 Web 应用打成 Android / iOS 安装包与热更新包

用法：
  appshell config   --env <环境>                       校验并打印解析后的配置
  appshell doctor   [android|ios|miniprogram|harmony]   检查本机工具链（harmony 读当前目录的配置）
  appshell prebuild harmony --env <环境> [--allow-dirty]
  appshell build    harmony --env <环境> --type debug|release [--allow-dirty]
  appshell prebuild <android|ios|desktop|miniprogram> --env <环境> [--allow-dirty]
                                                       生成原生工程到 .appshell/<平台>
  appshell build    <android|ios|desktop> --env <环境> --type debug|release [--simulator] [--os darwin|win32] [--allow-dirty]
  appshell build    miniprogram --env <环境> [--allow-dirty]
                                                       生成并编译，产物在 .appshell/out
  appshell webbundle <android|desktop> --env <环境>     只打热更新包
  appshell publish  <android|ios|desktop|miniprogram> --env <环境> --kind app|webbundle [--os darwin|win32] [--notes 文本] [--dry-run] [--token-env 变量名] [--candidate]

miniprogram（仅 webview 引擎）：prebuild / build 不传 --type；build 输出工程 zip，不是 wxapkg。
  appshell publish miniprogram --env <环境> --kind app --robot <1..30> --notes <说明> [--dry-run]
    使用 APPSHELL_WX_MP_KEY_PATH 上传代码；上传不等于设体验版、提审或上线。不支持 webbundle / --candidate。

harmony（仅 webview 引擎，配置 harmony 段后可用）：prebuild / build --type debug|release / publish --kind app。
  工具链与签名只认 harmony.toolchainEnv / harmony.signing.configEnv 指向的本机 JSON；没有签名只能出未签名 debug HAP。
  不支持 webbundle、--os、--simulator。

nsh 引擎（engine: "nsh"）：build / prebuild / publish 支持 android / ios / desktop / web，不支持 miniprogram / harmony（nsh 0.4.0 没有 OTA）。
                                                       构建并直接发布到 Artifact Service；令牌用 --token-env 显式指定
                                                       --candidate：只上传为候选，不改线上版本，在配置的制品服务中选择上线
                                                       iOS：上传到 App Store Connect（TestFlight），需要环境变量
                                                       APPSHELL_ASC_KEY_PATH / APPSHELL_ASC_KEY_ID / APPSHELL_ASC_ISSUER_ID

签名（证书在打包机上，只认环境变量；都不给就不签）：
  APPSHELL_MAC_IDENTITY   macOS Developer ID 证书名      APPSHELL_WIN_CERT_SHA1  Windows 代码签名证书指纹

发布普通文件（命令行工具、npm 包等不是 App 的产物，不需要 appshell.config.json）：
  appshell publish-file --service <Artifact 地址> --project <项目> --version <版本> --environment <环境>
                        --file <路径> --platform <平台> --architecture <架构> --format <格式> [--file ... 成组重复]
                        [--notes 文本] [--token-env 变量名] [--dry-run]

配置来源（从当前目录向上查找，二选一）：
  appshell.config.json   文件模式：配置在仓库里，签名 / 工具链 / 令牌来自本机环境变量与文件
  appshell.source.json   Apollo 模式：构建配置、工具链、签名材料、上传凭据全部来自 Apollo（见 docs/apollo.md）
                         AccessKey 钥匙串由 appshell.source.json 的 keyringFileEnv 指定；不回退任何本地配置

Apollo 模式命令：
  appshell lock   --env <环境> --out <文件>            读取一次构建配置，写出公开锁文件（不含凭据）；CI 后续任务用 --lock
  appshell apollo verify --env <环境>                  检查各 appId：正确签名可读、无签名与错误签名被拒绝
  appshell credentials pack --type <类型> --input <JSON> --out <文件>
                                                       把本机签名材料打成 Apollo 可导入的 properties 文本（不打印内容）
  其他命令加 --lock <文件>：用锁文件里的构建配置，不再读 Apollo 构建配置（凭据仍按版本现读）`

function platformArg(positionals, command, config) {
  const platform = positionals[0]
  // nsh 引擎额外支持 web（静态站点）
  const allowed = config?.engine === 'nsh' ? NSH_PLATFORMS : WEBVIEW_PLATFORMS
  if (!allowed.includes(platform)) throw new AppShellError(`${command} 需要平台参数：${allowed.join(' / ')}`)
  return platform
}

async function runNsh(command, config, env, positionals, values, allowDirty) {
  const platform = platformArg(positionals, command, config)
  if (command === 'prebuild') {
    prepareNsh(config, env, platform, { allowDirty })
    return 0
  }
  if (command === 'build') {
    if (!values.type) throw new AppShellError('build 需要 --type debug 或 --type release')
    buildNsh(config, env, platform, { type: values.type, allowDirty, simulator: Boolean(values.simulator), os: values.os })
    return 0
  }
  if (command === 'publish') {
    if (allowDirty) throw new AppShellError('publish 不允许 --allow-dirty')
    await publish(config, env, { platform, kind: values.kind, dryRun: Boolean(values['dry-run']), notes: values.notes, os: values.os, tokenEnv: values['token-env'], candidate: Boolean(values.candidate) })
    return 0
  }
  throw new AppShellError(`nsh 引擎不支持 ${command}`)
}

/** 不经 appshell.config.json 的发布：参数全部显式给出，缺一个就报错。 */
async function publishFile(values) {
  for (const key of ['service', 'project', 'version', 'environment']) {
    if (!values[key]) throw new AppShellError(`publish-file 需要 --${key}`)
  }
  const files = values.file ?? []
  if (files.length === 0) throw new AppShellError('publish-file 至少需要一个 --file')
  for (const key of ['platform', 'architecture', 'format']) {
    if ((values[key] ?? []).length !== files.length) throw new AppShellError(`每个 --file 都要配一个 --${key}（成组出现）`)
  }
  const plan = {
    project: values.project, version: values.version, environment: values.environment,
    notes: values.notes ?? values.version,
    candidate: Boolean(values.candidate),
    files: files.map((file, i) => ({ file: path.resolve(file), platform: values.platform[i], architecture: values.architecture[i], format: values.format[i] })),
  }
  if (values['dry-run']) {
    log(`dry-run，未上传。将发布到 ${values.service}：${plan.project}/${plan.version} → ${plan.environment}/stable`)
    for (const f of plan.files) log(`  ${f.platform}/${f.architecture}/${f.format}：${f.file}`)
    return 0
  }
  await publishRelease(createClient(values.service, resolveToken({ tokenEnv: values['token-env'] })), plan)
  return 0
}

function has(command, args) {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0
}

async function doctor(platform, values) {
  const checks = []
  const [major, minor] = process.versions.node.split('.').map(Number)
  checks.push(['Node ≥ 22.18', major > 22 || (major === 22 && minor >= 18)])
  checks.push(['git', has('git', ['--version'])])
  if (!platform || platform === 'android') {
    const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java'
    const version = spawnSync(java, ['-version'], { encoding: 'utf8' })
    checks.push(['JDK 21（JAVA_HOME）', version.status === 0 && /version "21[."]/.test(version.stderr)])
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    checks.push(['Android SDK（ANDROID_HOME）', Boolean(sdk) && fs.existsSync(path.join(sdk, 'platform-tools'))])
  }
  if (!platform || platform === 'ios') {
    checks.push(['Xcode（xcodebuild）', has('xcodebuild', ['-version'])])
    checks.push(['CocoaPods（pod）', has('pod', ['--version'])])
    let ruby = true
    try { xcodeprojRuby() } catch { ruby = false }
    checks.push(['Ruby + xcodeproj gem', ruby])
  }
  checks.push(['zip', has('zip', ['-v'])])
  if (platform === 'harmony') {
    let resolved = null
    try { resolved = await resolveProject(process.cwd(), { envName: values.env, lockFile: values.lock }) } catch (error) { checks.push([`配置：${error.message}`, false]) }
    if (resolved) {
      const restore = useContext(resolved.context)
      try { checks.push(...doctorHarmony(resolved.config)) } finally { restore() }
    }
  } else if (platform === 'miniprogram') {
    // Local generation needs no WeChat key; publish validates it before any build.
    let ci = false
    try {
      createRequire(path.join(PACKAGE_ROOT, 'package.json')).resolve('miniprogram-ci/package.json')
      ci = true
    } catch {}
    checks.push(['miniprogram-ci（随 app-shell 锁定安装）', ci])
  } else {
    checks.push(['nsh（nsh 引擎用）', has('nsh', ['--version'])])
  }
  for (const [name, ok] of checks) process.stdout.write(`${ok ? '✓' : '✗'} ${name}\n`)
  return checks.every(([, ok]) => ok) ? 0 : 1
}

export async function main(argv) {
  const [command, ...rest] = argv
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (command === '--version' || command === '-V') {
    process.stdout.write(`${JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version}\n`)
    return 0
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    options: {
      env: { type: 'string' },
      type: { type: 'string' },
      kind: { type: 'string' },
      notes: { type: 'string' },
      robot: { type: 'string' },
      simulator: { type: 'boolean' },
      os: { type: 'string' },
      'allow-dirty': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'token-env': { type: 'string' },
      candidate: { type: 'boolean' },
      lock: { type: 'string' },
      out: { type: 'string' },
      input: { type: 'string' },
      service: { type: 'string' },
      project: { type: 'string' },
      version: { type: 'string' },
      environment: { type: 'string' },
      file: { type: 'string', multiple: true },
      platform: { type: 'string', multiple: true },
      architecture: { type: 'string', multiple: true },
      format: { type: 'string', multiple: true },
    },
  })
  let restoreContext = () => {}
  try {
    if (command === 'doctor') return await doctor(positionals[0], values)
    if (command === 'publish-file') return await publishFile(values)
    if (command === 'credentials') return packCredentialsCommand(positionals, values)
    if (command === 'apollo') return await verifyApollo(positionals, values)
    const resolved = await resolveProject(process.cwd(), { envName: values.env, lockFile: values.lock })
    if (command === 'lock') {
      if (!values.out) throw new AppShellError('lock 需要 --out <文件>')
      fs.writeFileSync(values.out, JSON.stringify(lockContents(resolved), null, 2) + '\n')
      log(`锁文件：${values.out}（${resolved.source.appId}/${resolved.source.namespace} releaseKey ${resolved.snapshot.releaseKey}）`)
      return 0
    }
    const config = resolved.config
    const env = resolved.env ?? environment(config, values.env)
    restoreContext = useContext(resolved.context)
    // Apollo 模式：本次操作要用的凭据先取回并核对版本，任何构建开始之前就失败
    await resolved.context.prepare(credentialsFor(command, positionals[0], { type: values.type, kind: values.kind, dryRun: Boolean(values['dry-run']) }))
    const allowDirty = Boolean(values['allow-dirty'])
    if (positionals[0] === 'miniprogram') {
      if (config.engine !== 'webview') throw new AppShellError('miniprogram 只支持 webview 引擎')
      for (const key of ['os', 'simulator', 'candidate']) {
        if (values[key] !== undefined) throw new AppShellError(`miniprogram 不支持 --${key}`)
      }
      // Mini Program uploads go to WeChat, so an Artifact token is unused.
      if (values['token-env'] !== undefined && command !== 'publish') throw new AppShellError('miniprogram 不支持 --token-env')
      if (values.type !== undefined) throw new AppShellError('miniprogram 不使用 --type；build 生成工程归档，publish 上传开发版本')
    } else if (values.robot !== undefined) {
      throw new AppShellError('--robot 只用于 publish miniprogram')
    }
    if (values.robot !== undefined && command !== 'publish') throw new AppShellError('--robot 只用于 publish miniprogram')
    if (values.robot !== undefined) {
      if (!/^(?:[1-9]|[12][0-9]|30)$/.test(values.robot)) throw new AppShellError('--robot 必须是 1..30 的整数')
      values.robot = Number(values.robot)
    }
    if (positionals[0] === 'harmony' && command !== 'config') {
      // Checked before any build: never fall through to another platform's branch.
      if (config.engine !== 'webview') throw new AppShellError('harmony 只支持 webview 引擎')
      for (const key of ['os', 'simulator']) {
        if (values[key] !== undefined) throw new AppShellError(`harmony 不支持 --${key}`)
      }
      if (command === 'webbundle') throw new AppShellError('harmony 尚未实现热更新包（webbundle）')
    }
    if (config.engine === 'nsh' && command !== 'config') return await runNsh(command, config, env, positionals, values, allowDirty)
    switch (command) {
      case 'config':
        // 构建配置本身不含签名材料（材料在单独的 namespace），只额外打印公开来源信息
        process.stdout.write(`${JSON.stringify({ ...config, environment: env, configSource: resolved.context.provenance() ?? { source: 'file' } }, null, 2)}\n`)
        return 0
      case 'prebuild': {
        const platform = platformArg(positionals, command)
        if (platform === 'android') prebuildAndroid(config, env, { allowDirty, type: 'debug' })
        else if (platform === 'ios') prebuildIos(config, env, { allowDirty })
        else if (platform === 'desktop') prebuildDesktop(config, env, { allowDirty, debug: true })
        else if (platform === 'miniprogram') prebuildMiniprogram(config, env, { allowDirty })
        else if (platform === 'harmony') await prebuildHarmony(config, env, { allowDirty })
        else throw new AppShellError(`prebuild 不支持平台 ${platform}`)
        return 0
      }
      case 'build': {
        const platform = platformArg(positionals, command)
        if (platform === 'miniprogram') {
          buildMiniprogram(config, env, { allowDirty })
          return 0
        }
        if (!values.type) throw new AppShellError('build 需要 --type debug 或 --type release')
        if (values.os && platform !== 'desktop') throw new AppShellError('--os 只用于 desktop')
        if (platform === 'android') {
          if (values.simulator) throw new AppShellError('--simulator 只用于 iOS')
          buildAndroid(config, env, { type: values.type, allowDirty })
        } else if (platform === 'desktop') {
          buildDesktop(config, env, { type: values.type, allowDirty, os: values.os })
        } else if (platform === 'harmony') {
          await buildHarmony(config, env, { type: values.type, allowDirty })
        } else if (platform === 'ios') {
          buildIos(config, env, { type: values.type, allowDirty, simulator: Boolean(values.simulator) })
        } else {
          throw new AppShellError(`build 不支持平台 ${platform}`)
        }
        return 0
      }
      case 'webbundle':
        buildWebBundle(config, env, platformArg(positionals, command))
        return 0
      case 'publish':
        if (allowDirty) throw new AppShellError('publish 不允许 --allow-dirty')
        await publish(config, env, {
          platform: platformArg(positionals, command), kind: values.kind, dryRun: Boolean(values['dry-run']),
          notes: values.notes, os: values.os, tokenEnv: values['token-env'], candidate: Boolean(values.candidate), robot: values.robot,
        })
        return 0
      default:
        throw new AppShellError(`未知命令 ${command}\n\n${USAGE}`)
    }
  } catch (error) {
    if (error instanceof AppShellError || error instanceof ConfigError || error instanceof ArtifactHttpError) {
      log(error.message)
      return 1
    }
    throw error
  } finally {
    // 删除本次落盘的签名材料（成功、失败都执行）
    restoreContext()
  }
}
