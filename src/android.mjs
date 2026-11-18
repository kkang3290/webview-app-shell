// Android：模板 + 已启用能力组 + 业务资源 → 一次性生成的 Gradle 工程（.appshell/android）。
// 生成目录可以随时删掉重来，业务仓库不保存任何原生工程文件。
import fs from 'node:fs'
import path from 'node:path'

import { buildWeb, MANIFEST_FILE } from './web.mjs'
import { operationContext } from './context.mjs'
import {
  TEMPLATES, fail, log, run, copyDir, linkCapacitor, cap, javaString, xmlText, workDir, outDir, artifactName,
  writeSha256,
} from './util.mjs'

const TEMPLATE = path.join(TEMPLATES, 'android')
const PACKAGE_PATH = 'org/appshell'
const REQUIRED_RESOURCES = ['ic_launcher', 'ic_launcher_round', 'appshell_splash_mark']

/** 业务资源目录里必须有的文件（不看扩展名、不看密度目录），缺了在 prebuild 就报，而不是等 aapt。 */
export function checkResources(dir, capabilities) {
  if (!fs.existsSync(dir)) fail(`android.resources 目录不存在：${dir}`)
  const names = new Set()
  for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!sub.isDirectory()) fail(`android.resources 只能包含 res 子目录（mipmap-*、drawable-* …），发现 ${sub.name}`)
    for (const file of fs.readdirSync(path.join(dir, sub.name))) names.add(file.replace(/\.[^.]+$/, ''))
  }
  const required = [...REQUIRED_RESOURCES, ...(capabilities.includes('wechat') ? ['wechat_share_cover'] : [])]
  const missing = required.filter(name => !names.has(name))
  if (missing.length) fail(`android.resources 缺少资源：${missing.join(', ')}`)
}

// 厂商通道 → Gradle manifestPlaceholders（前缀按极光文档：OPPO 加 OP-，魅族加 MZ-）
const CHANNEL_PLACEHOLDERS = {
  xiaomi: c => ({ XIAOMI_APPID: c.appId, XIAOMI_APPKEY: c.appKey }),
  oppo: c => ({ OPPO_APPID: `OP-${c.appId}`, OPPO_APPKEY: `OP-${c.appKey}`, OPPO_APPSECRET: `OP-${c.appSecret}` }),
  vivo: c => ({ VIVO_APPID: c.appId, VIVO_APPKEY: c.appKey }),
  honor: c => ({ HONOR_APPID: c.appId }),
  meizu: c => ({ MEIZU_APPID: `MZ-${c.appId}`, MEIZU_APPKEY: `MZ-${c.appKey}` }),
  huawei: () => ({}),
}

// 个推厂商通道 → manifestPlaceholders 与依赖（版本固定；个推仓库托管）
const GETUI_SDK = { gtsdk: 'com.getui:gtsdk:3.3.16.0', gtc: 'com.getui:gtc:3.3.4.0' }
const GETUI_CHANNEL_GRADLE = {
  huawei: { placeholders: c => ({ HUAWEI_APP_ID: c.appId }), dependencies: ['com.getui.opt:hwp:3.1.4', 'com.huawei.hms:push:6.12.0.300'] },
  xiaomi: { placeholders: c => ({ XIAOMI_APP_ID: c.appId, XIAOMI_APP_KEY: c.appKey }), dependencies: ['com.getui.opt:xmp:3.3.7'] },
  oppo: {
    placeholders: c => ({ OPPO_APP_KEY: c.appKey, OPPO_APP_SECRET: c.appSecret }),
    // OPPO 插件自带的 gson / commons-codec 与 support 库会冲突，排除后单独引入
    dependencies: [{ notation: 'com.assist-v3:oppo:3.6.0', excludes: ['com.google.code.gson', 'commons-codec', 'com.android.support'] },
      'com.google.code.gson:gson:2.13.2', 'commons-codec:commons-codec:1.19.0', 'androidx.annotation:annotation:1.9.1'],
  },
  vivo: { placeholders: c => ({ VIVO_APP_ID: c.appId, VIVO_APP_KEY: c.appKey }), dependencies: ['com.assist-v3:vivo:3.2.0'] },
  honor: { placeholders: c => ({ HONOR_APP_ID: c.appId }), dependencies: ['com.getui.opt:honor:3.6.0'] },
}
export const GETUI_REPOSITORY = 'https://mvn.getui.com/nexus/content/repositories/releases/'
export const HUAWEI_REPOSITORY = 'https://developer.huawei.com/repo/'
export const JITPACK_REPOSITORY = 'https://jitpack.io'

