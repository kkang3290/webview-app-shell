// 桌面端（Electron）：模板 + 同源网页版构建 → .appshell/desktop，electron-builder 出 dmg / exe。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

import { buildWeb, sourceState } from './web.mjs'
import { ascKeyFromEnv } from './ios.mjs'
import { operationContext } from './context.mjs'
import { IOS_USAGE_KEYS } from './config.mjs'
import { TEMPLATES, fail, log, run, copyDir, workDir, outDir, artifactName, writeSha256 } from './util.mjs'

const TEMPLATE = path.join(TEMPLATES, 'desktop')
// 外壳钉死的 Electron 版本：electron-builder 按它下载对应平台的运行时（不装 electron 这个 npm 包，
// 那个包的安装脚本会去 GitHub 下载开发用的二进制，与打包无关）。
export const ELECTRON_VERSION = '45.2.3'
const require = createRequire(import.meta.url)

/** macOS 的权限说明文字复用 iOS 那份（同一个产品对用户说同样的话）。 */
export function macUsageDescriptions(config) {
  const out = {}
  for (const name of ['microphone', 'camera']) {
    if (config.permissions.includes(name)) out[IOS_USAGE_KEYS[name]] = config.ios.usageDescriptions[IOS_USAGE_KEYS[name]]
  }
  // desktop.mac.usageDescriptions：桌面专有的说明（系统声音等），同名时以它为准
  return { ...out, ...config.desktop.mac.usageDescriptions }
}

export const DESKTOP_CAPABILITIES = ['recording', 'backgroundUpload', 'hotUpdate', 'windows', 'system', 'screenCapture']

export function desktopShellJson(config, env, { debug }) {
  const desktop = config.desktop
  return {
    schemaVersion: 1,
    appName: config.app.name,
    appId: desktop.appId,
    environment: env.name,
    apiPath: desktop.apiPath,
    apiTarget: env.desktop.apiTarget,
    publicOrigin: env.desktop.publicOrigin,
    appVersion: desktop.version,
    // 业务扩展（desktop.extension）是否随包：主进程据此加载 extension/main.js
    extension: desktop.extension !== null,
    scheme: desktop.scheme,
    window: desktop.window,
    permissions: config.permissions,
    // 桌面端实现的能力组；wechat / push 尚未在桌面实现。
    capabilities: config.capabilities.filter(name => DESKTOP_CAPABILITIES.includes(name)),
    hotUpdate: config.capabilities.includes('hotUpdate') ? desktop.hotUpdate : null,
    debug,
  }
}

/**
 * 签名身份只从环境变量来（证书在打包机上，不进配置文件）：
 *   APPSHELL_MAC_IDENTITY   macOS Developer ID 证书名（不带 "Developer ID Application:" 前缀）。同时给了
 *                           APPSHELL_ASC_KEY_PATH / _ID / _ISSUER_ID（与 iOS 同一组）就顺带公证；只签名不公证的包首次打开仍会被拦
 *   APPSHELL_MAC_KEYCHAIN   可选：证书所在的钥匙串文件（打包专用钥匙串），不给就用默认搜索列表
 *   APPSHELL_WIN_CERT_SHA1  Windows 证书存储里代码签名证书的 SHA-1 指纹（如 DigiCert KeyLocker certsync 后的证书）
 * 都没给就不签：mac 包补 ad-hoc 签名，首次打开要右键「打开」。
 */
export function signingFromEnv(env = process.env) {
  return {
    ...(env.APPSHELL_MAC_IDENTITY ? { macIdentity: env.APPSHELL_MAC_IDENTITY } : {}),
    ...(env.APPSHELL_WIN_CERT_SHA1 ? { winCertSha1: env.APPSHELL_WIN_CERT_SHA1.trim() } : {}),
  }
}

/**
 * electron-builder 认 APPLE_API_KEY 这组变量做公证；从 App Store Connect 密钥映射过去。
 * 文件模式下已经显式给了的不覆盖；Apollo 模式只用 Apollo 的 appleAsc 凭据（key 由调用方传入）。
 */
