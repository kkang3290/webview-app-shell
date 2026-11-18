// HarmonyOS webview target: ArkWeb serves the business Web build from inside the HAP under the
// configured HTTPS site origin; API / WebSocket requests stay on the real network.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { CAPABILITIES, webVersion } from './config.mjs'
import { buildWeb, digestDirectory, listFiles, MANIFEST_FILE } from './web.mjs'
import { HARMONY_BOOTSTRAP } from '../web/harmony.js'
import { TEMPLATES, artifactName, copyDir, fail, log, outDir, run, sha256File, writeSha256, workDir } from './util.mjs'
import { operationContext } from './context.mjs'

export const HARMONY_CAPABILITIES = ['recording']
const TOOLCHAIN_KEYS = ['nodeHome', 'sdkHome', 'hvigorw', 'javaHome', 'hapSignTool']
const SIGNING_KEYS = ['storeFile', 'storePassword', 'keyAlias', 'keyPassword', 'profile', 'certpath', 'signAlg']
const SIGN_ALGS = ['SHA256withECDSA', 'SHA384withECDSA', 'SHA256withRSA', 'SHA384withRSA']
const SAFE_PATH = /^[A-Za-z0-9_@~+=,-]+(?:\.[A-Za-z0-9_@~+=,-]+)*(?:\/[A-Za-z0-9_@~+=,-]+(?:\.[A-Za-z0-9_@~+=,-]+)*)*$/
const MIME = {
  html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json',
  webmanifest: 'application/manifest+json', txt: 'text/plain', xml: 'application/xml', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', wav: 'audio/wav', ogg: 'audio/ogg',
  wasm: 'application/wasm', pdf: 'application/pdf',
}
const TEXT_MIME = /^(text\/|application\/(json|manifest\+json|xml)$|image\/svg\+xml$|text\/javascript$)/

export function requireHarmony(config) {
  if (config.engine !== 'webview') fail('harmony 只支持 webview 引擎（nsh 0.4.0 没有 HarmonyOS 目标）')
  if (!config.harmony) fail('appshell.config.json 没有配置 harmony；先添加 harmony 段（见 docs/config.md）')
  return config.harmony
}

function readJsonFile(file, where) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { fail(`${where} ${file} 不是可读的 JSON：${error.message}`) }
}

function exactKeys(value, keys, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${where} 必须是 JSON 对象`)
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${where}.${key} 是未知字段（允许：${keys.join(', ')}）`)
  for (const key of keys) if (typeof value[key] !== 'string' || value[key] === '') fail(`${where}.${key} 缺失或不是非空字符串`)
}

function envFile(name, purpose) {
  const file = process.env[name]
  if (!file) fail(`${purpose}：环境变量 ${name} 未设置（应指向本机 JSON 配置文件）`)
  if (!path.isAbsolute(file) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) fail(`${purpose}：${name} 必须是存在的绝对路径文件`)
  return file
}

/** Explicit toolchain: one env var -> one JSON file with absolute paths. No PATH scanning or fallback chain. */
export function resolveToolchain(harmony) {
  const file = envFile(harmony.toolchainEnv, 'Harmony 工具链')
  return validateToolchain(readJsonFile(file, 'Harmony 工具链'), `Harmony 工具链 ${file}`)
}

/** Shared by file mode (local JSON) and Apollo mode (`_tools.harmony`). */
export function validateToolchain(tools, where) {
  const file = where
  exactKeys(tools, TOOLCHAIN_KEYS, where)
  if (Object.values(tools).some(value => typeof value !== 'string' || !value.trim())) fail(`Harmony 工具链 ${file} 的路径必须是非空字符串`)
  const checks = {
    nodeHome: path.join(tools.nodeHome, 'bin', 'node'), sdkHome: tools.sdkHome, hvigorw: tools.hvigorw,
    javaHome: path.join(tools.javaHome, 'bin', 'java'), hapSignTool: tools.hapSignTool,
  }
  for (const [key, target] of Object.entries(checks)) {
    if (!path.isAbsolute(tools[key])) fail(`Harmony 工具链 ${key} 必须是绝对路径`)
    if (!fs.existsSync(target)) fail(`Harmony 工具链 ${key} 不存在：${target}`)
  }
  return tools
}

/**
 * Signing material comes from a local JSON file referenced by env var; never from appshell.config.json.
 * Passwords are plain text here: signing is done by hap-sign-tool directly, not by Hvigor, whose
 * signingConfigs only accept DevEco-encrypted passwords bound to a machine-local material/ directory.
 */
