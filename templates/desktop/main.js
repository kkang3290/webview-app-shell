'use strict'
// appshell 桌面端主进程（由 appshell prebuild desktop 生成工程，不要手改；改 appshell.config.json）。
// 装配顺序：配置 → 单实例与深链 → 本地站点 → 插件 → 主窗口。

const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron')
const { startLocalSite, NONCE_COOKIE } = require('./lib/site')
const { createRecorder } = require('./lib/recorder')
const { createUploader } = require('./lib/upload')
const { registerPermissions } = require('./lib/permissions')
const { startWebBundleUpdater } = require('./lib/webbundle')
const { createWindowManager } = require('./lib/windows')
const { createSystemShell } = require('./lib/system')
const { createScreenCapture } = require('./lib/screen')

const shellConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'appshell.json'), 'utf8'))
const WEB_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, 'web')

app.setName(shellConfig.appName)
if (shellConfig.debug) {
  // 只在 Debug 包里：自动化验证用的调试端口与假媒体设备（不需要系统麦克风授权）。
  if (process.env.APPSHELL_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.APPSHELL_DEBUG_PORT)
  // 测试时与同名的正式安装分开数据目录：不同 Electron 版本共用一份浏览器数据可能互相升级坏。
  if (process.env.APPSHELL_USER_DATA) app.setPath('userData', process.env.APPSHELL_USER_DATA)
  if (process.env.APPSHELL_FAKE_MEDIA === '1') {
    app.commandLine.appendSwitch('use-fake-device-for-media-stream')
    app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
  }
}

/**
 * 业务扩展（desktop.extension）：通用能力组覆盖不了的原生代码。模块导出（都可选）：
 *   beforeReady(base)            同步，app ready 之前（registerSchemesAsPrivileged、提前挂 open-url 等）
 *   ready(base)                  app ready 之后、本地站点启动之前（要在页面加载前清会话数据等）
 *   setup(context) → hooks       外壳插件注册完、主窗口创建之前；返回
 *     { windowOptions?(options) → options, mainWindowCreated?(window) }
 * 见 docs/desktop-extension.md。
 */
const extension = shellConfig.extension ? loadExtension() : null
let extensionHooks = null

function loadExtension() {
  const loaded = require('./extension/main.js')
  return loaded && loaded.default ? loaded.default : loaded
}

/** 给扩展的基础上下文；setup 时再补上站点地址与主窗口相关的方法。 */
const extensionBase = {
  electron: require('electron'),
  shellConfig,
  extensionDir: path.join(__dirname, 'extension'),
}

let mainWindow = null
let siteOrigin = null
/** 能力组 windows：辅助窗口管理器（没开这个能力组时为 null）。 */
let windowManager = null
/** 能力组 system：托盘 / 主窗口控制 / 退出确认（没开时为 null）。 */
let systemShell = null
let quitting = false
const pendingUrls = []

function isSameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

/** 发起调用的窗口：主窗口是 'main'，辅助窗口是它的 id；都不是返回 null。 */
function windowIdOf(contents) {
  if (mainWindow !== null && contents === mainWindow.webContents) return 'main'
  return windowManager ? windowManager.idOf(contents) : null
}

function isTrusted(contents) {
  return windowIdOf(contents) !== null && siteOrigin !== null && isSameOrigin(contents.getURL(), siteOrigin)
}

/**
 * 插件 IPC 只收本应用窗口（主窗口或已登记的辅助窗口）主框架、且页面仍在自己源上的调用：
 * 页面被导航到站外后同一个 webContents 不再可信。处理函数拿到 { windowId } 知道是谁调的。
 */
const guard = {
  handle(channel, handler) {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrusted(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('untrusted sender')
      return handler(payload ?? {}, { windowId: windowIdOf(event.sender), sender: event.sender })
    })
  },
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

// ─── 单实例与深链 ─────────────────────────────────────────────

function queueUrl(url) {
  if (!shellConfig.scheme || typeof url !== 'string' || !url.startsWith(`${shellConfig.scheme}:`)) return
  pendingUrls.push(url)
  send('appshell:app:url', { url })
}

if (!app.requestSingleInstanceLock()) {
  // 两个实例会各起一个本地源、各自的登录态互相打架；深链在 Windows 上也靠第二实例的 argv 送达。
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
    argv.forEach(queueUrl)
  })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    queueUrl(url)
  })
  extension?.beforeReady?.(extensionBase)
  void main().catch(error => {
    console.error(error)
    dialog.showErrorBox(shellConfig.appName, `启动失败：${error.message}`)
    app.quit()
  })
}

// ─── 菜单 ────────────────────────────────────────────────────

function installMenu() {
  const template = []
  if (process.platform === 'darwin') template.push({ role: 'appMenu' })
  // 编辑菜单不能省：macOS 上没有它，输入框里的复制粘贴快捷键整个失效。
  template.push({ role: 'editMenu' })
  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      ...(shellConfig.debug ? [{ role: 'toggleDevTools' }] : []),
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  })
  template.push({ role: 'windowMenu' })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ─── 媒体权限 ────────────────────────────────────────────────