export function notarizeEnv(env = process.env, key = undefined) {
  if (key === undefined && env.APPLE_API_KEY) return {}
  if (key === undefined) key = ascKeyFromEnv(env)
  if (!key) {
    log('没有给 App Store Connect 密钥（APPSHELL_ASC_KEY_*），mac 包只签名不公证')
    return {}
  }
  return { APPLE_API_KEY: key.path, APPLE_API_KEY_ID: key.id, APPLE_API_ISSUER: key.issuer }
}

/**
 * 正式包关掉调试入口：否则本机任何进程都能用 --inspect / ELECTRON_RUN_AS_NODE / NODE_OPTIONS 在主进程里跑代码，
 * 借用 App 的麦克风、屏幕录制授权。Debug 包保留（自动化验证要用）。
 * 不走 electron-builder 的 electronFuses：它补 ad-hoc 签名时按路径里第一个 ".app" 截断，生成目录 .appshell 正好踩中；
 * 改由 afterPack 在补签名之前翻转（build/fuses.json）。Cookie 加密、asar 完整性校验先不开：前者让 ad-hoc 签名的包
 * 每次升级都弹钥匙串，后者在 Windows 上还没验证过。
 */
export const RELEASE_FUSES = {
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  onlyLoadAppFromAsar: true,
}

export function builderConfig(config, { debug, targets, signing = {} }) {
  const name = config.app.name.replace(/[^A-Za-z0-9]+/g, '')
  if (signing.winCertSha1 !== undefined && !/^[a-f\d]{40}$/i.test(signing.winCertSha1)) {
    fail('APPSHELL_WIN_CERT_SHA1 必须是代码签名证书的 40 位 SHA-1 指纹')
  }
  return {
    appId: config.desktop.appId,
    productName: config.app.name,
    electronVersion: ELECTRON_VERSION,
    directories: { output: 'release', buildResources: 'build' },
    files: ['main.js', 'preload.js', 'lib/**', 'appshell.json', 'package.json', 'tray.png',
      ...(config.desktop.extension ? ['extension/**'] : [])],
    extraResources: [{ from: 'web', to: 'web' }],
    asar: true,
    ...(config.desktop.extension && config.desktop.extension.asarUnpack.length
      ? { asarUnpack: config.desktop.extension.asarUnpack.map(glob => `extension/${glob}`) } : {}),
    npmRebuild: false,
    // 写各语言的权限弹窗文案，并在没有签名证书时补 ad-hoc 签名（Apple Silicon 上完全没签名的包起不来）
    afterPack: 'build/after-pack.cjs',
    ...(config.desktop.scheme ? { protocols: [{ name: config.app.name, schemes: [config.desktop.scheme] }] } : {}),
    mac: {
      category: 'public.app-category.productivity',
      icon: 'build/icon.png',
      target: targets.mac,
      hardenedRuntime: true,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.plist',
      // 没有给 APPSHELL_MAC_IDENTITY 时不签名（afterPack 补 ad-hoc）：首次打开要右键「打开」一次。
      identity: signing.macIdentity ?? null,
      ...(signing.macIdentity ? { notarize: true } : {}),
      extendInfo: macUsageDescriptions(config),
      signIgnore: ['Contents/Resources/web/'],
    },
    dmg: { artifactName: `${name}-\${version}-\${arch}.dmg` },
    win: {
      icon: 'build/icon.png',
      target: targets.win,
      ...(signing.winCertSha1 ? {
        signtoolOptions: {
          certificateSha1: signing.winCertSha1,
          signingHashAlgorithms: ['sha256'],
          rfc3161TimeStampServer: 'http://timestamp.digicert.com',
        },
      } : {}),
    },
    // 给了证书就必须签成：签名失败不能悄悄出一个未签名的包
    ...(signing.macIdentity || signing.winCertSha1 ? { forceCodeSigning: true } : {}),
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      artifactName: `${name}-Setup-\${version}.exe`,
    },
    ...(debug ? {} : { compression: 'normal' }),
  }
}

