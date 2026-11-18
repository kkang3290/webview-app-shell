// iOS：Capacitor 官方 CocoaPods 模板（cap add ios）+ 外壳 Swift 源码 + 业务图标 → .appshell/ios。
import fs from 'node:fs'
import path from 'node:path'

import { buildWeb, MANIFEST_FILE } from './web.mjs'
import { operationContext } from './context.mjs'
import {
  TEMPLATES, fail, log, run, copyDir, linkCapacitor, cap, workDir, outDir, artifactName, writeSha256, xcodeprojRuby,
} from './util.mjs'

const TEMPLATE = path.join(TEMPLATES, 'ios')

const SOURCES = {
  core: ['ShellHostViewController.swift', 'ShellWebViewController.swift', 'ShellPageRefreshController.swift',
    'ShellBinaryUploadHTTP.swift', 'StatusBarThemePlugin.swift', 'ShellProbe.swift', 'PermissionsPlugin.swift',
    'AppDelegate.swift', 'AppShellLinks.swift'],
  backgroundUpload: ['BackgroundUploadPlugin.swift', 'BackgroundUploadManager.swift'],
  push: ['PushManager.swift', 'PushPlugin.swift'],
  recording: ['ShellMicrophonePlugin.swift', 'SimulatorMicrophonePlugin.swift', 'NativeRecorderPlugin.swift'],
  hotUpdate: ['WebBundleUpdaterPlugin.swift', 'WebBundleStore.swift', 'ShellZip.swift'],
  screenCapture: ['ScreenCapturePlugin.swift', 'ScreenLease.swift', 'ScreenReplay.swift', 'AppShellScreenConfig.swift'],
}
// 广播上传扩展（screenCapture）的源码：扩展专有的 + 与 App 共用的租约 / 回放 + 生成的配置
const BROADCAST_SOURCES = ['SampleHandler.swift', 'ReplayVideoFrame.swift']
const BROADCAST_SHARED = ['ScreenLease.swift', 'ScreenReplay.swift']
// 广播扩展推 RTMP 用 HaishinKit；版本固定
export const HAISHINKIT = { url: 'https://github.com/HaishinKit/HaishinKit.swift.git', version: '2.2.5', products: ['HaishinKit', 'RTMPHaishinKit'] }

/** 广播扩展的标识：扩展 Bundle ID 与 App Group 都由主 App 的 Bundle ID 推出，不单独配置。 */
export function broadcastIdentity(config) {
  return { bundleId: `${config.ios.bundleId}.broadcast`, appGroup: `group.${config.ios.bundleId}` }
}

export function appShellScreenConfigSwift(config) {
  const id = broadcastIdentity(config)
  return `// 由 appshell prebuild 生成，来源：appshell.config.json screenCapture。主 App 与广播扩展共用。不要手改。
enum AppShellScreenConfig {
    static let appGroup = ${JSON.stringify(id.appGroup)}
    static let extensionBundleId = ${JSON.stringify(id.bundleId)}
    static let allowedHosts: [String] = [${config.screenCapture.allowedHosts.map(h => JSON.stringify(h)).join(', ')}]
    static let stoppedMessage = ${JSON.stringify(`屏幕共享已停止，请回到 ${config.app.name} 重新开始`)}
    static let startInAppMessage = ${JSON.stringify(`请先在 ${config.app.name} 里发起屏幕共享`)}
}
`
}
const RESOURCES = { recording: ['SimulatorMicrophone.js'] }
// 只有 Android 实现的能力组：iOS 上 Web 侧必须按插件是否存在做降级。
const IOS_UNSUPPORTED = ['wechat']

const PERMISSION_SOURCES = {
  microphone: 'MicrophonePermission.swift',
  camera: 'CameraPermission.swift',
  notifications: 'NotificationsPermission.swift',
  photos: 'PhotosPermission.swift',
  location: 'LocationPermission.swift',
}

export function iosLayout(capabilities, permissions = [], extensionSources = []) {
  const groups = ['core', ...capabilities.filter(name => SOURCES[name])]
  return {
    groups,
    permissionSources: permissions.map(name => PERMISSION_SOURCES[name]),
    sources: [...groups.flatMap(name => SOURCES[name]), ...permissions.map(name => PERMISSION_SOURCES[name]),
      'AppShellConfig.swift', 'AppShellPlugins.swift', 'AppShellPermissions.swift', ...extensionSources],
    resources: groups.flatMap(name => RESOURCES[name] ?? []),
    unsupported: capabilities.filter(name => IOS_UNSUPPORTED.includes(name)),
  }
}