export function resolveSigning(harmony) {
  if (harmony.signing === null) return null
  const file = envFile(harmony.signing.configEnv, 'Harmony 签名')
  const signing = readJsonFile(file, 'Harmony 签名')
  exactKeys(signing, SIGNING_KEYS, 'Harmony 签名配置')
  for (const key of ['storeFile', 'profile', 'certpath']) {
    if (!path.isAbsolute(signing[key]) || !fs.existsSync(signing[key])) fail(`Harmony 签名 ${key} 必须是存在的绝对路径`)
  }
  if (!SIGN_ALGS.includes(signing.signAlg)) fail(`Harmony 签名 signAlg 只能是 ${SIGN_ALGS.join(' / ')}，要与证书的密钥类型一致`)
  return signing
}

function redact(text, secrets) {
  let out = text
  for (const secret of secrets) if (secret) out = out.split(secret).join('***')
  return out
}

/**
 * hap-sign-tool sign-app with the same arguments Hvigor's HapSignCommandBuilder uses (localSign).
 * Passwords never reach logs: output is captured and redacted, and the failure message omits the command line.
 */
export function signHap(tools, signing, input, output) {
  fs.rmSync(output, { force: true })
  const args = ['-jar', tools.hapSignTool, 'sign-app', '-mode', 'localSign',
    '-keystoreFile', signing.storeFile, '-keystorePwd', signing.storePassword,
    '-keyAlias', signing.keyAlias, '-keyPwd', signing.keyPassword,
    '-signAlg', signing.signAlg, '-profileFile', signing.profile, '-appCertFile', signing.certpath,
    '-inFile', input, '-outFile', output]
  const result = spawnSync(path.join(tools.javaHome, 'bin', 'java'), args, { encoding: 'utf8' })
  if (result.error || result.status !== 0 || !fs.existsSync(output)) {
    const detail = redact(`${result.stdout ?? ''}${result.stderr ?? ''}`, [signing.storePassword, signing.keyPassword]).trim()
    fail(`HAP 签名失败（hap-sign-tool sign-app${result.status === null ? '' : `，退出码 ${result.status}`}）${detail ? `\n${detail.split('\n').slice(-15).join('\n')}` : ''}`)
  }
}

export function harmonyEnvironment(config, env) {
  const harmony = requireHarmony(config)
  const target = harmony.environments[env.name]
  if (!target) fail(`harmony.environments 没有 ${env.name}`)
  return target
}

function mimeOf(file) {
  const ext = file.includes('.') ? file.split('.').pop().toLowerCase() : ''
  return MIME[ext] ?? 'application/octet-stream'
}

/** Final packaged set: hidden paths and source maps are excluded; unsafe or ambiguous names are rejected. */
export function stageSite(source, destination) {
  const files = []
  const seen = new Map()
  const excluded = []
  fs.rmSync(destination, { recursive: true, force: true })
  for (const native of listFiles(source)) {
    const relative = native.split(path.sep).join('/')
    if (relative.split('/').some(part => part.startsWith('.')) || relative.endsWith('.map')) { excluded.push(relative); continue }
    if (!SAFE_PATH.test(relative)) fail(`Web 产物路径不能安全打进 HAP：${relative}（只允许字母、数字和 _@~+=,-.）`)
    const folded = relative.toLowerCase()
    if (seen.has(folded)) fail(`Web 产物路径只差大小写，HAP 资源会冲突：${seen.get(folded)} / ${relative}`)
    seen.set(folded, relative)
    const target = path.join(destination, ...relative.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(source, native), target)
    if (relative !== MANIFEST_FILE) files.push(relative)
  }
  if (!files.includes('index.html')) fail('Web 产物缺少 index.html')
  return { files, excluded }
}

function ets(value) { return JSON.stringify(value) }