export function pushGradle(config) {
  if (!config.capabilities.includes('push')) return null
  const android = config.push.android
  if (android.provider === 'getui') {
    // 所有厂商占位符都写上（没配的为空串）：各厂商插件的 Manifest 引用它们，缺了合并会失败
    const placeholders = { GETUI_APPID: android.appId, HUAWEI_APP_ID: '', XIAOMI_APP_ID: '', XIAOMI_APP_KEY: '', OPPO_APP_KEY: '',
      OPPO_APP_SECRET: '', VIVO_APP_ID: '', VIVO_APP_KEY: '', HONOR_APP_ID: '',
      APPSHELL_PUSH_TAP_SCHEME: android.tap.scheme, APPSHELL_PUSH_TAP_HOST: android.tap.host, APPSHELL_PUSH_TAP_PATH: android.tap.path }
    const dependencies = [GETUI_SDK.gtsdk, GETUI_SDK.gtc]
    for (const [name, channel] of Object.entries(android.channels)) {
      Object.assign(placeholders, GETUI_CHANNEL_GRADLE[name].placeholders(channel))
      dependencies.push(...GETUI_CHANNEL_GRADLE[name].dependencies)
    }
    return {
      provider: 'getui',
      channels: Object.keys(android.channels),
      placeholders,
      // Gradle 侧统一按 { notation, excludes } 处理
      dependencies: dependencies.map(dep => (typeof dep === 'string' ? { notation: dep, excludes: [] } : dep)),
      repositories: [GETUI_REPOSITORY, ...(android.channels.huawei ? [HUAWEI_REPOSITORY] : [])],
      huaweiServicesFile: null,
    }
  }
  const placeholders = { JPUSH_APPKEY: android.appKey, JPUSH_CHANNEL: 'appshell' }
  for (const [name, channel] of Object.entries(android.channels)) Object.assign(placeholders, CHANNEL_PLACEHOLDERS[name](channel))
  return {
    provider: 'jpush',
    sdkVersion: '6.3.0',
    channels: Object.keys(android.channels),
    placeholders,
    dependencies: [],
    repositories: [],
    huaweiServicesFile: android.channels.huawei ? path.resolve(config.root, android.channels.huawei.servicesFile) : null,
  }
}

/** 业务扩展模块（android.extension）在生成工程里的名字与 Gradle 输入。 */
export const EXTENSION_MODULE = 'appshell-extension'

export function extensionGradle(config) {
  const ext = config.android.extension
  if (!ext) return null
  return { module: EXTENSION_MODULE, dependencies: ext.dependencies, manifestPlaceholders: ext.manifestPlaceholders }
}

/** 要额外加的 Maven 仓库（去重、保持顺序）：推送 SDK、屏幕共享的 RTMP 库、业务扩展声明的。 */
export function gradleRepositories(config) {
  const push = pushGradle(config)
  const all = [
    ...(push ? push.repositories : []),
    ...(config.capabilities.includes('screenCapture') ? [JITPACK_REPOSITORY] : []),
    ...(config.android.extension ? config.android.extension.repositories : []),
  ]
  return all.filter((url, i) => all.indexOf(url) === i)
}

export function shellJson(config, env, signingFile) {
  return {
    schemaVersion: 1,
    applicationId: config.android.applicationId,
    appName: config.app.name,
    versionName: config.app.version,
    versionCode: config.android.versionCode,
    environment: env.name,
    capabilities: config.capabilities,
    signing: { propertiesFile: signingFile },
    push: pushGradle(config),
    // Kotlin：屏幕共享模板是 Kotlin；业务扩展模块总是开 Kotlin（Java 也能编）
    kotlin: config.capabilities.includes('screenCapture'),
    repositories: gradleRepositories(config),
    extension: extensionGradle(config),
  }
}