export function appShellConfigSwift(config, env) {
  const refresh = config.ios.pullToRefresh
  const hot = config.capabilities.includes('hotUpdate') ? config.ios.hotUpdate : null
  return `// 由 appshell prebuild 生成，来源：appshell.config.json。不要手改。
enum AppShellConfig {
    static let appName = ${JSON.stringify(config.app.name)}
    static let environment = ${JSON.stringify(env.name)}
    static let pullToRefresh = ${refresh.enabled}
    static let refreshBlockSelector: String? = ${refresh.blockSelector === null ? 'nil' : JSON.stringify(refresh.blockSelector)}
    static let apnsEnvironment = ${JSON.stringify(config.push?.ios.environment ?? '')}
    // 热更新（没开 hotUpdate 能力组时为空，相关代码也不进工程）
    static let hotUpdateApply = ${JSON.stringify(hot ? hot.apply : '')}
    static let hotUpdateLatestURL = ${JSON.stringify(hot ? hot.latestUrl[env.name] : '')}
    static let hotUpdateBundleAppId = ${JSON.stringify(hot ? hot.bundleAppId : '')}
}
`
}

const PERMISSION_TYPES = {
  microphone: 'MicrophonePermission', camera: 'CameraPermission', notifications: 'NotificationsPermission',
  photos: 'PhotosPermission', location: 'LocationPermission',
}

export function appShellPermissionsSwift(permissions) {
  return `// 由 appshell prebuild 生成：appshell.config.json 声明的权限。不要手改。
enum AppShellPermissions {
    static let all: [ShellPermission] = [${permissions.map(name => `${PERMISSION_TYPES[name]}()`).join(', ')}]
}
`
}

export function appShellPluginsSwift(capabilities, extensionPlugins = []) {
  const lines = []
  const launch = []
  const background = []
  const registered = []
  let webRoot = '        return nil'
  const registerFailed = []
  if (capabilities.includes('backgroundUpload')) {
    lines.push('        bridge.registerPluginInstance(BackgroundUploadPlugin())')
    launch.push('        BackgroundUploadManager.shared.reconnect()')
    background.push('        if BackgroundUploadManager.shared.handleEvents(identifier, completion) { return true }')
  }
  if (capabilities.includes('push')) {
    lines.push('        bridge.registerPluginInstance(PushPlugin())')
    launch.push('        PushManager.shared.didFinishLaunching(application)')
    registered.push('        PushManager.shared.didRegister(token)')
    registerFailed.push('        PushManager.shared.didFailToRegister(error)')
  }
  if (capabilities.includes('hotUpdate')) {
    lines.push('        bridge.registerPluginInstance(WebBundleUpdaterPlugin())')
    webRoot = '        return WebBundleStore.prepareBeforeBridge()'
  }
  if (capabilities.includes('screenCapture')) {
    lines.push('        bridge.registerPluginInstance(ScreenCapturePlugin())')
  }
  if (capabilities.includes('recording')) {
    lines.push('        bridge.registerPluginInstance(ShellMicrophonePlugin())')
    lines.push('        bridge.registerPluginInstance(NativeRecorderPlugin())')
    lines.push(`        #if DEBUG && targetEnvironment(simulator)
            // 模拟器的 WKWebView 只给测试音源；Debug 模拟器改走 AVAudioEngine 读真实系统麦克风。
            bridge.registerPluginInstance(SimulatorMicrophonePlugin())
            if let file = Bundle.main.url(forResource: "SimulatorMicrophone", withExtension: "js"),
               let script = try? String(contentsOf: file, encoding: .utf8)
            {
                bridge.webView?.configuration.userContentController.addUserScript(
                    WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
                )
            }
        #endif`)
  }
  // 业务扩展（ios.extension.plugins）：通用能力组覆盖不了的业务插件
  for (const name of extensionPlugins) lines.push(`        bridge.registerPluginInstance(${name}())`)
  return `import Capacitor
import UIKit
import WebKit

// 由 appshell prebuild 生成：只登记 appshell.config.json 启用且 iOS 已实现的能力组。不要手改。
enum AppShellPlugins {
    static func register(on bridge: CAPBridgeProtocol) {
${lines.join('\n') || '        _ = bridge'}
    }
}

/// AppDelegate 的系统回调分发给启用的能力组。
enum AppShellHooks {
    /// 这次冷启动的网页目录；nil = 安装包内置的产物。
    static func webRoot() -> URL? {
${webRoot}
    }

    static func didFinishLaunching(_ application: UIApplication) {
${launch.join('\n') || '        _ = application'}
    }

    static func handleBackgroundSession(_ identifier: String, _ completion: @escaping () -> Void) -> Bool {
${background.join('\n')}
        return false
    }

    static func didRegisterForRemoteNotifications(_ token: Data) {
${registered.join('\n') || '        _ = token'}
    }

    static func didFailToRegisterForRemoteNotifications(_ error: Error) {
${registerFailed.join('\n') || '        _ = error'}
    }
}
`
}