function webBundleSource({ origin, files, siteDir, harmony, info }) {
  const entries = files.map(file => {
    const mime = mimeOf(file)
    return `  { path: ${ets(`/${file}`)}, resource: ${ets(`site/${file}`)}, mime: ${ets(TEXT_MIME.test(mime) ? `${mime};charset=utf-8` : mime)}, sha256: ${ets(sha256File(path.join(siteDir, file)))} }`
  })
  return [
    '// Generated by appshell. Do not edit.',
    'export interface WebFile { path: string; resource: string; mime: string; sha256: string }',
    `export const WEB_ORIGIN: string = ${ets(origin)};`,
    `export const API_PREFIXES: string[] = ${ets(harmony.apiPrefixes)};`,
    `export const APP_INFO: string = ${ets(JSON.stringify(info))};`,
    `export const MICROPHONE_ENABLED: boolean = ${harmony.permissions.includes('microphone')};`,
    `export const RECORDING_ENABLED: boolean = ${harmony.capabilities.includes('recording')};`,
    `export const ERROR_TITLE: string = ${ets(harmony.strings.errorTitle)};`,
    `export const RETRY_LABEL: string = ${ets(harmony.strings.retryLabel)};`,
    'export const WEB_FILES: WebFile[] = [',
    entries.join(',\n'),
    '];',
    '',
  ].join('\n')
}

