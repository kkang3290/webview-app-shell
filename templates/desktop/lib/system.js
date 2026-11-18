'use strict'
// 系统集成（能力组 system，桌面部分）：托盘与菜单、主窗口控制、关闭拦截、退出确认、系统隐私设置。
// 菜单项文字、点了以后做什么都在网页：主进程只把 trayItem 事件转给主窗口。

const PRIVACY_PANES = {
  darwin: {
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    systemAudio: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture',
    notifications: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
  },
  win32: {
    microphone: 'ms-settings:privacy-microphone',
    screen: 'ms-settings:privacy-graphicscaptureprogrammatic',
    systemAudio: 'ms-settings:privacy-microphone',
    notifications: 'ms-settings:notifications',
  },
}

const ITEM_ID = /^[a-z][a-z0-9-]{0,31}$/

function normalizeTray(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('setTray 需要参数')
  if (typeof spec.visible !== 'boolean') throw new Error('visible 必须是布尔')
  const items = spec.items ?? []
  if (!Array.isArray(items) || items.length > 20) throw new Error('items 必须是数组（最多 20 项）')
  for (const item of items) {
    if (!ITEM_ID.test(item?.id ?? '')) throw new Error('菜单项 id 必须是小写字母开头、只含小写字母数字和 -')
    if (typeof item.label !== 'string' || !item.label || item.label.length > 40) throw new Error('菜单项 label 1~40 个字符')
  }
  if (spec.tooltip !== undefined && (typeof spec.tooltip !== 'string' || spec.tooltip.length > 64)) throw new Error('tooltip 最多 64 个字符')
  return { visible: spec.visible, tooltip: spec.tooltip ?? '', items: items.map(i => ({ id: i.id, label: i.label, enabled: i.enabled !== false })) }
}

/**
 * @param {{ electron: typeof import('electron'), appName: string, trayIcon: string,
 *   mainWindow: () => import('electron').BrowserWindow | null, send: (channel: string, payload: unknown) => void,
 *   isQuitting: () => boolean }} deps
 */
function createSystemShell(deps) {
  const { Tray, Menu, nativeImage, shell, app, dialog } = deps.electron
  void app
  let tray = null
  let interceptHide = false
  let quitReason = null

  function setTray(raw) {
    const spec = normalizeTray(raw)
    if (!spec.visible) {
      tray?.destroy()
      tray = null
      return
    }
    if (!tray) {
      const image = nativeImage.createFromPath(deps.trayIcon).resize({ width: 18, height: 18 })
      if (process.platform === 'darwin') image.setTemplateImage(false)
      tray = new Tray(image)
    }
    tray.setToolTip(spec.tooltip || deps.appName)
    tray.setContextMenu(Menu.buildFromTemplate([
      ...spec.items.map(item => ({ label: item.label, enabled: item.enabled, click: () => deps.send('appshell:system:trayItem', { id: item.id }) })),
      ...(spec.items.length ? [{ type: 'separator' }] : []),
      { label: `显示 ${deps.appName}`, click: () => mainWindow('show') },
      { label: '退出', click: () => app.quit() },
    ]))
  }

  function mainWindow(action) {
    const win = deps.mainWindow()
    if (!win) throw new Error('主窗口不存在')
    if (action === 'show') { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
    else if (action === 'hide') win.hide()
    else if (action === 'minimize') win.minimize()
    else if (action === 'restore') win.restore()
    else if (action === 'focus') win.focus()
    else throw new Error('action 只能是 show / hide / minimize / restore / focus')
  }

  /** 主窗口创建后调用：拦截关闭 / 最小化时先通知网页（例如录音中先弹出悬浮窗），再隐藏。 */
  function attach(win) {
    win.on('close', event => {
      if (!interceptHide || deps.isQuitting()) return
      event.preventDefault()
      deps.send('appshell:system:mainWindowWillHide', { reason: 'close' })
      win.hide()
    })
    win.on('minimize', () => {
      if (interceptHide) deps.send('appshell:system:mainWindowWillHide', { reason: 'minimize' })
    })
  }

  /** before-quit 时调用：网页设了 preventQuit 就先确认；返回 true 表示继续退出。 */
  function confirmQuit() {
    if (!quitReason) return true
    const choice = dialog.showMessageBoxSync(deps.mainWindow() ?? undefined, {
      type: 'warning',
      buttons: ['取消', '仍然退出'],
      defaultId: 0,
      cancelId: 0,
      message: quitReason,
    })
    if (choice === 1) deps.send('appshell:system:prepareQuit', {})
    return choice === 1
  }

  return {
    attach,
    confirmQuit,
    destroy() {
      tray?.destroy()
      tray = null
    },
    register(guard) {
      guard.handle('appshell:system:setTray', payload => setTray(payload))
      guard.handle('appshell:system:mainWindow', ({ action }) => mainWindow(action))
      guard.handle('appshell:system:setHideBehavior', ({ intercept }) => {
        interceptHide = Boolean(intercept)
      })
      guard.handle('appshell:system:preventQuit', ({ reason }) => {
        if (reason !== null && (typeof reason !== 'string' || !reason || reason.length > 80)) throw new Error('reason 是 1~80 个字符的说明，或 null')
        quitReason = reason
      })
      guard.handle('appshell:system:openPrivacySettings', async ({ pane }) => {
        const url = PRIVACY_PANES[process.platform]?.[pane]
        if (!url) throw new Error(`这个系统不支持打开 ${pane} 设置`)
        await shell.openExternal(url)
      })
    },
  }
}

module.exports = { createSystemShell, normalizeTray, PRIVACY_PANES }