function checkResources(dir) {
  const icon = path.join(dir, 'AppIcon.appiconset', 'Contents.json')
  if (!fs.existsSync(icon)) fail(`ios.resources 缺少 AppIcon.appiconset/Contents.json：${dir}`)
  for (const entry of fs.readdirSync(dir)) {
    if (!['AppIcon.appiconset', 'Splash.imageset'].includes(entry)) {
      fail(`ios.resources 只支持 AppIcon.appiconset 与 Splash.imageset，发现 ${entry}`)
    }
  }
}

export function prebuildIos(config, env, { allowDirty }) {
  const resources = path.join(config.root, config.ios.resources)
  checkResources(resources)
  const extension = config.ios.extension
  const extensionDir = extension && path.join(config.root, extension.dir)
  if (extension && !fs.existsSync(extensionDir)) fail(`ios.extension.dir 不存在：${extension.dir}`)
  const extensionSources = extension ? fs.readdirSync(extensionDir).filter(name => name.endsWith('.swift')).sort() : []
  for (const item of extension ? [...extension.resources, ...extension.packages.map(p => p.dir)] : []) {
    if (!fs.existsSync(path.join(extensionDir, item))) fail(`ios.extension 里声明的 ${item} 在 ${extension.dir} 下不存在`)
  }
  if (extension && extensionSources.length === 0) fail(`ios.extension.dir 里没有 .swift 源码：${extension.dir}`)
  const layout = iosLayout(config.capabilities, config.permissions, extensionSources)
  const clash = extensionSources.find(name => layout.sources.indexOf(name) !== layout.sources.lastIndexOf(name))
  if (clash) fail(`ios.extension 的 ${clash} 与外壳源码同名`)
  if (layout.unsupported.length) {
    log(`iOS 尚未实现能力组 ${layout.unsupported.join(', ')}，生成的包里不包含；Web 端须按插件存在与否降级`)
  }
  const web = buildWeb(config, { platform: 'ios', env, appId: config.ios.bundleId, build: config.ios.buildNumber, allowDirty })
  const work = workDir(config, 'ios')
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })
  linkCapacitor(work)
  copyDir(web.dir, path.join(work, 'www'))
  fs.writeFileSync(path.join(work, 'capacitor.config.json'), JSON.stringify({
    appId: config.ios.bundleId,
    appName: config.app.name,
    webDir: 'www',
    loggingBehavior: 'none',
    server: { hostname: 'localhost', iosScheme: 'capacitor' },
    ios: { contentInset: 'never', preferredContentMode: 'mobile', webContentsDebuggingEnabled: env.name !== 'prod' },
    plugins: { CapacitorHttp: { enabled: config.ios.nativeHttp } },
  }, null, 2) + '\n')

  cap(work, ['add', 'ios', '--packagemanager', 'CocoaPods'])
  const appDir = path.join(work, 'ios', 'App', 'App')
  for (const group of layout.groups) copyDir(path.join(TEMPLATE, 'swift', group), appDir)
  for (const file of layout.permissionSources) {
    fs.copyFileSync(path.join(TEMPLATE, 'swift', 'permissions', file), path.join(appDir, file))
  }
  fs.writeFileSync(path.join(appDir, 'AppShellPermissions.swift'), appShellPermissionsSwift(config.permissions))
  fs.writeFileSync(path.join(appDir, 'AppShellConfig.swift'), appShellConfigSwift(config, env))
  const screenCapture = config.capabilities.includes('screenCapture')
  if (screenCapture) {
    // 主 App 与广播扩展共用一份生成的配置与租约 / 回放源码；扩展目录与 App 目录平级（ios/App/Broadcast）
    const screenConfig = appShellScreenConfigSwift(config)
    fs.writeFileSync(path.join(appDir, 'AppShellScreenConfig.swift'), screenConfig)
    const broadcastDir = path.join(work, 'ios', 'App', 'Broadcast')
    fs.mkdirSync(broadcastDir, { recursive: true })
    for (const name of BROADCAST_SOURCES) fs.copyFileSync(path.join(TEMPLATE, 'broadcast', name), path.join(broadcastDir, name))
    for (const name of BROADCAST_SHARED) fs.copyFileSync(path.join(TEMPLATE, 'swift', 'screenCapture', name), path.join(broadcastDir, name))
    fs.writeFileSync(path.join(broadcastDir, 'AppShellScreenConfig.swift'), screenConfig)
    fs.copyFileSync(path.join(TEMPLATE, 'broadcast', 'Info.plist'), path.join(broadcastDir, 'Info.plist'))
  }
  for (const name of extensionSources) fs.copyFileSync(path.join(extensionDir, name), path.join(appDir, name))
  if (extension) {
    // 资源放进 App 目录；整个扩展目录另拷一份到 ios/extension（Swift Package、构建脚本从那里取，见 APPSHELL_EXTENSION_DIR）
    for (const name of extension.resources) copyDir(path.join(extensionDir, name), path.join(appDir, name))
    copyDir(extensionDir, path.join(work, 'ios', 'extension'))
  }
  fs.writeFileSync(path.join(appDir, 'AppShellPlugins.swift'), appShellPluginsSwift(config.capabilities, extension ? extension.plugins : []))
  for (const entry of fs.readdirSync(resources)) {
    const target = path.join(appDir, 'Assets.xcassets', entry)
    fs.rmSync(target, { recursive: true, force: true })
    copyDir(path.join(resources, entry), target)
  }
  const shell = {
    schemaVersion: 1,
    applicationId: config.ios.bundleId,
    appName: config.app.name,
    versionName: config.ios.version,
    versionCode: config.ios.buildNumber,
    environment: env.name,
    capabilities: config.capabilities,
    ios: {
      sources: layout.sources,
      resources: layout.resources,
      deploymentTarget: config.ios.deploymentTarget,
      deviceFamily: config.ios.deviceFamily,
      backgroundModes: [
        ...(config.capabilities.includes('recording') && config.ios.backgroundRecording ? ['audio'] : []),
        ...(config.capabilities.includes('push') ? ['remote-notification'] : []),
      ],
      apsEnvironment: config.capabilities.includes('push') ? config.push.ios.environment : null,
      teamId: config.ios.teamId,
      systemCapabilities: extension ? extension.systemCapabilities : [],
      extension: extension ? {
        resources: extension.resources, packages: extension.packages, infoPlist: extension.infoPlist,
        entitlements: extension.entitlements, linkerFlags: extension.linkerFlags, buildScripts: extension.buildScripts,
      } : null,
      usageDescriptions: config.ios.usageDescriptions,
      // 广播上传扩展：独立 target，经 App Group 与主 App 交换租约与回放分段
      broadcast: screenCapture ? {
        ...broadcastIdentity(config),
        name: config.screenCapture.broadcastName,
        sources: [...BROADCAST_SOURCES, ...BROADCAST_SHARED, 'AppShellScreenConfig.swift'],
        package: HAISHINKIT,
      } : null,
    },
  }
  const shellFile = path.join(work, 'ios', 'appshell.json')
  fs.writeFileSync(shellFile, JSON.stringify(shell, null, 2) + '\n')
  const ruby = xcodeprojRuby()
  run(ruby.command, [path.join(TEMPLATE, 'configure.rb'), path.join(work, 'ios'), shellFile], { env: ruby.env })
  cap(work, ['sync', 'ios'])
  // 再配置一遍：pod install 会追加自己的构建阶段，业务扩展的构建脚本要排到它们之后（脚本本身幂等）
  if (extension && extension.buildScripts.length) run(ruby.command, [path.join(TEMPLATE, 'configure.rb'), path.join(work, 'ios'), shellFile], { env: ruby.env })
  const embedded = path.join(appDir, 'public', MANIFEST_FILE)
  if (!fs.existsSync(embedded)) fail(`cap sync 之后 ${embedded} 不存在`)
  log(`iOS 工程已生成：${path.join(work, 'ios')}（${config.ios.bundleId} ${config.ios.version} (${config.ios.buildNumber}) / ${env.name}）`)
  return { work, ios: path.join(work, 'ios'), web }
}