export function appShellConfigJava(config, env) {
  const nav = config.navigation
  const rootPages = nav.rootPages.map(page =>
    `        new RootPage(${javaString(page.path)}, new String[] { ${page.childQuery.map(javaString).join(', ')} }),`)
  const shortcuts = nav.shortcuts.map(item =>
    `        new Shortcut(${javaString(item.id)}, ${javaString(item.label)}, android.R.drawable.${item.icon}, ${javaString(item.path)}),`)
  return `package org.appshell;

// 由 appshell prebuild 生成，来源：appshell.config.json。不要手改。
public final class AppShellConfig {
    public static final String APPLICATION_ID = ${javaString(config.android.applicationId)};
    public static final String APP_NAME = ${javaString(config.app.name)};
    public static final String ENVIRONMENT = ${javaString(env.name)};
    public static final String STORAGE_DIR = ${javaString(config.android.storageDir)};
    public static final String NATIVE_BACK_EVENT = ${javaString(nav.nativeBackEvent)};
    public static final String[] PERMISSIONS = { ${config.permissions.map(javaString).join(', ')} };
    public static final String HOT_UPDATE_APPLY = ${javaString(config.android.hotUpdate?.apply ?? '')};
    public static final String HOT_UPDATE_LATEST_URL = ${javaString(config.android.hotUpdate?.latestUrl[env.name] ?? '')};
    public static final String[] SCREEN_CAPTURE_ALLOWED_HOSTS = { ${(config.screenCapture?.allowedHosts ?? []).map(javaString).join(', ')} };
    public static final String PUSH_CHANNEL_ID = ${javaString(config.push?.android.notificationChannel?.id ?? '')};
    public static final String PUSH_CHANNEL_NAME = ${javaString(config.push?.android.notificationChannel?.name ?? '')};

    public static final RootPage[] ROOT_PAGES = {
${rootPages.join('\n')}
    };

    public static final Shortcut[] SHORTCUTS = {
${shortcuts.join('\n')}
    };

    public static final class RootPage {
        public final String path;
        public final String[] childQuery;

        public RootPage(String path, String[] childQuery) {
            this.path = path;
            this.childQuery = childQuery;
        }
    }

    public static final class Shortcut {
        public final String id;
        public final String label;
        public final int icon;
        public final String path;

        public Shortcut(String id, String label, int icon, String path) {
            this.id = id;
            this.label = label;
            this.icon = icon;
            this.path = path;
        }
    }

    private AppShellConfig() {}
}
`
}

export function appShellPluginsJava(capabilities, extensionPlugins = []) {
  const register = []
  const before = []
  if (capabilities.includes('recording')) {
    register.push('        activity.registerPlugin(RecordingKeepAlivePlugin.class);')
    register.push('        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) activity.registerPlugin(SystemAudioPlugin.class);')
    register.push('        activity.registerPlugin(RecordingLocalFilePlugin.class);')
    register.push('        activity.registerPlugin(NativeRecorderPlugin.class);')
  }
  if (capabilities.includes('hotUpdate')) {
    before.push('        EmbeddedWebBundleState.resetAfterApkUpdate(activity);')
    before.push('        WebBundleUpdaterPlugin.prepareBeforeBridge(activity);')
    register.push('        activity.registerPlugin(WebBundleUpdaterPlugin.class);')
  }
  if (capabilities.includes('backgroundUpload')) {
    register.push('        activity.registerPlugin(BackgroundUploadPlugin.class);')
  }
  if (capabilities.includes('push')) {
    before.push('        PushPlugin.initIfConsented(activity);')
    register.push('        activity.registerPlugin(PushPlugin.class);')
  }
  if (capabilities.includes('screenCapture')) {
    register.push('        activity.registerPlugin(ScreenCapturePlugin.class);')
  }
  // 业务扩展（android.extension.plugins）：完整类名，编在 appshell-extension 模块里
  for (const name of extensionPlugins) register.push(`        activity.registerPlugin(${name}.class);`)
  if (capabilities.includes('wechat')) {
    register.push('        activity.registerPlugin(WechatAuthPlugin.class);')
    register.push('        activity.registerPlugin(WechatPayPlugin.class);')
    register.push('        activity.registerPlugin(WechatSharePlugin.class);')
  }
  return `package org.appshell;

import android.os.Build;

// 由 appshell prebuild 生成：只登记 appshell.config.json 启用的能力组。不要手改。
final class AppShellPlugins {
    private AppShellPlugins() {}

    /** bridge 创建之前的准备工作（例如覆盖安装后清理旧热更新包）。 */
    static void beforeBridge(MainActivity activity) {
${before.join('\n')}
    }

    static void register(MainActivity activity) {
${register.join('\n')}
    }
}
`
}

