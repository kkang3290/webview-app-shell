// 发版：app-shell 是唯一的发布入口，直接调 Artifact Service（不可变版本 + 环境渠道）。
// 发布版本格式：<版本>-<lane>.<artifact 环境>。
import fs from 'node:fs'
import path from 'node:path'

import { buildWeb } from './web.mjs'
import { webVersion } from './config.mjs'
import { fail, log, run, outDir, artifactName, writeSha256 } from './util.mjs'
import { createClient, publishRelease } from './artifact.mjs'
import { operationContext } from './context.mjs'
import { buildAndroid } from './android.mjs'
import { buildDesktop } from './desktop.mjs'
import { buildNsh } from './nsh.mjs'
import { buildHarmony } from './harmony.mjs'
import { buildIos, uploadTestFlight } from './ios.mjs'
import { publishMiniprogram } from './miniprogram.mjs'

/**
 * Artifact Service 使用的桌面平台标识：
 * macos / windows / linux，而不是 Node 的 darwin / win32。已安装的客户端按这个名字找新版本。
 */
export function artifactPlatform(os) {
  if (os === 'darwin') return 'macos'
  if (os === 'win32') return 'windows'
  if (os === 'linux') return 'linux'
  fail(`不支持的桌面系统 ${os}`)
}

export function releaseVersion(version, lane, artifactEnvironment) {
  return `${version}-${lane}.${artifactEnvironment}`
}

/**
 * 桌面热更新包：桌面用的网页构建（与安装包里烘进去的同一种）+ 清单，打成 ustar 格式的 tar.gz。
 * 只能是 ustar：桌面端的解包器不认长名扩展。
 */
export function buildDesktopWebBundle(config, env) {
  if (!config.desktop) fail('appshell.config.json 没有配置 desktop')
  if (!config.capabilities.includes('hotUpdate')) fail('未启用 hotUpdate 能力，不产出热更新包')
  const web = buildWeb(config, {
    platform: 'desktop', env, appId: config.desktop.appId, build: 0, allowDirty: false,
    web: config.desktop.web, buildEnv: env.desktop.buildEnv,
  })
  const version = webVersion(config)
  const target = path.join(outDir(config), artifactName(config, 'webbundle-desktop', version, env.name, '.tar.gz'))
  fs.rmSync(target, { force: true })
  run('tar', ['--format', 'ustar', '-czf', target, '-C', web.dir, '.'])
  const sha = writeSha256(target)
  log(`桌面热更新包：${target}\nSHA-256：${sha}`)
  return { file: target, version, sha256: sha }
}

/** 热更新包：Web 产物 + 外壳清单打成 zip。只收干净源码。 */
export function buildWebBundle(config, env, platform) {
  if (platform === 'miniprogram') fail('miniprogram 不支持 webbundle：网页走网站部署，小程序代码走微信上传')
  if (platform === 'harmony') fail('harmony 尚未实现热更新包（webbundle）')
  if (!['android', 'ios', 'desktop'].includes(platform)) fail(`不支持的热更新平台 ${platform}`)
  if (platform === 'desktop') return buildDesktopWebBundle(config, env)
  const appId = platform === 'android' ? config.android.applicationId : config.ios.bundleId
  const build = platform === 'android' ? config.android.versionCode : config.ios.buildNumber
  if (!config.capabilities.includes('hotUpdate')) fail('未启用 hotUpdate 能力，不产出热更新包')
  if (platform === 'ios') fail('iOS 尚未实现 hotUpdate（WebBundleUpdater），不能发布 iOS 热更新包')
  const web = buildWeb(config, { platform, env, appId, build, allowDirty: false })
  const version = webVersion(config)
  const target = path.join(outDir(config), artifactName(config, `webbundle-${platform}`, version, env.name, '.zip'))
  fs.rmSync(target, { force: true })
  run('zip', ['-q', '-r', '-X', target, '.'], { cwd: web.dir })
  const sha = writeSha256(target)
  log(`热更新包：${target}\nSHA-256：${sha}`)
  return { file: target, version, sha256: sha }
}

function nshArtifact(config, env, { platform, kind, os }) {
  if (kind !== 'app') fail('nsh 引擎的 --kind 只能是 app（nsh 0.4.0 还没有 OTA 热更新包）')
  if (platform === 'ios') fail('iOS 安装包走 App Store Connect / TestFlight，不经 Artifact Service')
  const built = buildNsh(config, env, platform, { type: 'release', allowDirty: false, os })
  const osName = platform === 'desktop' ? artifactPlatform(os) : platform
  return { version: config.app.version, lane: `nsh-${osName}`, files: built.artifacts.map(a => ({
    // nsh 0.4.0 桌面包只含构建机本身的架构（没有 --arch）；Android APK 默认带 arm64-v8a + armeabi-v7a
    file: a.file, platform: osName,
    architecture: osName === 'android' ? 'universal' : process.arch === 'arm64' ? 'arm64' : 'x64',
    format: a.format,
  })) }
}