/**
 * App Store Connect API 密钥（只从环境变量来，三个要么都给要么都不给）：
 *   APPSHELL_ASC_KEY_PATH   .p8 文件路径
 *   APPSHELL_ASC_KEY_ID     密钥 ID
 *   APPSHELL_ASC_ISSUER_ID  Issuer ID
 * 给了：xcodebuild 用它自动管理证书与描述文件（打包机不用登录 Xcode 账号），上传 TestFlight 也用它。
 * 没给：签名用本机 Xcode 已登录的账号；上传 TestFlight 会报错。
 */
export function ascKeyFromEnv(env = process.env) {
  const key = { path: env.APPSHELL_ASC_KEY_PATH, id: env.APPSHELL_ASC_KEY_ID, issuer: env.APPSHELL_ASC_ISSUER_ID }
  const given = Object.values(key).filter(Boolean).length
  if (given === 0) return null
  if (given !== 3) fail('APPSHELL_ASC_KEY_PATH / APPSHELL_ASC_KEY_ID / APPSHELL_ASC_ISSUER_ID 要么都给，要么都不给')
  if (!fs.existsSync(key.path)) fail(`APPSHELL_ASC_KEY_PATH 指向的文件不存在：${key.path}`)
  return { ...key, path: path.resolve(key.path) }
}