export function resourcesXml(config) {
  const s = config.strings
  const strings = [
    ['app_name', config.app.name],
    ['title_activity_main', config.app.name],
    ['package_name', config.android.applicationId],
    ['custom_url_scheme', config.android.applicationId],
    ['back_again_to_desktop', s.backAgainToDesktop],
  ]
  if (config.capabilities.includes('recording')) {
    strings.push(['recording_notification_channel', s.recordingNotificationChannel])
    strings.push(['recording_notification_title', s.recordingNotificationTitle])
    strings.push(['recording_notification_text', s.recordingNotificationText])
  }
  if (config.capabilities.includes('screenCapture')) {
    strings.push(['screen_capture_notification_channel', s.screenCaptureNotificationChannel])
    strings.push(['screen_capture_notification_title', s.screenCaptureNotificationTitle])
    strings.push(['screen_capture_notification_text', s.screenCaptureNotificationText])
    strings.push(['screen_capture_stop', s.screenCaptureStop])
  }
  if (config.capabilities.includes('wechat')) strings.push(['wechat_app_id', config.wechat.appId])
  const t = config.theme
  return {
    strings: `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 appshell prebuild 生成，来源：appshell.config.json。 -->
<resources>
${strings.map(([name, value]) => `    <string name="${name}">${xmlText(value)}</string>`).join('\n')}
</resources>
`,
    colors: `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 appshell prebuild 生成，来源：appshell.config.json theme。 -->
<resources>
    <color name="appshell_startup_background">${t.startupBackground}</color>
    <color name="appshell_startup_ink">${t.startupInk}</color>
    <color name="appshell_startup_active">${t.startupActive}</color>
    <!-- API 24-26 画不了深色导航栏图标，保留一个对比度安全的底色。 -->
    <color name="appshell_startup_navigation_bar">${t.legacyNavigationBar}</color>
</resources>
`,
  }
}

// 声明的权限 → Manifest 行。与能力组片段里已有的行去重（例如 recording 自带 RECORD_AUDIO）。
const PERMISSION_LINES = {
  microphone: ['<uses-permission android:name="android.permission.RECORD_AUDIO" />',
    '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />'],
  camera: ['<uses-permission android:name="android.permission.CAMERA" />',
    '<uses-feature android:name="android.hardware.camera" android:required="false" />'],
  notifications: ['<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />'],
  photos: [], // 写相册：29+ 不需要权限；≤28 的 WRITE_EXTERNAL_STORAGE 在核心 Manifest 里
  location: ['<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
    '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />'],
}

// 极光 SDK 自带的 Manifest 会合并进一批与推送无关的敏感权限，合规审查会直接挑出来。
// App 自己声明了定位时保留定位，其余一律剔除。
const PUSH_SDK_EXTRA_PERMISSIONS = [
  ['android.permission.ACCESS_COARSE_LOCATION', 'location'],
  ['android.permission.ACCESS_FINE_LOCATION', 'location'],
  ['android.permission.ACCESS_BACKGROUND_LOCATION', null],
  ['android.permission.READ_PHONE_STATE', null],
  ['android.permission.QUERY_ALL_PACKAGES', null],
  ['android.permission.ACCESS_WIFI_STATE', null],
  ['android.permission.READ_EXTERNAL_STORAGE', null],
]

export function pushPermissionRemovals(permissions) {
  const lines = PUSH_SDK_EXTRA_PERMISSIONS
    .filter(([, keepWhen]) => !keepWhen || !permissions.includes(keepWhen))
    .map(([name]) => `    <uses-permission android:name="${name}" tools:node="remove" />`)
  return ['    <!-- 剔除推送 SDK 带进来的与推送无关的敏感权限 -->', ...lines].join('\n')
}

