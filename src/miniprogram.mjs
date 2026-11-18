// WeChat Mini Program target of the webview engine. No Web build or native bridge is involved.
import fs from 'node:fs'
import path from 'node:path'

import { sourceState, digestDirectory, MANIFEST_FILE } from './web.mjs'
import { operationContext } from './context.mjs'
import { TEMPLATES, fail, log, run, copyDir, workDir, outDir, artifactName, writeSha256 } from './util.mjs'
import { validateMiniProgramPath, validateMiniProgramOrigin } from '../templates/miniprogram/miniprogram/lib/web-path-core.js'

export { validateMiniProgramPath, validateMiniProgramOrigin } from '../templates/miniprogram/miniprogram/lib/web-path-core.js'

const EXTENSION_MANIFEST = 'appshell-extension.json'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep)
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value)
const reserved = relative => /^(?:env|pages\/web)(?:\/|$)/i.test(relative) || /^(?:app\.(?:ts|js|json)|lib\/web-path(?:-core)?\.(?:ts|js)|project(?:\.private)?\.config\.json|appshell-build\.json)$/i.test(relative)
const sensitive = name => name.startsWith('.') || /\.(?:key|pem|p8|p12|pfx|jks|keystore)$/i.test(name) || name === 'node_modules'

function keys(value, required, optional = [], label = 'Mini Program') {
  if (!object(value)) fail(`${label}: 必须是对象`)
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label}.${key}: 必须显式配置`)
  for (const key of Object.keys(value)) if (![...required, ...optional].includes(key)) fail(`${label}.${key}: 未知字段`)
}

function relativePath(value, label) {
  if (typeof value !== 'string' || !value || value.length > 512 || !value.split('/').every(part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part))) {
    fail(`${label}: 必须是无穿越的仓库相对路径`)
  }
  return value
}

// Reject symlinks at every level, including existing .appshell and extension parent directories.
function checkedPath(root, relative) {
  let current = root
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    let stat
    try { stat = fs.lstatSync(current) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (stat.isSymbolicLink()) fail('Mini Program 路径不允许符号链接')
  }
  return current
}

function extensionDirectory(config) {
  const dir = config.miniprogram.extension.dir
  // .appshell is the sole hidden directory allowed here, for generated extension staging.
  relativePath(dir.startsWith('.appshell/') ? dir.slice('.appshell/'.length) : dir, 'miniprogram.extension.dir')
  if (dir.startsWith('.') && !dir.startsWith('.appshell/')) fail('miniprogram.extension.dir: 不允许隐藏目录')
  const absolute = checkedPath(config.root, dir)
  for (const reservedDir of [workDir(config, 'miniprogram'), path.join(config.root, '.appshell', 'out')]) {
    if (inside(reservedDir, absolute) || inside(absolute, reservedDir)) fail('扩展目录不能与 Mini Program 工程或归档目录重叠')
  }
  return absolute
}

function validate(config, env) {
  if (typeof config.root !== 'string' || !path.isAbsolute(config.root) || typeof config.app?.name !== 'string' || !config.app.name.trim()) fail('Mini Program 需要 root 与 app.name')
  if (config.engine !== undefined && config.engine !== 'webview') fail('Mini Program 只支持 webview 引擎')
  keys(config.miniprogram, ['appId', 'version', 'libVersion', 'entryPath', 'extension'], [], 'miniprogram')
  const mini = config.miniprogram
  if (typeof mini.appId !== 'string' || !/^wx[0-9a-f]{16}$/.test(mini.appId)) fail('miniprogram.appId: 必须是微信小程序 appId')
  if (!version(mini.version) || !version(mini.libVersion)) fail('miniprogram.version / libVersion: 必须是 x.y.z')
  if (!validateMiniProgramPath(mini.entryPath)) fail('miniprogram.entryPath: 必须是安全的站内路径')
  if (typeof env.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(env.name)) fail('Mini Program 环境名称无效')
  keys(env.miniprogram, ['siteOrigin', 'apiOrigin'], [], 'environment.miniprogram')
  if (!validateMiniProgramOrigin(env.miniprogram.siteOrigin) || (env.miniprogram.apiOrigin !== null && !validateMiniProgramOrigin(env.miniprogram.apiOrigin))) fail('Mini Program siteOrigin / apiOrigin: 必须是 HTTPS origin，apiOrigin 可为 null')
  if (mini.extension !== null) {
    keys(mini.extension, ['command', 'dir'], [], 'miniprogram.extension')
    if (!Array.isArray(mini.extension.command) || !mini.extension.command.length || !mini.extension.command.every(arg => typeof arg === 'string' && arg.trim() && !arg.includes('\0'))) fail('miniprogram.extension.command: 必须是非空字符串数组')
    extensionDirectory(config)
  }
  checkedPath(config.root, '.appshell/miniprogram')
  checkedPath(config.root, '.appshell/out')
}

function readObject(file, label) {
  let value
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { fail(`${label}: 缺失或不是有效 JSON`) }
  if (!object(value)) fail(`${label}: 必须是 JSON 对象`)
  return value
}

function extensionFiles(dir, prefix = '') {
  const files = []
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    relativePath(relative, '扩展文件')
    if (sensitive(entry.name) || reserved(relative)) fail(`扩展含保留或敏感路径：${relative}`)
    if (entry.isDirectory()) files.push(...extensionFiles(dir, relative))
    else if (entry.isFile()) files.push(relative)
    else fail(`扩展不允许符号链接或特殊文件：${relative}`)
  }
  return files
}

function windowConfig(value) {
  const stringKeys = ['navigationBarTitleText', 'navigationBarBackgroundColor', 'backgroundColor', 'backgroundColorTop', 'backgroundColorBottom']
  const enums = { navigationBarTextStyle: ['black', 'white'], backgroundTextStyle: ['dark', 'light'], navigationStyle: ['default', 'custom'] }
  keys(value, [], [...stringKeys, ...Object.keys(enums), 'enablePullDownRefresh', 'onReachBottomDistance'], 'extension.window')
  for (const [key, setting] of Object.entries(value)) {
    if (stringKeys.includes(key) && (typeof setting !== 'string' || /[\u0000-\u001f]/.test(setting))) fail(`extension.window.${key}: 必须是字符串`)
    if (key in enums && !enums[key].includes(setting)) fail(`extension.window.${key}: 无效值`)
    if (key === 'enablePullDownRefresh' && typeof setting !== 'boolean') fail(`extension.window.${key}: 必须是布尔值`)
    if (key === 'onReachBottomDistance' && (!Number.isInteger(setting) || setting < 0)) fail(`extension.window.${key}: 必须是非负整数`)
  }
}

function loadExtension(dir) {
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) fail('扩展命令没有生成目录')
  const files = extensionFiles(dir)
  const manifest = readObject(path.join(dir, EXTENSION_MANIFEST), EXTENSION_MANIFEST)
  keys(manifest, ['pages', 'subPackages', 'window', 'usingComponents', 'appEntry'], [], EXTENSION_MANIFEST)
  if (!Array.isArray(manifest.pages) || !Array.isArray(manifest.subPackages)) fail('扩展 pages / subPackages 必须是数组')
  windowConfig(manifest.window)
  keys(manifest.usingComponents, [], Object.keys(manifest.usingComponents ?? {}), 'extension.usingComponents')
  const registered = new Set(['pages/web/index'])
  const roots = []
  function register(page) {
    relativePath(page, '扩展页面')
    if (reserved(page) || registered.has(page)) fail(`扩展页面冲突：${page}`)
    registered.add(page)
    for (const suffix of ['.ts', '.wxml', '.json']) if (!files.includes(page + suffix)) fail(`扩展页面缺少 ${page}${suffix}`)
    readObject(path.join(dir, page + '.json'), '扩展页面 JSON')
  }
  for (const page of manifest.pages) register(page)
  for (const sub of manifest.subPackages) {
    keys(sub, ['root', 'pages'], [], 'extension.subPackages')
    relativePath(sub.root, '扩展分包 root')
    if (reserved(sub.root) || roots.some(root => root === sub.root || root.startsWith(sub.root + '/') || sub.root.startsWith(root + '/'))) fail('扩展分包 root 冲突')
    if (!Array.isArray(sub.pages)) fail('扩展分包 pages 必须是数组')
    roots.push(sub.root)
    for (const page of sub.pages) register(`${sub.root}/${relativePath(page, '扩展分包页面')}`)
  }
  for (const page of manifest.pages) if (roots.some(root => page.startsWith(root + '/'))) fail('主包页面不能位于分包内')
  for (const [name, component] of Object.entries(manifest.usingComponents)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || typeof component !== 'string') fail('扩展 usingComponents 无效')
    const local = component.startsWith('/') ? component.slice(1) : component
    relativePath(local, '扩展组件')
    for (const suffix of ['.ts', '.wxml', '.json']) if (!files.includes(local + suffix)) fail(`扩展组件缺少 ${local}${suffix}`)
    if (readObject(path.join(dir, local + '.json'), '扩展组件 JSON').component !== true) fail('扩展组件 JSON 必须声明 component: true')
  }
  if (manifest.appEntry !== null) {
    relativePath(manifest.appEntry, 'extension.appEntry')
    if (!manifest.appEntry.endsWith('.ts') || !files.includes(manifest.appEntry)) fail('extension.appEntry 必须是存在的 .ts 生命周期模块（不是 App 注册入口）')
  }
  return { manifest, files: files.filter(file => file !== EXTENSION_MANIFEST) }
}

function assertSource(before, after, allowDirty) {
  if (before.commit !== after.commit) fail('构建期间源码提交发生变化')
  if ((!before.dirty && after.dirty) || (after.dirty && !allowDirty)) fail('构建过程改动了源码工作区（请忽略生成目录）')
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

export function prebuildMiniprogram(config, env, { allowDirty = false } = {}) {
  validate(config, env)
  const before = sourceState(config.root)
  if (before.dirty && !allowDirty) fail('Mini Program 工作区有未提交改动；调试可加 --allow-dirty')
  let extension = null
  let extensionDir
  if (config.miniprogram.extension !== null) {
    extensionDir = extensionDirectory(config)
    const [command, ...args] = config.miniprogram.extension.command
    run(command, args, { cwd: config.root, env: { ...process.env, APPSHELL_PLATFORM: 'miniprogram', APPSHELL_ENV: env.name, APPSHELL_EXTENSION_DIR: extensionDir } })
    // A command may have replaced a previously safe parent with a symlink.
    extensionDirectory(config)
    extension = loadExtension(extensionDir)
  }
  checkedPath(config.root, '.appshell/miniprogram')
  const work = workDir(config, 'miniprogram')
  fs.rmSync(work, { recursive: true, force: true })
  copyDir(path.join(TEMPLATES, 'miniprogram'), work)
  const miniRoot = path.join(work, 'miniprogram')
  // The shared source is JS so installed Node consumers can import it; generated runtime is TS.
  fs.renameSync(path.join(miniRoot, 'lib/web-path-core.js'), path.join(miniRoot, 'lib/web-path-core.ts'))
  for (const relative of extension?.files ?? []) {
    const target = path.join(miniRoot, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(extensionDir, relative), target)
  }
  const mini = config.miniprogram
  const ext = extension?.manifest
  writeJson(path.join(work, 'project.config.json'), {
    appid: mini.appId,
    projectname: config.app.name,
    compileType: 'miniprogram',
    miniprogramRoot: 'miniprogram/',
    libVersion: mini.libVersion,
    setting: { es6: true, minified: true, compileHotReLoad: false, useCompilerPlugins: ['typescript'] },
    packOptions: { ignore: [], include: [] },
  })
  writeJson(path.join(work, 'tsconfig.json'), { compilerOptions: { target: 'ES2018', module: 'commonjs', allowJs: true, strict: false, esModuleInterop: true }, include: ['miniprogram/**/*'] })
  writeJson(path.join(miniRoot, 'app.json'), {
    pages: ['pages/web/index', ...(ext?.pages ?? [])],
    subPackages: ext?.subPackages ?? [],
    window: { navigationBarTitleText: config.app.name, ...(ext?.window ?? {}) },
    usingComponents: ext?.usingComponents ?? {},
  })
  fs.mkdirSync(path.join(miniRoot, 'env'), { recursive: true })
  fs.writeFileSync(path.join(miniRoot, 'env', 'config.ts'), `// Public build configuration. No credentials.\nexport default ${JSON.stringify({ appName: config.app.name, environment: env.name, appId: mini.appId, version: mini.version, ...env.miniprogram, entryPath: mini.entryPath }, null, 2)} as const\n`)
  const appFile = path.join(miniRoot, 'app.ts')
  const hook = ext?.appEntry
  let app = fs.readFileSync(appFile, 'utf8')
  app = app.replace('__LIFECYCLE_IMPORT__', hook ? `import * as lifecycle from ${JSON.stringify('./' + hook.slice(0, -3))}` : '')
  app = app.replace('__LIFECYCLE_LAUNCH__', hook ? "if (typeof lifecycle.onLaunch === 'function') lifecycle.onLaunch.call(this, options)" : '')
  app = app.replace('__LIFECYCLE_SHOW__', hook ? "if (typeof lifecycle.onShow === 'function') lifecycle.onShow.call(this, options)" : '')
  fs.writeFileSync(appFile, app)
  const after = sourceState(config.root)
  assertSource(before, after, allowDirty)
  const manifest = {
    schemaVersion: 1, platform: 'miniprogram', appId: mini.appId, environment: env.name,
    version: mini.version, libVersion: mini.libVersion,
    sourceCommit: after.commit, sourceDirty: after.dirty,
    builtAt: new Date().toISOString(), bundleSha256: digestDirectory(work),
  }
  writeJson(path.join(work, MANIFEST_FILE), manifest)
  log(`Mini Program 工程：${work}（${mini.appId} ${mini.version} / ${env.name}）`)
  return { work, dir: miniRoot, manifest }
}

