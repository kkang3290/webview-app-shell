// appshell.config.json 的唯一读取入口。规则：每个字段必须显式写出，缺了就报错，
// 不提供默认值、不读环境变量兜底——打包配置出错的代价是装错环境的安装包。
import fs from 'node:fs'
import path from 'node:path'
import { validateMiniProgramPath, validateMiniProgramOrigin } from '../templates/miniprogram/miniprogram/lib/web-path-core.js'
import { validateHarmony } from './harmony-config.mjs'

export const CONFIG_FILE = 'appshell.config.json'
export const CAPABILITIES = ['recording', 'hotUpdate', 'wechat', 'push', 'backgroundUpload',
  // 通用能力 v2（docs/capabilities-v2.md）；windows 只有桌面，system 先实现桌面部分
  'windows', 'system', 'screenCapture']
// 业务声明会用到的系统权限；只有声明的才写进 Manifest / Info.plist、编入 iOS 对应代码。
export const PERMISSIONS = ['microphone', 'camera', 'notifications', 'photos', 'location']
// iOS 权限说明键（notifications 不需要说明文字）
export const IOS_USAGE_KEYS = {
  microphone: 'NSMicrophoneUsageDescription',
  camera: 'NSCameraUsageDescription',
  photos: 'NSPhotoLibraryAddUsageDescription',
  location: 'NSLocationWhenInUseUsageDescription',
}
export const PUSH_CHANNELS = {
  xiaomi: ['appId', 'appKey'],
  oppo: ['appId', 'appKey', 'appSecret'],
  vivo: ['appId', 'appKey'],
  honor: ['appId'],
  meizu: ['appId', 'appKey'],
  huawei: ['servicesFile'],
}
// 个推（Android）的厂商通道 → 必填字段。占位符名按个推 3.x 文档（HUAWEI_APP_ID、XIAOMI_APP_ID …）。
export const GETUI_CHANNELS = {
  huawei: ['appId'],
  xiaomi: ['appId', 'appKey'],
  oppo: ['appKey', 'appSecret'],
  vivo: ['appId', 'appKey'],
  honor: ['appId'],
}
export const PUSH_PROVIDERS = ['jpush', 'getui']
export const PLATFORMS = ['android', 'ios', 'desktop', 'miniprogram']
export const NSH_PLATFORMS = ['android', 'ios', 'desktop', 'web']
export const WEBVIEW_PLATFORMS = [...PLATFORMS, 'harmony']
// 快捷方式图标只允许 Android 系统自带 drawable，生成 Java 时直接引用 android.R.drawable.<name>。
const SYSTEM_ICONS = new Set([
  'ic_btn_speak_now', 'sym_action_chat', 'ic_menu_add', 'ic_menu_search', 'ic_menu_camera',
  'ic_menu_edit', 'ic_menu_agenda', 'ic_menu_today', 'ic_menu_send', 'ic_menu_share',
])

export class ConfigError extends Error {}

function fail(where, message) {
  throw new ConfigError(`${CONFIG_FILE} ${where}: ${message}`)
}

function object(value, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(where, '必须是对象')
  return value
}