function xcodeAuthArgs(key) {
  return key ? ['-authenticationKeyPath', key.path, '-authenticationKeyID', key.id, '-authenticationKeyIssuerID', key.issuer] : []
}

/** 把 release IPA 传到 App Store Connect（TestFlight）。处理完成后在 TestFlight 里对内部测试员可见。 */
export function uploadTestFlight(ipa, key = ascKeyFromEnv()) {
  if (!key) fail('上传 TestFlight 需要 App Store Connect API 密钥：设置 APPSHELL_ASC_KEY_PATH / APPSHELL_ASC_KEY_ID / APPSHELL_ASC_ISSUER_ID')
  run('xcrun', ['altool', '--upload-package', ipa, '--type', 'ios',
    '--api-key', key.id, '--api-issuer', key.issuer, '--p8-file-path', key.path], {})
  log(`已上传到 App Store Connect：${path.basename(ipa)}（处理完成后出现在 TestFlight）`)
}

export function buildIos(config, env, { type, allowDirty, simulator }) {
  if (!['debug', 'release'].includes(type)) fail('--type 只能是 debug 或 release')
  if (type === 'release' && allowDirty) fail('release 包不允许 --allow-dirty')
  const { ios, web } = prebuildIos(config, env, { allowDirty })
  const workspace = path.join(ios, 'App', 'App.xcworkspace')
  const derived = path.join(ios, 'build', 'derived')
  if (simulator) {
    if (type !== 'debug') fail('模拟器包只出 debug')
    run('xcodebuild', ['build', '-workspace', workspace, '-scheme', 'App', '-configuration', 'Debug',
      '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', derived,
      // 模拟器包也要本机临时签名：不签名就没有 application-identifier，系统的后台传输服务、
      // 推送等守护进程会拒绝这个 App（后台 URLSession 报 remote session is unavailable）。
      'CODE_SIGN_IDENTITY=-', 'CODE_SIGN_STYLE=Manual', 'DEVELOPMENT_TEAM=', 'PROVISIONING_PROFILE_SPECIFIER='], { cwd: ios })
    const app = path.join(derived, 'Build', 'Products', 'Debug-iphonesimulator', 'App.app')
    const target = path.join(outDir(config), artifactName(config, 'ios-simulator', config.ios.version, env.name, '.app.zip'))
    fs.rmSync(target, { force: true })
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, target])
    const sha = writeSha256(target)
    log(`模拟器包：${target}\n安装：xcrun simctl install booted ${app}`)
    return { file: target, app, sha256: sha, web }
  }
  if (!config.ios.teamId) fail('真机包需要 ios.teamId')
  const auth = xcodeAuthArgs(operationContext().ascKey())
  const archive = path.join(ios, 'build', 'App.xcarchive')
  run('xcodebuild', ['archive', '-workspace', workspace, '-scheme', 'App',
    '-configuration', type === 'release' ? 'Release' : 'Debug', '-destination', 'generic/platform=iOS',
    '-archivePath', archive, '-derivedDataPath', derived, '-allowProvisioningUpdates', ...auth], { cwd: ios })
  const exportOptions = path.join(ios, 'build', 'ExportOptions.plist')
  fs.writeFileSync(exportOptions, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>${type === 'release' ? 'app-store-connect' : 'debugging'}</string>
  <key>teamID</key><string>${config.ios.teamId}</string>
  <key>signingStyle</key><string>automatic</string>
</dict></plist>
`)
  const exported = path.join(ios, 'build', 'export')
  run('xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportOptionsPlist', exportOptions,
    '-exportPath', exported, '-allowProvisioningUpdates', ...auth], { cwd: ios })
  const ipa = fs.readdirSync(exported).find(name => name.endsWith('.ipa'))
  if (!ipa) fail(`导出完成但 ${exported} 里没有 ipa`)
  const target = path.join(outDir(config), artifactName(config, 'ios', config.ios.version, env.name, `-${type}.ipa`))
  fs.copyFileSync(path.join(exported, ipa), target)
  const sha = writeSha256(target)
  log(`IPA：${target}\nSHA-256：${sha}`)
  return { file: target, sha256: sha, web }
}