function registerMediaPermissions() {
  const allowed = new Set(['media', 'clipboard-sanitized-write', 'notifications', 'fullscreen'])
  // 屏幕共享：getDisplayMedia 先过这一道权限，再到 lib/screen.js 的来源处理（那里只交出 select 过的来源）。
  // 不放行的话即使选好了来源也一律 NotAllowedError。
  if (shellConfig.capabilities.includes('screenCapture')) allowed.add('display-capture')
  session.defaultSession.setPermissionCheckHandler((contents, permission) =>
    allowed.has(permission) && contents !== null && isTrusted(contents))
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(allowed.has(permission) && isTrusted(contents))
  })
}

// ─── 主窗口 ──────────────────────────────────────────────────

function createWindow() {
  const w = shellConfig.window
  const defaults = {
    width: w.width,
    height: w.height,
    minWidth: w.minWidth,
    minHeight: w.minHeight,
    title: shellConfig.appName,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 窗口最小化 / 被遮挡时不节流定时器：录音、实时转写依赖页面持续运行。
      backgroundThrottling: false,
      devTools: shellConfig.debug,
      // 预加载在沙箱里读不了文件；启用了哪些能力组经 argv 告诉它，只挂对应插件。
      additionalArguments: [`--appshell-capabilities=${shellConfig.capabilities.join(',')}`, '--appshell-window-id=main'],
    },
  }
  // 扩展可以调整窗口外观、追加给预加载的启动参数；预加载脚本与隔离设置不交给它改
  const options = extensionHooks?.windowOptions ? extensionHooks.windowOptions(defaults) : defaults
  mainWindow = new BrowserWindow({
    ...options,
    webPreferences: {
      ...options.webPreferences,
      preload: defaults.webPreferences.preload, contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  })
  systemShell?.attach(mainWindow)
  mainWindow.once('ready-to-show', () => mainWindow.show())
  // 站外链接交给系统浏览器，主窗口只留在自己的源上。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && !isSameOrigin(url, siteOrigin)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isSameOrigin(url, siteOrigin)) return
    event.preventDefault()
    if (/^https?:/.test(url)) void shell.openExternal(url)
  })
  const created = mainWindow
  mainWindow.on('closed', () => {
    // 旧窗口的 closed 可能迟到于新窗口建好，只清自己
    if (mainWindow === created) mainWindow = null
  })
  extensionHooks?.mainWindowCreated?.(mainWindow)
  void mainWindow.loadURL(siteOrigin)
}

// ─── 装配 ────────────────────────────────────────────────────