export function buildMiniprogram(config, env, { allowDirty = false } = {}) {
  const built = prebuildMiniprogram(config, env, { allowDirty })
  const before = sourceState(config.root)
  checkedPath(config.root, '.appshell/out')
  const file = path.join(outDir(config), artifactName(config, 'miniprogram', config.miniprogram.version, env.name, '.zip'))
  fs.rmSync(file, { force: true })
  run('zip', ['-q', '-r', '-X', file, '.'], { cwd: built.work })
  const sha256 = writeSha256(file)
  assertSource(before, sourceState(config.root), allowDirty)
  log(`Mini Program 归档：${file}\nSHA-256：${sha256}`)
  return { ...built, file, sha256, version: config.miniprogram.version }
}

export function miniProgramKeyFromEnv(env = process.env) {
  const value = env.APPSHELL_WX_MP_KEY_PATH
  if (typeof value !== 'string' || !value.trim()) fail('微信上传需要 APPSHELL_WX_MP_KEY_PATH')
  const keyPath = path.resolve(value)
  let stat
  try { stat = fs.lstatSync(keyPath) } catch { fail('APPSHELL_WX_MP_KEY_PATH 必须指向已存在的普通文件') }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('APPSHELL_WX_MP_KEY_PATH 必须指向已存在的普通文件，不能是符号链接')
  return keyPath
}