function bridgeScript() {
  if (typeof HARMONY_BOOTSTRAP !== 'string' || !HARMONY_BOOTSTRAP) fail('web/harmony.js 缺少 HARMONY_BOOTSTRAP')
  return `// Generated by appshell. Do not edit.\nexport const BRIDGE_SCRIPT: string = ${ets(HARMONY_BOOTSTRAP)};\n`
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function strings(file, entries) {
  writeJson(file, { string: Object.entries(entries).map(([name, value]) => ({ name, value })) })
}

function copyIcon(config, harmony, dir) {
  const icon = path.join(config.root, harmony.resources, 'app_icon.png')
  const header = fs.existsSync(icon) ? fs.readFileSync(icon).subarray(0, 8).toString('hex') : ''
  if (header !== '89504e470d0a1a0a') fail(`${harmony.resources}/app_icon.png 必须存在且是 PNG`)
  for (const target of ['AppScope/resources/base/media/app_icon.png', 'entry/src/main/resources/base/media/app_icon.png']) {
    fs.mkdirSync(path.dirname(path.join(dir, target)), { recursive: true })
    fs.copyFileSync(icon, path.join(dir, target))
  }
}

function projectFiles(config, harmony, dir) {
  writeJson(path.join(dir, 'AppScope/app.json5'), { app: {
    bundleName: harmony.bundleName, vendor: config.app.name, versionCode: harmony.versionCode,
    versionName: harmony.version, icon: '$media:app_icon', label: '$string:app_name',
  } })
  strings(path.join(dir, 'AppScope/resources/base/element/string.json'), { app_name: config.app.name })
  const entryStrings = { module_desc: config.app.name, EntryAbility_label: config.app.name }
  if (harmony.permissions.includes('microphone')) entryStrings.microphone_reason = harmony.strings.microphoneReason
  strings(path.join(dir, 'entry/src/main/resources/base/element/string.json'), entryStrings)
  const recording = harmony.capabilities.includes('recording')
  const permissions = [{ name: 'ohos.permission.INTERNET' }]
  if (recording) permissions.push({ name: 'ohos.permission.KEEP_BACKGROUND_RUNNING' })
  if (harmony.permissions.includes('microphone')) {
    permissions.push({ name: 'ohos.permission.MICROPHONE', reason: '$string:microphone_reason', usedScene: { abilities: ['EntryAbility'], when: 'always' } })
  }
  writeJson(path.join(dir, 'entry/src/main/module.json5'), { module: {
    name: 'entry', type: 'entry', description: '$string:module_desc', mainElement: 'EntryAbility',
    deviceTypes: ['phone', 'tablet'], deliveryWithInstall: true, installationFree: false, pages: '$profile:main_pages',
    requestPermissions: permissions,
    abilities: [{
      name: 'EntryAbility', srcEntry: './ets/entryability/EntryAbility.ets', description: '$string:module_desc',
      icon: '$media:app_icon', label: '$string:EntryAbility_label', startWindowIcon: '$media:app_icon',
      startWindowBackground: '$color:start_window_background', exported: true,
      ...(recording ? { backgroundModes: ['audioRecording', 'dataTransfer'] } : {}),
      skills: [{ entities: ['entity.system.home'], actions: ['ohos.want.action.home'] }],
    }],
  } })
  // Hvigor always produces an unsigned HAP; buildHarmony signs it afterwards with hap-sign-tool.
  writeJson(path.join(dir, 'build-profile.json5'), {
    app: {
      signingConfigs: [],
      products: [{
        name: 'default',
        targetSdkVersion: harmony.targetSdkVersion, compatibleSdkVersion: harmony.compatibleSdkVersion, runtimeOS: 'HarmonyOS',
        buildOption: { strictMode: { caseSensitiveCheck: true, useNormalizedOHMUrl: true } },
      }],
      buildModeSet: [{ name: 'debug' }, { name: 'release' }],
    },
    modules: [{ name: 'entry', srcPath: './entry', targets: [{ name: 'default', applyToProducts: ['default'] }] }],
  })
}

/** Generates .appshell/harmony from templates + the business Web build. Needs no Harmony SDK. */
export async function prebuildHarmony(config, env, { allowDirty }) {
  const harmony = requireHarmony(config)
  const target = harmonyEnvironment(config, env)
  const omitted = config.capabilities.filter(c => !harmony.capabilities.includes(c))
  if (omitted.length) log(`Harmony 不编入：${omitted.join(', ')}（全局声明，但 harmony.capabilities 未选择或尚未实现；Web 需按插件存在降级）`)
  const web = buildWeb(config, {
    platform: 'harmony', env, appId: harmony.bundleName, build: harmony.versionCode, allowDirty,
    web: harmony.web, buildEnv: target.buildEnv, appVersion: harmony.version,
  })
  const dir = workDir(config, 'harmony')
  fs.rmSync(dir, { recursive: true, force: true })
  copyDir(path.join(TEMPLATES, 'harmony', 'project'), dir)
  const siteDir = path.join(dir, 'entry/src/main/resources/rawfile/site')
  const staged = stageSite(web.dir, siteDir)
  const manifest = { ...web.manifest, bundleSha256: digestDirectory(siteDir) }
  fs.writeFileSync(path.join(siteDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
  if (staged.excluded.length) log(`Harmony 未打包 ${staged.excluded.length} 个隐藏文件或 source map；清单摘要按实际打包文件计算`)
  const info = {
    protocolVersion: 1, platform: 'harmony', id: harmony.bundleName, name: config.app.name,
    appVersion: harmony.version, build: harmony.versionCode, siteOrigin: target.siteOrigin, environment: env.name,
    plugins: ['App', ...(harmony.permissions.length ? ['Permissions'] : []), ...(harmony.capabilities.includes('recording') ? ['WebRecording'] : [])],
  }
  fs.mkdirSync(path.join(dir, 'entry/src/main/ets/generated'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'entry/src/main/ets/generated/WebBundle.ets'),
    webBundleSource({ origin: target.siteOrigin, files: [MANIFEST_FILE, ...staged.files], siteDir, harmony, info }))
  fs.writeFileSync(path.join(dir, 'entry/src/main/ets/generated/BridgeScript.ets'), bridgeScript())
  projectFiles(config, harmony, dir)
  copyIcon(config, harmony, dir)
  log(`Harmony 工程：${dir}（${staged.files.length + 1} 个包内资源，Web ${webVersion(config)}，${env.name}）`)
  return { dir, manifest, files: staged.files }
}

function hapEntries(hap) {
  const listed = spawnSync('unzip', ['-Z1', hap], { encoding: 'utf8' })
  if (listed.status !== 0) fail(`无法读取 HAP：${hap}`)
  return listed.stdout.split('\n').filter(Boolean)
}

function hapJson(hap, entry) {
  const out = spawnSync('unzip', ['-p', hap, entry], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (out.status !== 0) fail(`HAP 缺少 ${entry}`)
  try { return JSON.parse(out.stdout) } catch { fail(`HAP 的 ${entry} 不是 JSON`) }
}

/** Checks the real HAP: identity/version, embedded manifest and the full packaged resource set. */
export function verifyHap(hap, { harmony, manifest, files }) {
  const entries = new Set(hapEntries(hap))
  const moduleJson = hapJson(hap, 'module.json')
  if (moduleJson.app?.bundleName !== harmony.bundleName) fail(`HAP bundleName 不符：${moduleJson.app?.bundleName}`)
  if (moduleJson.app?.versionCode !== harmony.versionCode || moduleJson.app?.versionName !== harmony.version) fail('HAP 版本号与 harmony.version / versionCode 不符')
  const packed = hapJson(hap, `resources/rawfile/site/${MANIFEST_FILE}`)
  for (const key of ['appId', 'platform', 'environment', 'webVersion', 'sourceCommit', 'sourceDirty', 'bundleSha256']) {
    if (JSON.stringify(packed[key]) !== JSON.stringify(manifest[key])) fail(`HAP 内清单 ${key} 与本次构建不一致`)
  }
  for (const file of files) if (!entries.has(`resources/rawfile/site/${file}`)) fail(`HAP 缺少资源 site/${file}`)
}

function verifySignature(hap, tools) {
  const tmp = fs.mkdtempSync(path.join(path.dirname(hap), '.verify-'))
  try {
    const result = spawnSync(path.join(tools.javaHome, 'bin', 'java'), ['-jar', tools.hapSignTool, 'verify-app', '-inFile', hap,
      '-outCertChain', path.join(tmp, 'chain.cer'), '-outProfile', path.join(tmp, 'profile.p7b')], { encoding: 'utf8' })
    if (result.status !== 0) fail('HAP 签名校验失败（hap-sign-tool verify-app）')
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

export async function buildHarmony(config, env, { type, allowDirty }) {
  const harmony = requireHarmony(config)
  if (!['debug', 'release'].includes(type)) fail('--type 只能是 debug 或 release')
  if (type === 'release' && allowDirty) fail('release 包不允许 --allow-dirty')
  // All prerequisites are checked before any Web build or project generation.
  // debug never signs (anyone can check a build without key material); release always signs.
  const ctx = operationContext()
  const tools = ctx.harmonyToolchain(harmony)
  let signing = null
  if (type === 'release') {
    if (ctx.source === 'file' && harmony.signing === null) fail('release HAP 需要签名：在 harmony.signing.configEnv 写环境变量名，并让它指向签名 JSON（见 docs/harmony.md）')
    signing = await ctx.harmonySigning(harmony)
  }
  const built = await prebuildHarmony(config, env, { allowDirty })
  const pathEnv = [path.join(tools.nodeHome, 'bin'), path.join(tools.javaHome, 'bin'), process.env.PATH].join(path.delimiter)
  run(tools.hvigorw, ['--mode', 'module', '-p', 'product=default', '-p', 'module=entry@default', '-p', `buildMode=${type}`, 'assembleHap', '--no-daemon'], {
    cwd: built.dir,
    env: { ...process.env, NODE_HOME: tools.nodeHome, DEVECO_SDK_HOME: tools.sdkHome, JAVA_HOME: tools.javaHome, PATH: pathEnv },
  })
  const unsigned = path.join(built.dir, 'entry/build/default/outputs/default/entry-default-unsigned.hap')
  if (!fs.existsSync(unsigned)) fail(`Hvigor 没有产出 ${path.relative(built.dir, unsigned)}`)
  verifyHap(unsigned, { harmony, manifest: built.manifest, files: built.files })
  let produced = unsigned
  if (signing) {
    produced = path.join(path.dirname(unsigned), 'entry-default-appshell-signed.hap')
    signHap(tools, signing, unsigned, produced)
    verifySignature(produced, tools)
    verifyHap(produced, { harmony, manifest: built.manifest, files: built.files })
  }
  const suffix = `-${type}${signing ? '' : '-unsigned'}.hap`
  const file = path.join(outDir(config), artifactName(config, 'harmony', harmony.version, env.name, suffix))
  fs.copyFileSync(produced, file)
  const sha = writeSha256(file)
  log(`HAP：${file}\nSHA-256：${sha}${signing ? '' : '\n未签名：只能用于检查构建结果，不能安装或发布；要装机用 --type release（需要签名）'}`)
  return { file, signed: Boolean(signing), sha256: sha }
}

export function doctorHarmony(config) {
  const checks = []
  const harmony = config?.harmony
  checks.push(['appshell.config.json 有 harmony 段', Boolean(harmony)])
  if (!harmony) return checks
  const attempt = (name, action) => {
    try { action(); checks.push([name, true]) } catch (error) { checks.push([`${name}：${error.message}`, false]) }
  }
  const ctx = operationContext()
  attempt(ctx.source === 'file' ? `Harmony 工具链（${harmony.toolchainEnv}）` : 'Harmony 工具链（Apollo _tools.harmony）', () => ctx.harmonyToolchain(harmony))
  // Signing is only needed for release/publish; missing signing is reported, not a doctor failure.
  const status = ctx.harmonySigningStatus(harmony)
  if (status) checks.push([status, true])
  else if (ctx.source === 'file') attempt(`Harmony 签名（${harmony.signing.configEnv}）`, () => resolveSigning(harmony))
  else checks.push(['Harmony 签名：Apollo _credentials.harmony 已配置（release 时校验版本与内容）', true])
  checks.push(['unzip（校验 HAP）', spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0])
  return checks
}

export const HARMONY_UNSUPPORTED = CAPABILITIES.filter(c => !HARMONY_CAPABILITIES.includes(c))
