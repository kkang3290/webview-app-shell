// nsh 引擎：界面用 TSX（或 Rust）写，各平台原生控件渲染。打包、签名由 `nsh package` 完成（不需要
// Xcode 工程或 Gradle）；app-shell 负责锁版本、注入各环境的值、统一产物命名与发版（与 webview 引擎同一条路）。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { sourceState, digestDirectory } from './web.mjs'
import { fail, log, run, copyDir, workDir, outDir, artifactName, writeSha256 } from './util.mjs'

export const ENV_FILE = 'appshell.env.json'
const SKIP = new Set(['.nsh', 'node_modules', 'target', '.git', '.appshell'])

/** 本机 nsh 必须与配置锁定的版本一致：0.x 之间不保证兼容。 */
export function checkNshVersion(config) {
  const result = spawnSync('nsh', ['--version'], { encoding: 'utf8' })
  if (result.error) fail('找不到 nsh 命令：按 https://nsh.dev/docs/installation 安装，并与 nsh.version 对齐')
  const found = (result.stdout.match(/\d+\.\d+\.\d+/) || [])[0]
  if (found !== config.nsh.version) fail(`本机 nsh 是 ${found ?? '未知版本'}，appshell.config.json 锁定的是 ${config.nsh.version}`)
  return found
}

/** nsh package 的目标：platform（android / ios / desktop）× 选项 → --target。 */
export function nshTarget(platform, { simulator, os }) {
  if (platform === 'android') return 'android'
  if (platform === 'ios') return simulator ? 'ios-simulator' : 'ios'
  if (platform === 'desktop') {
    if (os === 'darwin') return 'macos'
    if (os === 'win32') return 'windows'
    if (os === 'linux') return 'linux'
    fail('desktop 的 --os 只能是 darwin / win32 / linux')
  }
  if (platform === 'web') return 'web'
  fail(`nsh 引擎不支持平台 ${platform}`)
}

/** 每个平台用哪个包名与构建号（nsh.json 只有一个 id；我们按平台分别给）。 */
export function identity(config, platform) {
  if (platform === 'android') return { id: config.android.applicationId, build: config.android.versionCode }
  if (platform === 'ios') return { id: config.ios.bundleId, build: config.ios.buildNumber }
  if (platform === 'desktop') {
    if (!config.desktop) fail('appshell.config.json 没有配置 desktop')
    return { id: config.desktop.appId, build: 1 }
  }
  return { id: config.android.applicationId, build: config.android.versionCode }
}

export function packageArgs(config, platform, target, { type, out }) {
  const { id, build } = identity(config, platform)
  const args = ['package']
  if (config.nsh.entry) args.push(config.nsh.entry)
  args.push('--target', target, '--out', out, '--name', config.app.name, '--id', id,
    '--app-version', config.app.version, '--build', String(build))
  if (type === 'release') {
    if (target === 'android') {
      const { keystore, keyAlias } = config.android.signing
      if (!keystore) fail('release 包需要 android.signing.keystore / keyAlias')
      if (!process.env.NSH_KEYSTORE_PASSWORD) fail('release 包需要环境变量 NSH_KEYSTORE_PASSWORD（不要写进配置）')
      args.push('--keystore', path.resolve(config.root, keystore), '--key-alias', keyAlias)
    }
    if (target === 'ios') {
      const { identity: sign, profile } = config.ios.signing
      if (!sign) fail('iOS 真机包需要 ios.signing.identity / profile')
      args.push('--sign', sign, '--profile', path.resolve(config.root, profile))
    }
  }
  return args
}

/**
 * 复制一份应用目录，写入当前环境的值，在副本里打包：不改业务仓库，构建可追溯到提交。
 * 应用代码里 `import env from './appshell.env.json'` 读取。
 */
export function prepareNsh(config, env, platform, { allowDirty }) {
  checkNshVersion(config)
  const before = sourceState(config.root)
  if (before.dirty && !allowDirty) fail('工作区有未提交改动。先提交再打包；调试包可加 --allow-dirty')
  const source = path.join(config.root, config.nsh.dir)
  if (!fs.existsSync(path.join(source, 'nsh.json'))) fail(`${config.nsh.dir}/nsh.json 不存在（先 nsh init）`)
  if (config.nsh.entry && !fs.existsSync(path.join(source, config.nsh.entry))) fail(`入口 ${config.nsh.entry} 不存在`)
  const work = path.join(workDir(config, 'nsh'), platform)
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })
  fs.cpSync(source, work, { recursive: true, filter: from => !SKIP.has(path.basename(from)) || from === source })
  const { id, build } = identity(config, platform)
  fs.writeFileSync(path.join(work, ENV_FILE), JSON.stringify({
    environment: env.name,
    appId: id,
    version: config.app.version,
    build,
    sourceCommit: before.commit,
    sourceDirty: before.dirty,
    values: env.values,
  }, null, 2) + '\n')
  log(`nsh 工程已准备：${work}（${id} ${config.app.version} (${build}) / ${env.name}）`)
  return { work, commit: before.commit, dirty: before.dirty, digest: digestDirectory(work) }
}

const EXTENSIONS = { android: ['.apk', '.aab'], ios: ['.ipa'], 'ios-simulator': ['.app'], macos: ['.app'],
  windows: ['.exe', '.zip'], linux: ['.tar.gz'], web: [] }

export function buildNsh(config, env, platform, { type, allowDirty, simulator, os = process.platform }) {
  if (!['debug', 'release'].includes(type)) fail('--type 只能是 debug 或 release')
  if (type === 'release' && allowDirty) fail('release 包不允许 --allow-dirty')
  const target = nshTarget(platform, { simulator, os })
  const { work } = prepareNsh(config, env, platform, { allowDirty })
  const out = path.join(work, '.nsh', 'out')
  run('nsh', packageArgs(config, platform, target, { type, out }), { cwd: work })
  const produced = fs.existsSync(out) ? fs.readdirSync(out) : []
  const wanted = EXTENSIONS[target]
  const artifacts = []
  for (const name of produced) {
    const ext = wanted.find(e => name.endsWith(e))
    if (!ext) continue
    const from = path.join(out, name)
    let target_ = path.join(outDir(config), artifactName(config, `nsh-${target}`, config.app.version, env.name,
      `${type === 'debug' ? '-debug' : ''}${ext}`))
    if (ext === '.app') {
      // .app 是目录：压成 zip 方便分发与上传
      target_ += '.zip'
      fs.rmSync(target_, { force: true })
      run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', from, target_])
    } else {
      fs.copyFileSync(from, target_)
    }
    artifacts.push({ file: target_, sha256: writeSha256(target_), format: ext === '.app' ? 'zip' : ext.slice(1) })
    log(`安装包：${target_}`)
  }
  if (target === 'web') {
    const site = path.join(outDir(config), artifactName(config, 'nsh-web', config.app.version, env.name, ''))
    fs.rmSync(site, { recursive: true, force: true })
    copyDir(out, site)
    log(`静态站点：${site}`)
    return { site, artifacts }
  }
  if (artifacts.length === 0) fail(`nsh package 完成但 ${out} 里没有 ${wanted.join(' / ')} 产物`)
  return { artifacts, work }
}