/** 有 Android 实现的能力组（templates/android/capabilities 下有目录）；windows 等只在桌面的能力不进 Android 工程。 */
export function androidCapabilities(capabilities) {
  return capabilities.filter(name => fs.existsSync(path.join(TEMPLATE, 'capabilities', name, 'manifest.json')))
}

/** 能力组 → 模板目录：推送按 provider 选极光（push）或个推（push-getui）。 */
export function capabilityTemplates(config) {
  return androidCapabilities(config.capabilities)
    .map(name => (name === 'push' && config.push.android.provider === 'getui' ? 'push-getui' : name))
}

export function legacyActivityAliases(names) {
  if (!names.length) return ''
  return ['        <!-- 旧版本的入口名：升级后桌面图标 / 固定快捷方式仍能找到入口（不带 LAUNCHER，不会多出图标） -->',
    ...names.map(name => [
      '        <activity-alias',
      `            android:name="${name}"`,
      '            android:targetActivity=".MainActivity"',
      '            android:exported="true">',
      '            <intent-filter>',
      '                <action android:name="android.intent.action.MAIN" />',
      '            </intent-filter>',
      '        </activity-alias>',
    ].join('\n'))].join('\n')
}

export function assembleManifest(template, capabilities, permissions = [], legacyActivities = [], pushProvider = 'jpush') {
  let manifest = template
  for (const marker of ['queries', 'application', 'permissions']) {
    const parts = capabilities
      .map(name => JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'capabilities', name, 'manifest.json'), 'utf8'))[marker])
      .filter(Boolean)
    if (marker === 'permissions' && pushProvider === 'jpush' && capabilities.includes('push')) parts.push(pushPermissionRemovals(permissions))
    if (marker === 'application' && legacyActivities.length) parts.push(legacyActivityAliases(legacyActivities))
    if (marker === 'permissions') {
      const existing = manifest + parts.join('\n')
      const lines = permissions.flatMap(name => PERMISSION_LINES[name])
        .filter((line, i, all) => all.indexOf(line) === i && !existing.includes(line.replace(' />', '')))
      if (lines.length) parts.push(lines.map(line => `    ${line}`).join('\n'))
    }
    const line = new RegExp(`^[ ]*<!-- appshell:${marker} -->$`, 'm')
    if (!line.test(manifest)) fail(`模板 AndroidManifest 缺少标记 appshell:${marker}`)
    manifest = manifest.replace(line, () => parts.join('\n\n'))
  }
  return manifest
}

/**
 * 业务扩展：android.extension.dir 是一个 Android 库模块的源码（src/main/{java,kotlin,res,AndroidManifest.xml}、src/test），
 * 外壳生成它的 build.gradle（Capacitor、Kotlin、声明的依赖），App 依赖它；库的 Manifest 由 Gradle 自动合并。
 */
export function prepareExtensionModule(config, android) {
  const source = path.join(config.root, config.android.extension.dir)
  const main = path.join(source, 'src', 'main')
  if (!fs.existsSync(main)) fail(`android.extension.dir 下没有 src/main：${config.android.extension.dir}`)
  for (const entry of fs.readdirSync(source)) {
    if (entry !== 'src') fail(`android.extension.dir 只能包含 src/（build.gradle 由外壳生成），发现 ${entry}`)
  }
  const target = path.join(android, EXTENSION_MODULE)
  copyDir(source, target)
  fs.copyFileSync(path.join(TEMPLATE, 'extension.gradle'), path.join(target, 'build.gradle'))
  const manifest = path.join(target, 'src', 'main', 'AndroidManifest.xml')
  if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, '<?xml version="1.0" encoding="utf-8"?>\n<manifest />\n')
  fs.appendFileSync(path.join(android, 'settings.gradle'), `\ninclude ':${EXTENSION_MODULE}'\n`)
}

// File mode: android.signing.propertiesFile; Apollo mode: a private temp properties file built from
// the android credential. Either way Gradle only ever sees a properties-file path.
function signingPropertiesFile(config, type) {
  return operationContext().androidSigningProperties(config, type)
}