function only(value, where, keys) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${where}.${key}`, `未知字段（允许：${keys.join(', ')}）`)
  }
  for (const key of keys) {
    if (!(key in value)) fail(`${where}.${key}`, '缺失')
  }
}

function string(value, where, pattern, hint) {
  if (typeof value !== 'string' || value.trim() !== value || value === '') fail(where, '必须是非空字符串且无首尾空白')
  if (pattern && !pattern.test(value)) fail(where, hint ?? `格式不符合 ${pattern}`)
  return value
}

function integer(value, where, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(where, `必须是 ${min}..${max} 的整数`)
  return value
}

function boolean(value, where) {
  if (typeof value !== 'boolean') fail(where, '必须是 true / false')
  return value
}

function nullable(value, where, check) {
  return value === null ? null : check(value, where)
}

const APP_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/
const VERSION = /^\d+\.\d+\.\d+$/
const COLOR = /^#[0-9A-Fa-f]{6}$/
const ENV_NAME = /^[a-z][a-z0-9-]{0,30}$/
const ROUTE = /^\/[A-Za-z0-9\-_/]*$/
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/
const ENV_VAR = /^[A-Z][A-Z0-9_]*$/
const QUERY = /^[A-Za-z0-9_-]+(=[A-Za-z0-9_-]+)?$/

function relativePath(value, where) {
  string(value, where)
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) fail(where, '必须是仓库内的相对路径')
  return value
}

function httpsOrigin(value, where) {
  if (!validateMiniProgramOrigin(value)) fail(where, '必须是合法 HTTPS origin（不含路径、凭据、查询参数）')
  return value
}

export const ENGINES = ['webview', 'nsh']

/**
 * 按 engine 分派：webview（现有网页套原生壳）与 nsh（TSX / Rust 原生 UI）各有一份严格的字段集。
 * mode = 'apollo'：配置来自 Apollo。指向本机文件 / 环境变量的字段（android.signing、harmony.toolchainEnv、
 * harmony.signing）不允许出现——工具链与凭据由 Apollo 的 _tools / _credentials 提供，避免两处来源谁生效说不清。
 */
export function parseConfig(raw, root, { mode = 'file' } = {}) {
  const config = object(raw, '(root)')
  if (config.schemaVersion !== 1) fail('schemaVersion', '只支持 1')
  if (!ENGINES.includes(config.engine)) fail('engine', `必须是 ${ENGINES.join(' / ')}`)
  if (config.engine === 'nsh' && mode === 'apollo') fail('engine', 'Apollo 配置模式暂不支持 nsh 引擎（nsh 仍用 appshell.config.json）')
  return config.engine === 'nsh' ? parseNshConfig(config, root) : parseWebviewConfig(config, root, mode)
}

function parseWebviewConfig(config, root, mode) {
  const rootKeys = ['schemaVersion', 'engine', 'app', 'web', 'environments', 'capabilities', 'permissions',
    'navigation', 'theme', 'strings', 'wechat', 'push', 'screenCapture', 'android', 'ios', 'desktop', 'release']
  // Harmony and the Mini Program are opt-in platforms: existing configs need no placeholder, but a
  // present block is strict. An explicit `"miniprogram": null` (0.17.0/0.17.1 configs) stays valid.
  const optional = ['harmony', 'miniprogram'].filter(key => key in config)
  only(config, '(root)', [...rootKeys, ...optional])
  const miniprogramEnabled = config.miniprogram !== undefined && config.miniprogram !== null

  const app = object(config.app, 'app')
  only(app, 'app', ['name', 'version'])
  string(app.name, 'app.name', /^[^/\\"<>&]{1,30}$/, '1-30 个字符，不能含 / \\ " < > &')
  string(app.version, 'app.version', VERSION, '必须是三段式版本号，例如 1.0.31')

  const web = object(config.web, 'web')
  only(web, 'web', ['command', 'outDir', 'version'])
  if (!Array.isArray(web.command) || web.command.length === 0) fail('web.command', '必须是非空字符串数组（不经过 shell）')
  web.command.forEach((part, i) => string(part, `web.command[${i}]`))
  relativePath(web.outDir, 'web.outDir')
  // Web 版本（热更新比新旧用）：二选一，写清楚来源。CI 自动发热更新时用环境变量（如 1.0.$CI_PIPELINE_IID），
  // 变量没设就报错，不回退到 package.json。
  const version = object(web.version, 'web.version')
  if (Object.keys(version).length !== 1) fail('web.version', '只能写 { "packageJson": "<路径>" } 或 { "env": "<变量名>" } 其中一个')
  if ('packageJson' in version) relativePath(version.packageJson, 'web.version.packageJson')
  else if ('env' in version) string(version.env, 'web.version.env', ENV_VAR, '环境变量名只含大写字母、数字、_')
  else fail('web.version', '只能写 { "packageJson": "<路径>" } 或 { "env": "<变量名>" }')

  const environments = object(config.environments, 'environments')
  if (Object.keys(environments).length === 0) fail('environments', '至少一个环境')
  for (const [name, env] of Object.entries(environments)) {
    string(name, `environments 键 ${name}`, ENV_NAME, '小写字母开头，只含小写字母、数字、-')
    object(env, `environments.${name}`)
    only(env, `environments.${name}`, ['buildEnv', 'artifactEnvironment', 'desktop', ...('miniprogram' in env ? ['miniprogram'] : [])])
    if (!miniprogramEnabled) {
      if (env.miniprogram !== undefined && env.miniprogram !== null) fail(`environments.${name}.miniprogram`, '没有启用 miniprogram 时省略或写 null')
    } else {
      const mp = object(env.miniprogram, `environments.${name}.miniprogram`)
      only(mp, `environments.${name}.miniprogram`, ['siteOrigin', 'apiOrigin'])
      httpsOrigin(mp.siteOrigin, `environments.${name}.miniprogram.siteOrigin`)
      nullable(mp.apiOrigin, `environments.${name}.miniprogram.apiOrigin`, httpsOrigin)
    }
    const buildEnv = object(env.buildEnv, `environments.${name}.buildEnv`)
    for (const [key, value] of Object.entries(buildEnv)) {
      string(key, `environments.${name}.buildEnv 键 ${key}`, ENV_VAR, '环境变量名只含大写字母、数字、_')
      if (key.startsWith('APPSHELL_')) fail(`environments.${name}.buildEnv.${key}`, 'APPSHELL_ 前缀保留给外壳注入')
      string(value, `environments.${name}.buildEnv.${key}`)
    }
    string(env.artifactEnvironment, `environments.${name}.artifactEnvironment`, ENV_NAME)
    if (config.desktop === null) {
      if (env.desktop !== null) fail(`environments.${name}.desktop`, '没有配置 desktop 时必须写 null')
    } else {
      const desktop = object(env.desktop, `environments.${name}.desktop`)
      only(desktop, `environments.${name}.desktop`, ['apiTarget', 'publicOrigin', 'buildEnv'])
      // 对外链接（分享、OAuth 回调）用的公网站点地址：桌面页面跑在本地站点，自己的 origin 发出去没人打得开
      string(desktop.publicOrigin, `environments.${name}.desktop.publicOrigin`, /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/, '公网站点地址，如 https://example.com')
      string(desktop.apiTarget, `environments.${name}.desktop.apiTarget`, /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/,
        '后端地址，形如 https://api.example.com（无路径，必须 https）')
      const desktopEnv = object(desktop.buildEnv, `environments.${name}.desktop.buildEnv`)
      for (const [key, value] of Object.entries(desktopEnv)) {
        string(key, `environments.${name}.desktop.buildEnv 键 ${key}`, ENV_VAR, '环境变量名只含大写字母、数字、_')
        if (key.startsWith('APPSHELL_')) fail(`environments.${name}.desktop.buildEnv.${key}`, 'APPSHELL_ 前缀保留给外壳注入')
        string(value, `environments.${name}.desktop.buildEnv.${key}`)
      }
    }
  }

  if (!Array.isArray(config.capabilities)) fail('capabilities', '必须是数组')
  const seen = new Set()
  for (const capability of config.capabilities) {
    if (!CAPABILITIES.includes(capability)) fail('capabilities', `未知能力 ${capability}（可选：${CAPABILITIES.join(', ')}）`)
    if (seen.has(capability)) fail('capabilities', `重复 ${capability}`)
    seen.add(capability)
  }
  const has = capability => seen.has(capability)

  if (!Array.isArray(config.permissions)) fail('permissions', '必须是数组')
  const declared = new Set()
  for (const permission of config.permissions) {
    if (!PERMISSIONS.includes(permission)) fail('permissions', `未知权限 ${permission}（可选：${PERMISSIONS.join(', ')}）`)
    if (declared.has(permission)) fail('permissions', `重复 ${permission}`)
    declared.add(permission)
  }
  if (has('recording') && !declared.has('microphone')) fail('permissions', '启用 recording 能力时必须声明 microphone')
  if (has('push') && !declared.has('notifications')) fail('permissions', '启用 push 能力时必须声明 notifications')

  if (has('push')) {
    const push = object(config.push, 'push')
    only(push, 'push', ['android', 'ios'])
    const android = object(push.android, 'push.android')
    if (!PUSH_PROVIDERS.includes(android.provider)) fail('push.android.provider', `只支持 ${PUSH_PROVIDERS.join(' / ')}`)
    if (android.provider === 'jpush') {
      only(android, 'push.android', ['provider', 'appKey', 'channels'])
      string(android.appKey, 'push.android.appKey', /^[0-9a-f]{24}$/, '极光 AppKey 为 24 位十六进制')
      const channels = object(android.channels, 'push.android.channels')
      for (const [name, value] of Object.entries(channels)) {
        if (!PUSH_CHANNELS[name]) fail(`push.android.channels.${name}`, `未知厂商通道（可选：${Object.keys(PUSH_CHANNELS).join(', ')}）`)
        object(value, `push.android.channels.${name}`)
        only(value, `push.android.channels.${name}`, PUSH_CHANNELS[name])
        for (const field of PUSH_CHANNELS[name]) {
          if (field === 'servicesFile') relativePath(value[field], `push.android.channels.${name}.${field}`)
          else string(value[field], `push.android.channels.${name}.${field}`, /^[A-Za-z0-9._-]{1,128}$/)
        }
      }
    } else {
      // 个推：AppID 与厂商通道参数进 manifestPlaceholders；点开通知的入口（厂商通道用 intent 跳转）由 tap 声明，
      // 后端下发的 intent 必须指向这个 scheme://host/path，外壳只认这一个入口。
      only(android, 'push.android', ['provider', 'appId', 'channels', 'notificationChannel', 'tap'])
      string(android.appId, 'push.android.appId', /^[A-Za-z0-9]{10,40}$/, '个推 AppID')
      const channels = object(android.channels, 'push.android.channels')
      for (const [name, value] of Object.entries(channels)) {
        if (!GETUI_CHANNELS[name]) fail(`push.android.channels.${name}`, `个推不支持这个厂商通道（可选：${Object.keys(GETUI_CHANNELS).join(', ')}）`)
        object(value, `push.android.channels.${name}`)
        only(value, `push.android.channels.${name}`, GETUI_CHANNELS[name])
        for (const field of GETUI_CHANNELS[name]) string(value[field], `push.android.channels.${name}.${field}`, /^[A-Za-z0-9._-]{1,128}$/)
      }
      // 厂商通道（OPPO、小米分类）要求通知渠道在 App 里先建好；id 与后端下发时用的渠道一致
      const channel = object(android.notificationChannel, 'push.android.notificationChannel')
      only(channel, 'push.android.notificationChannel', ['id', 'name'])
      string(channel.id, 'push.android.notificationChannel.id', /^[A-Za-z0-9_]{1,40}$/)
      string(channel.name, 'push.android.notificationChannel.name', /^[^<>&"\\]{1,40}$/, '1-40 个字符')
      const tap = object(android.tap, 'push.android.tap')
      only(tap, 'push.android.tap', ['scheme', 'host', 'path'])
      string(tap.scheme, 'push.android.tap.scheme', /^[a-z][a-z0-9+.-]{1,30}$/, '自定义 scheme，如 myapppush')
      string(tap.host, 'push.android.tap.host', /^[a-z0-9][a-z0-9.-]{0,62}$/)
      string(tap.path, 'push.android.tap.path', /^\/[A-Za-z0-9/_-]{0,62}$/, '以 / 开头')
    }
    const ios = object(push.ios, 'push.ios')
    only(ios, 'push.ios', ['provider', 'environment'])
    if (ios.provider !== 'apns') fail('push.ios.provider', 'iOS 只支持 apns（直连苹果推送）')
    if (!['development', 'production'].includes(ios.environment)) fail('push.ios.environment', 'development 或 production')
  } else if (config.push !== null) {
    fail('push', '未启用 push 能力时必须写 null')
  }

  const navigation = object(config.navigation, 'navigation')
  only(navigation, 'navigation', ['nativeBackEvent', 'rootPages', 'shortcuts'])
  string(navigation.nativeBackEvent, 'navigation.nativeBackEvent', /^[a-z][a-z0-9:-]{0,62}$/)
  if (!Array.isArray(navigation.rootPages) || navigation.rootPages.length === 0) fail('navigation.rootPages', '至少一个根页')
  navigation.rootPages.forEach((page, i) => {
    const where = `navigation.rootPages[${i}]`
    object(page, where)
    only(page, where, ['path', 'childQuery'])
    string(page.path, `${where}.path`, ROUTE, '以 / 开头，只含字母、数字、-、_、/')
    if (!Array.isArray(page.childQuery)) fail(`${where}.childQuery`, '必须是数组')
    page.childQuery.forEach((q, j) => string(q, `${where}.childQuery[${j}]`, QUERY, '写 key 或 key=value'))
  })
  if (!Array.isArray(navigation.shortcuts) || navigation.shortcuts.length > 4) fail('navigation.shortcuts', '必须是 0-4 项的数组')
  const shortcutIds = new Set()
  navigation.shortcuts.forEach((item, i) => {
    const where = `navigation.shortcuts[${i}]`
    object(item, where)
    only(item, where, ['id', 'label', 'icon', 'path'])
    string(item.id, `${where}.id`, /^[a-z][a-z0-9_]{0,30}$/)
    if (shortcutIds.has(item.id)) fail(`${where}.id`, '重复')
    shortcutIds.add(item.id)
    string(item.label, `${where}.label`, /^[^"\\]{1,20}$/, '1-20 个字符，不能含 " 或 \\')
    string(item.icon, `${where}.icon`)
    if (!SYSTEM_ICONS.has(item.icon)) fail(`${where}.icon`, `只支持系统图标：${[...SYSTEM_ICONS].join(', ')}`)
    string(item.path, `${where}.path`, ROUTE, '以 / 开头，只含字母、数字、-、_、/')
  })

  const theme = object(config.theme, 'theme')
  only(theme, 'theme', ['startupBackground', 'startupInk', 'startupActive', 'legacyNavigationBar'])
  for (const key of Object.keys(theme)) string(theme[key], `theme.${key}`, COLOR, '必须是 #RRGGBB')

  const strings = object(config.strings, 'strings')
  const stringKeys = ['backAgainToDesktop']
  if (has('recording')) stringKeys.push('recordingNotificationChannel', 'recordingNotificationTitle', 'recordingNotificationText')
  if (has('screenCapture')) stringKeys.push('screenCaptureNotificationChannel', 'screenCaptureNotificationTitle', 'screenCaptureNotificationText', 'screenCaptureStop')
  only(strings, 'strings', stringKeys)
  for (const key of stringKeys) string(strings[key], `strings.${key}`, /^[^<>&"\\]{1,80}$/, '1-80 个字符，不能含 < > & " \\')

  if (has('wechat')) {
    const wechat = object(config.wechat, 'wechat')
    only(wechat, 'wechat', ['appId'])
    string(wechat.appId, 'wechat.appId', /^wx[0-9a-f]{16}$/, '微信开放平台移动应用 AppID，形如 wx 加 16 位十六进制')
  } else if (config.wechat !== null) {
    fail('wechat', '未启用 wechat 能力时必须写 null')
  }

  // 屏幕共享（screenCapture）：推流 / 续租 / 回放上传地址的主机必须在 allowedHosts（本域或其子域）里，
  // 网页传来的地址不在白名单就拒绝——原生层不替网页判断「该不该共享」，但不往任意地址发屏幕画面。
  if (has('screenCapture')) {
    const capture = object(config.screenCapture, 'screenCapture')
    only(capture, 'screenCapture', ['allowedHosts', 'broadcastName'])
    if (!Array.isArray(capture.allowedHosts) || capture.allowedHosts.length === 0) fail('screenCapture.allowedHosts', '至少一个域名')
    capture.allowedHosts.forEach((host, i) => string(host, `screenCapture.allowedHosts[${i}]`, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, '域名（不含协议、端口、通配符），子域自动包含'))
    // iOS 系统广播面板里显示的扩展名
    string(capture.broadcastName, 'screenCapture.broadcastName', /^[^/\\"<>&]{1,30}$/, '1-30 个字符')
  } else if (config.screenCapture !== null) {
    fail('screenCapture', '未启用 screenCapture 能力时必须写 null')
  }

  const android = object(config.android, 'android')
  only(android, 'android', ['applicationId', 'versionCode', 'storageDir', 'resources', 'nativeHttp',
    ...(mode === 'apollo' ? [] : ['signing']), 'hotUpdate', 'legacyActivities', 'extension'])
  // 业务扩展：通用能力组覆盖不了的原生代码，作为一个 Android 库模块（Java / Kotlin、资源、Manifest、单测）随包编进去。
  // 没有就写 null。见 docs/desktop-extension.md「Android」。
  nullable(android.extension, 'android.extension', (value, where) => {
    const ext = object(value, where)
    only(ext, where, ['dir', 'plugins', 'dependencies', 'repositories', 'manifestPlaceholders'])
    relativePath(ext.dir, `${where}.dir`)
    const list = (key, hint) => { if (!Array.isArray(ext[key])) fail(`${where}.${key}`, `必须是数组（没有就写 []）；${hint}`); return ext[key] }
    list('plugins', '要登记的 Capacitor 插件完整类名').forEach((name, i) =>
      string(name, `${where}.plugins[${i}]`, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.[A-Z][A-Za-z0-9_]*$/, '完整类名，如 com.example.app.FooPlugin'))
    list('dependencies', 'Maven 坐标，版本写死').forEach((dep, i) =>
      string(dep, `${where}.dependencies[${i}]`, /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[0-9][A-Za-z0-9_.+-]*$/, 'group:artifact:version，不允许动态版本'))
    list('repositories', '额外的 Maven 仓库（https）').forEach((url, i) =>
      string(url, `${where}.repositories[${i}]`, /^https:\/\/[^\s"'\\]+$/, 'https 地址'))
    for (const [key, val] of Object.entries(object(ext.manifestPlaceholders, `${where}.manifestPlaceholders`))) {
      string(key, `${where}.manifestPlaceholders 键 ${key}`, /^[A-Z][A-Z0-9_]*$/, '大写字母、数字、_')
      string(val, `${where}.manifestPlaceholders.${key}`, /^[^"\\$]{0,200}$/)
    }
  })
  // 从别的工程迁过来时，旧版本的入口 Activity 全名：生成 activity-alias，升级后桌面图标 / 固定的快捷方式仍能找到入口
  if (!Array.isArray(android.legacyActivities)) fail('android.legacyActivities', '必须是数组（没有就写 []）')
  android.legacyActivities.forEach((name, i) => string(name, `android.legacyActivities[${i}]`, /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/, '完整类名，如 ai.example.app.MainActivity'))
  string(android.applicationId, 'android.applicationId', APP_ID, '形如 com.example.app')
  integer(android.versionCode, 'android.versionCode', 1, 2100000000)
  string(android.storageDir, 'android.storageDir', /^[A-Za-z0-9][A-Za-z0-9 _-]{0,40}$/, '只含字母、数字、空格、_、-')
  relativePath(android.resources, 'android.resources')
  boolean(android.nativeHttp, 'android.nativeHttp')
  if (mode !== 'apollo') {
    const signing = object(android.signing, 'android.signing')
    only(signing, 'android.signing', ['propertiesFile'])
    nullable(signing.propertiesFile, 'android.signing.propertiesFile', (v, w) => string(v, w))
  }
  // 热更新：开了 hotUpdate 必填。apply=next-launch 时原生自己后台查、下载，下次冷启动切换；
  // latestUrl 每个环境一条（壳里烘的是哪个环境，就查哪个环境），返回 { version, url }。
  if (config.capabilities.includes('hotUpdate')) {
    const hot = object(android.hotUpdate, 'android.hotUpdate')
    only(hot, 'android.hotUpdate', ['apply', 'latestUrl'])
    if (!['next-launch', 'prompt'].includes(hot.apply)) fail('android.hotUpdate.apply', 'next-launch 或 prompt')
    const urls = object(hot.latestUrl, 'android.hotUpdate.latestUrl')
    for (const name of Object.keys(config.environments)) {
      string(urls[name], `android.hotUpdate.latestUrl.${name}`, /^https:\/\/[^\s"\\]+$/, '该环境查询最新热更新包的 https 地址')
    }
    for (const name of Object.keys(urls)) if (!(name in config.environments)) fail(`android.hotUpdate.latestUrl.${name}`, '不是已声明的环境')
  } else if (android.hotUpdate !== null) {
    fail('android.hotUpdate', '没有开 hotUpdate 能力组时写 null')
  }

  const ios = object(config.ios, 'ios')
  only(ios, 'ios', ['bundleId', 'version', 'buildNumber', 'deploymentTarget', 'deviceFamily', 'teamId', 'resources', 'nativeHttp',
    'backgroundRecording', 'pullToRefresh', 'usageDescriptions', 'extension', 'hotUpdate'])
  string(ios.bundleId, 'ios.bundleId', BUNDLE_ID, '形如 com.example.app')
  // iOS 自己的版本线：App Store Connect 要求新包版本不低于已上架版本，和 Android / 桌面不一定同步
  string(ios.version, 'ios.version', VERSION, 'iOS 版本，三段式，如 1.3.0')
  integer(ios.buildNumber, 'ios.buildNumber', 1, 2100000000)
  string(ios.deploymentTarget, 'ios.deploymentTarget', /^1[5-9]\.\d$|^2\d\.\d$/, '形如 17.0，不低于 15.0')
  if (!['1', '1,2'].includes(ios.deviceFamily)) fail('ios.deviceFamily', '只能是 "1"（iPhone）或 "1,2"（iPhone+iPad）')
  nullable(ios.teamId, 'ios.teamId', (v, w) => string(v, w, /^[A-Z0-9]{10}$/, 'Apple 团队 ID 为 10 位大写字母数字'))
  relativePath(ios.resources, 'ios.resources')
  // 热更新：开了 hotUpdate 必填，语义与 android.hotUpdate 相同。bundleAppId 是接受的热更新包清单里的 appId：
  // iOS 与 Android 用同一份 shell 构建时填 android.applicationId（共用 Android 那条热更新包，不必另发一份）。
  if (config.capabilities.includes('hotUpdate')) {
    const hot = object(ios.hotUpdate, 'ios.hotUpdate')
    only(hot, 'ios.hotUpdate', ['apply', 'latestUrl', 'bundleAppId'])
    if (!['next-launch', 'prompt'].includes(hot.apply)) fail('ios.hotUpdate.apply', 'next-launch 或 prompt')
    string(hot.bundleAppId, 'ios.hotUpdate.bundleAppId', BUNDLE_ID, '接受的热更新包的 appId')
    const urls = object(hot.latestUrl, 'ios.hotUpdate.latestUrl')
    for (const name of Object.keys(config.environments)) {
      string(urls[name], `ios.hotUpdate.latestUrl.${name}`, /^https:\/\/[^\s"\\]+$/, '该环境查询最新热更新包的 https 地址')
    }
    for (const name of Object.keys(urls)) if (!(name in config.environments)) fail(`ios.hotUpdate.latestUrl.${name}`, '不是已声明的环境')
  } else if (ios.hotUpdate !== null) {
    fail('ios.hotUpdate', '没有开 hotUpdate 能力组时写 null')
  }
  // 业务扩展：通用能力组覆盖不了的原生代码（Swift 源码 + Capacitor 插件），由业务仓库提供。没有就写 null。
  nullable(ios.extension, 'ios.extension', (value, where) => {
    const ext = object(value, where)
    only(ext, where, ['dir', 'plugins', 'systemCapabilities', 'resources', 'packages', 'infoPlist', 'entitlements', 'linkerFlags', 'buildScripts'])
    relativePath(ext.dir, `${where}.dir`)
    if (!Array.isArray(ext.plugins)) fail(`${where}.plugins`, '必须是数组：要登记的 Capacitor 插件类名（没有就写 []）')
    ext.plugins.forEach((name, i) => string(name, `${where}.plugins[${i}]`, /^[A-Z][A-Za-z0-9_]*$/, 'Swift 类名'))
    if (!Array.isArray(ext.systemCapabilities)) fail(`${where}.systemCapabilities`, '必须是数组（没有就写 []），如 com.apple.InAppPurchase')
    ext.systemCapabilities.forEach((name, i) => string(name, `${where}.systemCapabilities[${i}]`, /^com\.apple\.[A-Za-z.]+$/, '形如 com.apple.InAppPurchase'))
    const list = (key, hint) => { if (!Array.isArray(ext[key])) fail(`${where}.${key}`, `必须是数组（没有就写 []）；${hint}`); return ext[key] }
    // 以下路径都相对扩展目录
    list('resources', '随 App 打包的资源文件或 .bundle').forEach((name, i) => string(name, `${where}.resources[${i}]`, /^[A-Za-z0-9_.-]+$/, '扩展目录下的文件名'))
    list('packages', '本地 Swift Package').forEach((pkg, i) => {
      only(object(pkg, `${where}.packages[${i}]`), `${where}.packages[${i}]`, ['dir', 'product'])
      relativePath(pkg.dir, `${where}.packages[${i}].dir`)
      string(pkg.product, `${where}.packages[${i}].product`, /^[A-Za-z][A-Za-z0-9_]*$/, 'Package 的 library 产品名')
    })
    object(ext.infoPlist, `${where}.infoPlist`)       // 并入 Info.plist 的键（URL scheme、LSApplicationQueriesSchemes 等），没有写 {}
    object(ext.entitlements, `${where}.entitlements`) // 并入 entitlements（关联域名等），没有写 {}
    list('linkerFlags', '追加的链接参数，如 -ObjC').forEach((flag, i) => string(flag, `${where}.linkerFlags[${i}]`, /^-[A-Za-z0-9_,.=-]+$/, '形如 -ObjC'))
    list('buildScripts', '构建末尾运行的脚本').forEach((item, i) => {
      only(object(item, `${where}.buildScripts[${i}]`), `${where}.buildScripts[${i}]`, ['name', 'script'])
      string(item.name, `${where}.buildScripts[${i}].name`)
      // 脚本内可用 Xcode 的构建变量与 $APPSHELL_EXTENSION_DIR（扩展目录在工程里的副本）
      string(item.script, `${where}.buildScripts[${i}].script`)
    })
  })
  boolean(ios.nativeHttp, 'ios.nativeHttp')
  boolean(ios.backgroundRecording, 'ios.backgroundRecording')
  if (ios.backgroundRecording && !has('recording')) fail('ios.backgroundRecording', '需要先启用 recording 能力')
  // 录音能力组的 iOS 代码用 AVAudioApplication（iOS 17+）；没开录音的 App 可以低到 15.0
  if (has('recording') && Number(ios.deploymentTarget.split('.')[0]) < 17) fail('ios.deploymentTarget', '启用 recording 能力时最低 17.0')
  const refresh = object(ios.pullToRefresh, 'ios.pullToRefresh')
  only(refresh, 'ios.pullToRefresh', ['enabled', 'blockSelector'])
  boolean(refresh.enabled, 'ios.pullToRefresh.enabled')
  nullable(refresh.blockSelector, 'ios.pullToRefresh.blockSelector', (v, w) => string(v, w))
  const usage = object(ios.usageDescriptions, 'ios.usageDescriptions')
  for (const [key, text] of Object.entries(usage)) {
    string(key, `ios.usageDescriptions 键 ${key}`, /^NS[A-Za-z]+UsageDescription$/)
    string(text, `ios.usageDescriptions.${key}`)
  }
  const expectedKeys = [...declared].map(name => IOS_USAGE_KEYS[name]).filter(Boolean)
  for (const key of expectedKeys) {
    if (!usage[key]) fail(`ios.usageDescriptions.${key}`, '声明了对应权限时必填')
  }
  for (const key of Object.keys(usage)) {
    if (!expectedKeys.includes(key)) fail(`ios.usageDescriptions.${key}`, '没有声明对应权限；多余的说明会让审核以为 App 用了该能力')
  }

  if (config.desktop !== null) {
    const desktop = object(config.desktop, 'desktop')
    only(desktop, 'desktop', ['appId', 'version', 'web', 'apiPath', 'scheme', 'window', 'resources', 'hotUpdate', 'mac', 'extension'])
    // macOS 专有：Info.plist 里除 permissions 推导出的那几条之外的权限说明（如系统声音 NSAudioCaptureUsageDescription），
    // 以及各语言的权限弹窗文案（键是 .lproj 目录名，如 zh_CN；系统按系统语言取，取不到用 Info.plist 那份）。
    const mac = object(desktop.mac, 'desktop.mac')
    only(mac, 'desktop.mac', ['usageDescriptions', 'localizedUsageDescriptions'])
    const usageText = (table, where) => {
      for (const [key, text] of Object.entries(object(table, where))) {
        string(key, `${where} 键 ${key}`, /^NS[A-Za-z]+UsageDescription$/)
        string(text, `${where}.${key}`)
      }
    }
    usageText(mac.usageDescriptions, 'desktop.mac.usageDescriptions')
    for (const [dir, table] of Object.entries(object(mac.localizedUsageDescriptions, 'desktop.mac.localizedUsageDescriptions'))) {
      string(dir, `desktop.mac.localizedUsageDescriptions 键 ${dir}`, /^[a-z]{2,3}(_[A-Za-z0-9]{2,4})?$/, '.lproj 目录名，如 zh_CN、en、es_419')
      usageText(table, `desktop.mac.localizedUsageDescriptions.${dir}`)
    }
    // 业务扩展：通用能力组覆盖不了的原生代码（主进程模块 + 主窗口预加载脚本），由业务仓库构建、随包带上。
    // 没有就写 null。见 docs/desktop-extension.md。
    nullable(desktop.extension, 'desktop.extension', (value, where) => {
      const ext = object(value, where)
      only(ext, where, ['command', 'dir', 'asarUnpack'])
      if (!Array.isArray(ext.command) || ext.command.length === 0) fail(`${where}.command`, '必须是非空字符串数组（不经过 shell）；产出 dir 目录')
      ext.command.forEach((part, i) => string(part, `${where}.command[${i}]`))
      relativePath(ext.dir, `${where}.dir`)
      if (!Array.isArray(ext.asarUnpack)) fail(`${where}.asarUnpack`, '必须是数组（没有就写 []）；相对扩展目录的 glob，这些文件不进 asar（要被执行的二进制）')
      ext.asarUnpack.forEach((glob, i) => string(glob, `${where}.asarUnpack[${i}]`, /^[A-Za-z0-9_@.*-]+(\/[A-Za-z0-9_@.*-]+)*$/, '相对路径 glob，如 bin/**'))
    })
    string(desktop.appId, 'desktop.appId', APP_ID, '形如 ai.example.app')
    // 桌面安装包自己的版本线（例如 ExampleApp 桌面 1.1.x、手机 1.0.x），与 app.version 分开
    string(desktop.version, 'desktop.version', VERSION, '桌面安装包版本，三段式，如 1.1.57')
    const web = object(desktop.web, 'desktop.web')
    only(web, 'desktop.web', ['command', 'outDir'])
    if (!Array.isArray(web.command) || web.command.length === 0) fail('desktop.web.command', '必须是非空字符串数组（不经过 shell）')
    web.command.forEach((part, i) => string(part, `desktop.web.command[${i}]`))
    relativePath(web.outDir, 'desktop.web.outDir')
    string(desktop.apiPath, 'desktop.apiPath', /^\/[A-Za-z0-9/_-]+$/, '同源 API 前缀，如 /api/v1；本地站点把它转发到 apiTarget')
    nullable(desktop.scheme, 'desktop.scheme', (v, w) => string(v, w, /^[a-z][a-z0-9+.-]{1,30}$/, '自定义 URL scheme，如 myapp'))
    const win = object(desktop.window, 'desktop.window')
    only(win, 'desktop.window', ['width', 'height', 'minWidth', 'minHeight'])
    for (const key of Object.keys(win)) integer(win[key], `desktop.window.${key}`, 320, 8000)
    if (win.minWidth > win.width || win.minHeight > win.height) fail('desktop.window', '最小尺寸不能大于默认尺寸')
    relativePath(desktop.resources, 'desktop.resources')
    // 桌面热更新：开了 hotUpdate 能力组就必须写清楚去哪查最新版、页面用哪个本地端点前缀；没开就写 null。
    if (config.capabilities.includes('hotUpdate')) {
      const hot = object(desktop.hotUpdate, 'desktop.hotUpdate')
      only(hot, 'desktop.hotUpdate', ['latestPath', 'endpointPrefix', 'apply'])
      if (!['next-launch', 'prompt'].includes(hot.apply)) {
        fail('desktop.hotUpdate.apply', 'next-launch（下载好后下次冷启动自动切换）或 prompt（等页面调 activate）')
      }
      string(hot.latestPath, 'desktop.hotUpdate.latestPath', /^\/[A-Za-z0-9/_.-]+(\?[A-Za-z0-9=&_.-]+)?$/,
        '相对 desktop.apiPath 的查询路径，返回 { version, url }，如 /app/releases/latest?platform=desktop-webbundle')
      string(hot.endpointPrefix, 'desktop.hotUpdate.endpointPrefix', /^\/__[a-z0-9-]+$/, '本地端点前缀，如 /__example')
    } else if (desktop.hotUpdate !== null) {
      fail('desktop.hotUpdate', '没有开 hotUpdate 能力组时写 null')
    }
  }

  if (miniprogramEnabled) {
    const mp = object(config.miniprogram, 'miniprogram')
    only(mp, 'miniprogram', ['appId', 'version', 'libVersion', 'entryPath', 'extension'])
    string(mp.appId, 'miniprogram.appId', /^wx[0-9a-f]{16}$/, '微信小程序 AppID（不是移动应用 AppID）')
    string(mp.version, 'miniprogram.version', VERSION, '必须是三段式版本号')
    string(mp.libVersion, 'miniprogram.libVersion', VERSION, '必须锁定三段式基础库版本')
    if (!validateMiniProgramPath(mp.entryPath)) fail('miniprogram.entryPath', '必须是安全站内路径（如 /login），不能使用 URL、穿越路径或控制字符')
    nullable(mp.extension, 'miniprogram.extension', (value, where) => {
      const ext = object(value, where)
      only(ext, where, ['command', 'dir'])
      if (!Array.isArray(ext.command) || ext.command.length === 0) fail(`${where}.command`, '必须是非空字符串数组（不经过 shell）')
      ext.command.forEach((part, i) => string(part, `${where}.command[${i}]`))
      relativePath(ext.dir, `${where}.dir`)
      if (ext.dir === '.' || ext.dir.split(/[\\/]/).filter(Boolean).length === 0) fail(`${where}.dir`, '不能使用仓库根目录')
    })
  }

  if ('harmony' in config) validateHarmony(config, fail, mode)

  if (config.release !== null) {
    const release = object(config.release, 'release')
    only(release, 'release', ['artifactService', 'artifactProject'])
    string(release.artifactService, 'release.artifactService', /^https:\/\/[a-z0-9.-]+(:\d+)?$/, 'Artifact Service 地址，例如 https://artifacts.example.com')
    string(release.artifactProject, 'release.artifactProject', SLUG, 'Artifact Service 项目 slug')
  }

  // Callers check `config.miniprogram === null` for "not enabled"; an omitted block means the same.
  return Object.freeze({ ...config, miniprogram: miniprogramEnabled ? config.miniprogram : null, root })
}

// nsh 应用：界面、能力（权限）、热更新密钥信任都写在 nsh 自己的 nsh.json 里，这里只管
// 包名 / 版本 / 签名 / 各环境的值 / 发版，避免两处声明同一件事。
const NSH_VERSION = /^\d+\.\d+\.\d+$/

function parseNshConfig(config, root) {
  only(config, '(root)', ['schemaVersion', 'engine', 'app', 'nsh', 'environments', 'android', 'ios', 'desktop', 'ota', 'release'])
  const app = object(config.app, 'app')
  only(app, 'app', ['name', 'version'])
  string(app.name, 'app.name', /^[^/\\"<>&]{1,30}$/, '1-30 个字符，不能含 / \\ " < > &')
  string(app.version, 'app.version', VERSION, '必须是三段式版本号，例如 1.0.0')

  const nsh = object(config.nsh, 'nsh')
  only(nsh, 'nsh', ['version', 'dir', 'entry'])
  string(nsh.version, 'nsh.version', NSH_VERSION, '锁定的 nsh 版本，例如 0.4.0（0.x 变化快，必须锁）')
  relativePath(nsh.dir, 'nsh.dir')
  nullable(nsh.entry, 'nsh.entry', (v, w) => string(v, w, /^[A-Za-z0-9_./-]+\.tsx$/, 'TSX 入口文件，相对 nsh.dir；Rust 应用写 null'))

  const environments = object(config.environments, 'environments')
  if (Object.keys(environments).length === 0) fail('environments', '至少一个环境')
  for (const [name, env] of Object.entries(environments)) {
    string(name, `environments 键 ${name}`, ENV_NAME, '小写字母开头，只含小写字母、数字、-')
    object(env, `environments.${name}`)
    only(env, `environments.${name}`, ['values', 'artifactEnvironment'])
    const values = object(env.values, `environments.${name}.values`)
    for (const [key, value] of Object.entries(values)) {
      string(key, `environments.${name}.values 键 ${key}`, /^[A-Za-z][A-Za-z0-9_]*$/)
      if (!['string', 'number', 'boolean'].includes(typeof value)) fail(`environments.${name}.values.${key}`, '只能是字符串、数字或布尔')
    }
    string(env.artifactEnvironment, `environments.${name}.artifactEnvironment`, ENV_NAME)
  }

  const android = object(config.android, 'android')
  only(android, 'android', ['applicationId', 'versionCode', 'signing'])
  string(android.applicationId, 'android.applicationId', APP_ID, '形如 com.example.app')
  integer(android.versionCode, 'android.versionCode', 1, 2100000000)
  const aSign = object(android.signing, 'android.signing')
  only(aSign, 'android.signing', ['keystore', 'keyAlias'])
  nullable(aSign.keystore, 'android.signing.keystore', (v, w) => string(v, w))
  nullable(aSign.keyAlias, 'android.signing.keyAlias', (v, w) => string(v, w))
  if ((aSign.keystore === null) !== (aSign.keyAlias === null)) fail('android.signing', 'keystore 与 keyAlias 要么都填，要么都是 null')

  const ios = object(config.ios, 'ios')
  only(ios, 'ios', ['bundleId', 'buildNumber', 'signing'])
  string(ios.bundleId, 'ios.bundleId', BUNDLE_ID, '形如 com.example.app')
  integer(ios.buildNumber, 'ios.buildNumber', 1, 2100000000)
  const iSign = object(ios.signing, 'ios.signing')
  only(iSign, 'ios.signing', ['identity', 'profile'])
  nullable(iSign.identity, 'ios.signing.identity', (v, w) => string(v, w))
  nullable(iSign.profile, 'ios.signing.profile', (v, w) => string(v, w))
  if ((iSign.identity === null) !== (iSign.profile === null)) fail('ios.signing', 'identity 与 profile 要么都填，要么都是 null')

  if (config.desktop !== null) {
    const desktop = object(config.desktop, 'desktop')
    only(desktop, 'desktop', ['appId'])
    string(desktop.appId, 'desktop.appId', APP_ID, '形如 ai.example.app')
  }

  // nsh 0.4.0 只有签名包（nsh publish），还没有下发与更新清单（update-manifest 只在 nightly）。
  // 字段先占位为 null，等 nsh 正式版带上 OTA 再开。
  if (config.ota !== null) fail('ota', 'nsh 0.4.0 还没有 OTA 下发能力，先写 null')

  if (config.release !== null) {
    const release = object(config.release, 'release')
    only(release, 'release', ['artifactService', 'artifactProject'])
    string(release.artifactService, 'release.artifactService', /^https:\/\/[a-z0-9.-]+(:\d+)?$/, 'Artifact Service 地址，例如 https://artifacts.example.com')
    string(release.artifactProject, 'release.artifactProject', SLUG, 'Artifact Service 项目 slug')
  }
  return Object.freeze({ ...config, root })
}

export function findConfigRoot(start) {
  let dir = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new ConfigError(`从 ${start} 向上找不到 ${CONFIG_FILE}`)
    dir = parent
  }
}

export function loadConfig(start) {
  const root = findConfigRoot(start)
  const file = path.join(root, CONFIG_FILE)
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new ConfigError(`${file} 不是合法 JSON：${error.message}`)
  }
  return parseConfig(raw, root)
}

export function environment(config, name) {
  if (typeof name !== 'string' || !name) throw new ConfigError('必须用 --env 指定环境')
  const env = config.environments[name]
  if (!env) throw new ConfigError(`未知环境 ${name}（${CONFIG_FILE} 里有：${Object.keys(config.environments).join(', ')}）`)
  return { name, ...env }
}

export function webVersion(config) {
  const source = config.web.version
  let version
  let where
  if (source.env) {
    version = process.env[source.env]
    where = `环境变量 ${source.env}`
  } else {
    version = JSON.parse(fs.readFileSync(path.join(config.root, source.packageJson), 'utf8')).version
    where = `${source.packageJson} 的 version`
  }
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new ConfigError(`${where} 必须是三段式版本号，当前：${version ?? '未设置'}`)
  }
  return version
}