/** 业务扩展的预加载脚本只在主窗口里跑：拼在外壳预加载后面，沙箱预加载只能是单个文件。 */
export function withExtensionPreload(shellPreload, extensionPreload) {
  return `${shellPreload}
// ─── 业务扩展预加载（desktop.extension，只在主窗口）────────────────
;(function () {
  if (!process.argv.includes('--appshell-window-id=main')) return
${extensionPreload}
})()
`
}

/** 构建业务扩展并放进工程的 extension/；返回是否带预加载脚本。 */
function buildExtension(config, env, work, { debug }) {
  const ext = config.desktop.extension
  const [command, ...args] = ext.command
  run(command, args, {
    cwd: config.root,
    env: {
      ...process.env, ...env.desktop.buildEnv,
      APPSHELL_PLATFORM: 'desktop', APPSHELL_ENV: env.name, APPSHELL_DEBUG: debug ? '1' : '0',
      APPSHELL_ELECTRON_VERSION: ELECTRON_VERSION,
    },
  })
  const dir = path.join(config.root, ext.dir)
  if (!fs.existsSync(path.join(dir, 'main.js'))) fail(`desktop.extension.command 跑完后 ${ext.dir}/main.js 不存在`)
  copyDir(dir, path.join(work, 'extension'))
  const preload = path.join(work, 'extension', 'preload.js')
  if (fs.existsSync(preload)) {
    const shell = path.join(work, 'preload.js')
    fs.writeFileSync(shell, withExtensionPreload(fs.readFileSync(shell, 'utf8'), fs.readFileSync(preload, 'utf8')))
    fs.rmSync(preload)
  }
  log(`业务扩展已并入：${ext.dir}`)
}

function checkResources(dir) {
  const icon = path.join(dir, 'icon.png')
  if (!fs.existsSync(icon)) fail(`desktop.resources 缺少 icon.png（1024×1024）：${dir}`)
}

export function prebuildDesktop(config, env, { allowDirty, debug }) {
  if (!config.desktop) fail('appshell.config.json 没有配置 desktop')
  const resources = path.join(config.root, config.desktop.resources)
  checkResources(resources)
  const unsupported = config.capabilities.filter(name => !DESKTOP_CAPABILITIES.includes(name))
  if (unsupported.length) log(`桌面端尚未实现能力组 ${unsupported.join(', ')}，生成的包里不包含；Web 端须按插件存在与否降级`)
  const web = buildWeb(config, {
    platform: 'desktop', env, appId: config.desktop.appId, build: 0, allowDirty,
    web: config.desktop.web, buildEnv: env.desktop.buildEnv,
  })
  const work = workDir(config, 'desktop')
  fs.rmSync(work, { recursive: true, force: true })
  copyDir(TEMPLATE, work)
  copyDir(web.dir, path.join(work, 'web'))
  if (config.desktop.extension) {
    buildExtension(config, env, work, { debug })
    const after = sourceState(config.root)
    if (!web.manifest.sourceDirty && after.dirty) fail('扩展构建改动了工作区（desktop.extension.dir 要加进 .gitignore）')
  }
  fs.writeFileSync(path.join(work, 'build', 'usage-locales.json'),
    JSON.stringify(config.desktop.mac.localizedUsageDescriptions, null, 2) + '\n')
  fs.writeFileSync(path.join(work, 'build', 'fuses.json'), JSON.stringify(debug ? null : RELEASE_FUSES, null, 2) + '\n')
  fs.copyFileSync(path.join(resources, 'icon.png'), path.join(work, 'build', 'icon.png'))
  // 托盘图标（能力组 system）：主进程运行时读，所以要打进 app 包里
  fs.copyFileSync(path.join(resources, 'icon.png'), path.join(work, 'tray.png'))
  fs.writeFileSync(path.join(work, 'appshell.json'), JSON.stringify(desktopShellJson(config, env, { debug }), null, 2) + '\n')
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({
    name: config.desktop.appId.split('.').pop(),
    productName: config.app.name,
    version: config.desktop.version,
    description: `${config.app.name}（appshell 生成）`,
    author: config.app.name,
    main: 'main.js',
    private: true,
  }, null, 2) + '\n')
  log(`桌面工程已生成：${work}（${config.desktop.appId} ${config.desktop.version} / ${env.name} → ${env.desktop.apiTarget}）`)
  return { work, web }
}