function uploadOptions(notes, robot) {
  if (!Number.isInteger(robot) || robot < 1 || robot > 30) fail('微信上传必须显式指定 robot（1..30）')
  if (typeof notes !== 'string' || !notes.trim() || Buffer.byteLength(notes, 'utf8') > 1024) fail('微信上传必须显式指定 notes，且非空、不超过 1024 UTF-8 字节')
  return { desc: notes, robot }
}

function assertKeyOutsideProject(config, keyPath) {
  const actual = fs.realpathSync(keyPath)
  const work = workDir(config, 'miniprogram')
  const locations = [work, ...(config.miniprogram.extension === null ? [] : [extensionDirectory(config)])]
  for (const location of locations) {
    const real = fs.existsSync(location) ? fs.realpathSync(location) : location
    if (inside(real, actual)) fail('微信上传密钥不能位于生成工程或扩展目录内')
  }
}

export async function uploadMiniprogram(config, env, { work, keyPath, notes, robot, ci } = {}) {
  validate(config, env)
  const options = uploadOptions(notes, robot)
  const key = miniProgramKeyFromEnv(keyPath === undefined ? process.env : { APPSHELL_WX_MP_KEY_PATH: keyPath })
  assertKeyOutsideProject(config, key)
  if (work !== workDir(config, 'miniprogram') || !fs.existsSync(path.join(work, 'project.config.json'))) fail('微信上传需要当前生成的 Mini Program 工程')
  const manifest = readObject(path.join(work, MANIFEST_FILE), 'Mini Program build manifest')
  const source = sourceState(config.root)
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'miniprogram' || manifest.appId !== config.miniprogram.appId || manifest.environment !== env.name || manifest.version !== config.miniprogram.version || manifest.libVersion !== config.miniprogram.libVersion || manifest.sourceDirty !== false || source.dirty || manifest.sourceCommit !== source.commit || manifest.bundleSha256 !== digestDirectory(work)) fail('Mini Program 工程来源或摘要无效，请重新构建')
  try {
    const loaded = ci ?? await import('miniprogram-ci')
    const client = loaded.default ?? loaded
    const project = new client.Project({ appid: config.miniprogram.appId, type: 'miniProgram', projectPath: work, privateKeyPath: key, ignores: [] })
    return await client.upload({ project, version: config.miniprogram.version, ...options, setting: { es6: true, minify: true } })
  } catch {
    // Third-party errors can contain credentials or file contents. Do not echo them.
    fail('微信小程序上传失败，请检查上传权限、IP 白名单与 miniprogram-ci 配置（密钥详情已隐藏）')
  }
}

export async function publishMiniprogram(config, env, { dryRun = false, notes, robot, ci } = {}) {
  validate(config, env)
  const options = uploadOptions(notes, robot)
  let keyPath
  if (!dryRun) {
    // 文件模式：APPSHELL_WX_MP_KEY_PATH；Apollo 模式：wechat 凭据落到私有临时目录
    keyPath = operationContext().wechatKeyPath()
    assertKeyOutsideProject(config, keyPath)
  }
  const artifact = buildMiniprogram(config, env)
  const plan = { appId: config.miniprogram.appId, environment: env.name, version: config.miniprogram.version, ...options }
  if (dryRun) {
    log('dry-run，已生成 Mini Program 工程与归档，未加载上传 SDK、未读取密钥、未上传')
    return { artifact, plan }
  }
  const result = await uploadMiniprogram(config, env, { work: artifact.work, keyPath, notes: options.desc, robot, ci })
  return { artifact, plan, result }
}