export async function publish(config, env, { platform, kind, dryRun, notes, tokenEnv, candidate = false, os, robot }) {
  if (platform === 'miniprogram') {
    if (config.engine !== 'webview') fail('miniprogram 只支持 webview 引擎')
    if (kind !== 'app') fail('miniprogram 的 --kind 只能是 app；网页更新使用网站部署')
    // tokenEnv is accepted and unused: the upload goes to WeChat, not Artifact Service (same as iOS).
    if (candidate || os !== undefined) fail('miniprogram 不支持 --candidate / --os；上传后在微信后台管理版本')
    return publishMiniprogram(config, env, { dryRun, notes, robot })
  }
  if (robot !== undefined) fail('--robot 只用于 publish miniprogram')
  os ??= process.platform
  if (config.engine !== 'nsh' && platform === 'ios') {
    // iOS 安装包不经 Artifact Service：传到 App Store Connect，由 TestFlight / App Store 分发
    if (kind !== 'app') fail('iOS 的 --kind 只能是 app（iOS 外壳没有热更新包）')
    if (candidate) fail('iOS 没有 --candidate：上传后在 App Store Connect 里决定给哪些测试员、是否提交审核')
    const key = operationContext().ascKey()
    if (!key) fail(operationContext().source === 'apollo'
      ? '上传 TestFlight 需要 App Store Connect API 密钥：Apollo 构建配置的 _credentials 里没有 appleAsc'
      : '上传 TestFlight 需要 App Store Connect API 密钥：设置 APPSHELL_ASC_KEY_PATH / APPSHELL_ASC_KEY_ID / APPSHELL_ASC_ISSUER_ID')
    const built = buildIos(config, env, { type: 'release', allowDirty: false, simulator: false })
    if (dryRun) {
      log(`dry-run，未上传。将传到 App Store Connect：${config.ios.bundleId} ${config.ios.version} (${config.ios.buildNumber})：${built.file}`)
      return { artifact: { file: built.file } }
    }
    uploadTestFlight(built.file, key)
    return { artifact: { file: built.file } }
  }
  if (config.release === null) fail('release 为 null：Artifact 发布需要配置 release.artifactService / artifactProject；本地构建可用 build 或 webbundle')
  let artifact
  if (config.engine === 'nsh') {
    artifact = nshArtifact(config, env, { platform, kind, os })
  } else if (platform === 'harmony') {
    if (kind !== 'app') fail('harmony 的 --kind 只能是 app（尚未实现热更新包）')
    const built = await buildHarmony(config, env, { type: 'release', allowDirty: false })
    if (!built.signed) fail('未签名的 HAP 不能发布')
    artifact = { version: config.harmony.version, lane: 'harmony', file: built.file, platform: 'harmony',
      architecture: 'universal', format: 'hap' }
  } else if (kind === 'app' && platform === 'desktop') {
    const built = buildDesktop(config, env, { type: 'release', allowDirty: false, os })
    const osName = artifactPlatform(os)
    artifact = { version: config.desktop.version, lane: `desktop-${osName}`,
      files: built.artifacts.map(a => ({ file: a.file, platform: osName, architecture: a.arch, format: a.format })) }
  } else if (kind === 'app') {
    const built = buildAndroid(config, env, { type: 'release', allowDirty: false })
    artifact = { version: config.app.version, lane: 'android', file: built.file, platform: 'android',
      architecture: 'universal', format: 'apk' }
  } else if (kind === 'webbundle') {
    const bundle = buildWebBundle(config, env, platform)
    artifact = { version: bundle.version, lane: `${platform}-webbundle`, file: bundle.file,
      platform: `${platform}-webbundle`, architecture: 'universal', format: platform === 'desktop' ? 'tar.gz' : 'zip' }
  } else {
    fail('--kind 只能是 app 或 webbundle')
  }
  const files = artifact.files ?? [{ file: artifact.file, platform: artifact.platform, architecture: artifact.architecture, format: artifact.format }]
  const plan = {
    project: config.release.artifactProject,
    version: releaseVersion(artifact.version, artifact.lane, env.artifactEnvironment),
    environment: env.artifactEnvironment,
    notes: notes ?? `${config.app.name} ${artifact.lane} ${env.name}`,
    files,
    candidate,
  }
  if (dryRun) {
    log(`dry-run，未上传。将发布到 ${config.release.artifactService}：${plan.project}/${plan.version} → ${candidate ? '候选（不上线）' : `${plan.environment}/stable`}`)
    for (const f of files) log(`  ${f.platform}/${f.architecture}/${f.format}：${f.file}`)
    return { artifact, plan }
  }
  const client = createClient(config.release.artifactService, operationContext().artifactToken({ tokenEnv }))
  return publishRelease(client, plan).then(urls => ({ artifact, plan, urls }))
}