export function prebuildAndroid(config, env, { allowDirty, type }) {
  checkResources(path.join(config.root, config.android.resources), config.capabilities)
  const web = buildWeb(config, {
    platform: 'android', env, appId: config.android.applicationId, build: config.android.versionCode, allowDirty,
  })
  const work = workDir(config, 'android')
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })
  linkCapacitor(work)
  copyDir(web.dir, path.join(work, 'www'))
  fs.writeFileSync(path.join(work, 'capacitor.config.json'), JSON.stringify({
    appId: config.android.applicationId,
    appName: config.app.name,
    webDir: 'www',
    loggingBehavior: 'none',
    server: { androidScheme: 'https' },
    android: { allowMixedContent: false, minWebViewVersion: 111 },
    plugins: { CapacitorHttp: { enabled: config.android.nativeHttp } },
  }, null, 2) + '\n')

  const android = path.join(work, 'android')
  copyDir(path.join(TEMPLATE, 'project'), android)
  const app = path.join(android, 'app', 'src')
  for (const capability of capabilityTemplates(config)) {
    const source = path.join(TEMPLATE, 'capabilities', capability)
    for (const set of ['main', 'test', 'androidTest']) {
      if (fs.existsSync(path.join(source, set))) copyDir(path.join(source, set), path.join(app, set))
    }
  }
  const javaDir = path.join(app, 'main', 'java', PACKAGE_PATH)
  fs.writeFileSync(path.join(javaDir, 'AppShellConfig.java'), appShellConfigJava(config, env))
  const extension = config.android.extension
  fs.writeFileSync(path.join(javaDir, 'AppShellPlugins.java'), appShellPluginsJava(config.capabilities, extension ? extension.plugins : []))
  const manifestPath = path.join(app, 'main', 'AndroidManifest.xml')
  fs.writeFileSync(manifestPath, assembleManifest(fs.readFileSync(manifestPath, 'utf8'), capabilityTemplates(config),
    config.permissions, config.android.legacyActivities, config.push?.android.provider))
  if (extension) prepareExtensionModule(config, android)
  const res = path.join(app, 'main', 'res')
  const xml = resourcesXml(config)
  fs.writeFileSync(path.join(res, 'values', 'appshell_strings.xml'), xml.strings)
  fs.writeFileSync(path.join(res, 'values', 'appshell_colors.xml'), xml.colors)
  copyDir(path.join(config.root, config.android.resources), res)
  fs.writeFileSync(path.join(android, 'appshell.json'),
    JSON.stringify(shellJson(config, env, signingPropertiesFile(config, type)), null, 2) + '\n')
  const push = pushGradle(config)
  if (push?.huaweiServicesFile) {
    if (!fs.existsSync(push.huaweiServicesFile)) fail(`华为通道配置文件不存在：${push.huaweiServicesFile}`)
    fs.copyFileSync(push.huaweiServicesFile, path.join(android, 'app', 'agconnect-services.json'))
  }
  fs.chmodSync(path.join(android, 'gradlew'), 0o755)

  cap(work, ['sync', 'android'])
  const embedded = path.join(app, 'main', 'assets', 'public', MANIFEST_FILE)
  if (!fs.existsSync(embedded)) fail(`cap sync 之后 ${embedded} 不存在`)
  log(`Android 工程已生成：${android}（${config.android.applicationId} ${config.app.version} (${config.android.versionCode}) / ${env.name}）`)
  return { work, android, web }
}

export function buildAndroid(config, env, { type, allowDirty }) {
  if (!['debug', 'release'].includes(type)) fail('--type 只能是 debug 或 release')
  if (type === 'release' && allowDirty) fail('release 包不允许 --allow-dirty')
  const { android, web } = prebuildAndroid(config, env, { allowDirty, type })
  const task = type === 'release' ? 'assembleRelease' : 'assembleDebug'
  run(path.join(android, 'gradlew'), ['--no-daemon', task], { cwd: android })
  const built = path.join(android, 'app', 'build', 'outputs', 'apk', type, `app-${type}.apk`)
  if (!fs.existsSync(built)) fail(`Gradle 完成但没有找到 ${built}`)
  const target = path.join(outDir(config),
    artifactName(config, 'android', config.app.version, env.name, `-${type}.apk`))
  fs.copyFileSync(built, target)
  const sha = writeSha256(target)
  log(`APK：${target}\nSHA-256：${sha}`)
  return { file: target, sha256: sha, web }
}