async function main() {
  if (process.platform === 'win32') app.setAppUserModelId(shellConfig.appId)
  await app.whenReady()
  if (shellConfig.scheme) {
    if (process.defaultApp) app.setAsDefaultProtocolClient(shellConfig.scheme, process.execPath, [path.resolve(process.argv[1])])
    else app.setAsDefaultProtocolClient(shellConfig.scheme)
  }
  process.argv.forEach(queueUrl)
  installMenu()
  await extension?.ready?.(extensionBase)

  const userData = app.getPath('userData')
  let webBundles = null
  if (shellConfig.hotUpdate) {
    webBundles = await startWebBundleUpdater({
      bakedRoot: WEB_ROOT, userDataDir: userData, appId: shellConfig.appId, environment: shellConfig.environment,
      apiTarget: shellConfig.apiTarget, apiPath: shellConfig.apiPath, latestPath: shellConfig.hotUpdate.latestPath,
      apply: shellConfig.hotUpdate.apply,
    })
  }
  const site = await startLocalSite({
    webRoot: () => (webBundles ? webBundles.currentWebRoot() : WEB_ROOT),
    apiPath: shellConfig.apiPath, apiTarget: shellConfig.apiTarget, userDataDir: userData,
    webBundles: webBundles && { prefix: shellConfig.hotUpdate.endpointPrefix, applyMode: shellConfig.hotUpdate.apply, ...webBundles },
    // 外壳身份牌：真网页上这个路径会被 SPA fallback 接成 HTML，页面靠 content-type 认出自己在桌面外壳里
    desktopInfo: shellConfig.hotUpdate && {
      path: `${shellConfig.hotUpdate.endpointPrefix}/desktop-info`,
      body: {
        version: app.getVersion(), arch: process.arch, site_origin: shellConfig.publicOrigin,
        platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform,
      },
    },
  })
  siteOrigin = site.origin
  // 启动口令必须在开窗前写进 cookie：第一个请求就是 loadURL 的 GET /，没有口令会 403。
  // 不设过期时间 = 会话 cookie，不落盘；httpOnly，页面脚本读不到。
  await session.defaultSession.cookies.set({ url: site.origin, name: NONCE_COOKIE, value: site.nonce, httpOnly: true, sameSite: 'strict' })
  registerMediaPermissions()

  guard.handle('appshell:app:info', async () => ({
    appName: shellConfig.appName, appId: shellConfig.appId, version: app.getVersion(), environment: shellConfig.environment,
    platform: process.platform, arch: process.arch, capabilities: shellConfig.capabilities,
  }))
  guard.handle('appshell:app:takeUrls', async () => pendingUrls.splice(0))
  registerPermissions({ guard, declared: shellConfig.permissions })
  if (webBundles) {
    // 与 Android 的 WebBundleUpdater 同名；下载由主进程在后台完成，页面只查询、启用、确认。
    guard.handle('appshell:webbundle:info', async () => ({
      shellVersion: app.getVersion(), bundleVersion: webBundles.activeVersion(), bakedVersion: webBundles.bakedVersion(),
      apply: shellConfig.hotUpdate.apply,
    }))
    guard.handle('appshell:webbundle:pending', async () => ({ pending: webBundles.pending() }))
    guard.handle('appshell:webbundle:activate', async () => {
      const ok = await webBundles.apply()
      if (ok && mainWindow && !mainWindow.isDestroyed()) setImmediate(() => mainWindow.webContents.reload())
      return { ok }
    })
    guard.handle('appshell:webbundle:notifyReady', async () => {
      await webBundles.confirmReady()
    })
  }

  let recorder = null
  if (shellConfig.capabilities.includes('recording')) {
    recorder = createRecorder({ root: path.join(userData, 'appshell-recordings'), guard })
  }
  let uploader = null
  if (shellConfig.capabilities.includes('backgroundUpload')) {
    uploader = createUploader({
      root: path.join(userData, 'appshell-uploads'),
      allowedRoot: userData,
      debug: shellConfig.debug,
      guard,
      emit: (event, data) => send('appshell:upload:event', { event, data }),
    })
    await uploader.resume()
  }

  if (shellConfig.capabilities.includes('windows')) {
    windowManager = createWindowManager({
      electron: require('electron'), siteOrigin: () => siteOrigin, preload: path.join(__dirname, 'preload.js'),
      debug: shellConfig.debug, appName: shellConfig.appName, userDataDir: userData, isSameOrigin,
      capabilitiesArg: `--appshell-capabilities=${shellConfig.capabilities.join(',')}`, mainWindow: () => mainWindow,
    })
    windowManager.register(guard)
    // 应用失焦时告诉所有窗口（悬浮窗据此决定要不要主动弹出来）
    app.on('browser-window-blur', () => setImmediate(() => {
      if (!require('electron').BrowserWindow.getFocusedWindow()) windowManager.broadcast('appshell:windows:appDeactivated', {})
    }))
  }
  if (shellConfig.capabilities.includes('system')) {
    systemShell = createSystemShell({
      electron: require('electron'), appName: shellConfig.appName, trayIcon: path.join(__dirname, 'tray.png'),
      mainWindow: () => mainWindow, send, isQuitting: () => quitting,
    })
    systemShell.register(guard)
  }

  if (shellConfig.capabilities.includes('screenCapture')) {
    createScreenCapture({ electron: require('electron'), isTrusted }).register(guard)
  }

  if (extension?.setup) {
    extensionHooks = await extension.setup({
      ...extensionBase,
      siteOrigin,
      userDataDir: userData,
      mainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
      isTrusted,
      isSameOrigin: url => isSameOrigin(url, siteOrigin),
    }) ?? null
  }

  createWindow()
  app.on('activate', () => {
    if (mainWindow === null) createWindow()
    else mainWindow.show()
  })

  app.on('before-quit', event => {
    if (quitting) return
    // 网页声明了「现在退出会丢东西」（录音中、课堂中），先确认
    if (systemShell && !systemShell.confirmQuit()) {
      event.preventDefault()
      return
    }
    if (!recorder?.hasActive()) {
      quitting = true
      return
    }
    // 录音还没停：确认后再退，并把已落盘的部分标记为中断，留给下次恢复。
    event.preventDefault()
    const choice = dialog.showMessageBoxSync(mainWindow ?? undefined, {
      type: 'warning',
      buttons: ['继续录音', '停止并退出'],
      defaultId: 0,
      cancelId: 0,
      message: '正在录音',
      detail: '退出会中断录音。已录下的部分会保留，下次打开可以恢复。',
    })
    if (choice === 1) {
      quitting = true
      void recorder.abandon().finally(() => app.quit())
    }
  })
  app.on('will-quit', () => {
    windowManager?.closeAll()
    systemShell?.destroy()
    uploader?.stop()
    webBundles?.stop()
    site.server.close()
  })
  app.on('window-all-closed', () => {
    // macOS 关掉所有窗口不等于退出；后台上传在应用活着时继续。
    if (process.platform !== 'darwin') app.quit()
  })
}