/** --os 默认当前系统；debug 只出当前架构的免安装目录，release 出安装包（mac 两种架构）。 */
export function buildDesktop(config, env, { type, allowDirty, os = process.platform }) {
  if (!['debug', 'release'].includes(type)) fail('--type 只能是 debug 或 release')
  if (type === 'release' && allowDirty) fail('release 包不允许 --allow-dirty')
  if (!['darwin', 'win32'].includes(os)) fail('桌面端只支持 macOS（darwin）与 Windows（win32）')
  const debug = type === 'debug'
  const { work, web } = prebuildDesktop(config, env, { allowDirty, debug })
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const targets = {
    mac: debug ? [{ target: 'dir', arch: [arch] }] : [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    win: debug ? [{ target: 'dir', arch: ['x64'] }] : [{ target: 'nsis', arch: ['x64'] }],
  }
  const builderFile = path.join(work, 'electron-builder.json')
  const ctx = operationContext()
  const { macKeychain, ...signing } = debug ? {} : ctx.desktopSigning()
  fs.writeFileSync(builderFile, JSON.stringify(builderConfig(config, { debug, targets, signing }), null, 2) + '\n')
  const cli = path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js')
  // Apollo 模式：去掉环境里任何 APPLE_* / CSC_*，签名与公证只用 Apollo 给的身份和密钥。
  const baseEnv = ctx.source === 'apollo'
    ? Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(APPLE_|CSC_|WIN_CSC_)/.test(k)))
    : process.env
  const notarize = signing.macIdentity ? notarizeEnv(baseEnv, ctx.source === 'apollo' ? ctx.ascKey() : undefined) : null
  run(process.execPath, [cli, '--config', builderFile, '--projectDir', work, os === 'darwin' ? '--mac' : '--win', '--publish', 'never'], {
    cwd: work,
    // 没指定签名证书时不去钥匙串里自动找（会挑到不相干的证书）。
    env: { ...baseEnv, ...(signing.macIdentity ? notarize : { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }),
      ...(signing.macIdentity && macKeychain ? { CSC_KEYCHAIN: macKeychain } : {}) },
  })
  const release = path.join(work, 'release')
  const out = outDir(config)
  const artifacts = []
  if (debug) {
    const dir = fs.readdirSync(release).find(name => /^(mac|win)/.test(name) && fs.statSync(path.join(release, name)).isDirectory())
    if (!dir) fail(`electron-builder 完成但 ${release} 里没有免安装目录`)
    const app = path.join(release, dir, os === 'darwin' ? `${config.app.name}.app` : '')
    log(`桌面调试包：${app}`)
    return { app, web }
  }
  for (const name of fs.readdirSync(release)) {
    if (!/\.(dmg|exe)$/.test(name)) continue
    const archOf = /arm64/.test(name) ? 'arm64' : 'x64'
    const target = path.join(out, artifactName(config, `desktop-${os === 'darwin' ? 'mac' : 'win'}-${archOf}`,
      config.desktop.version, env.name, path.extname(name)))
    fs.copyFileSync(path.join(release, name), target)
    artifacts.push({ file: target, sha256: writeSha256(target), arch: archOf, format: path.extname(name).slice(1) })
    log(`安装包：${target}`)
  }
  if (artifacts.length === 0) fail(`electron-builder 完成但 ${release} 里没有安装包`)
  return { artifacts, web }
}
