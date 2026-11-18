'use strict'
// 统一权限接口（桌面）：与 iOS / Android 同名同语义。只回答 appshell.config.json 声明过的权限。
// macOS / Windows 的麦克风、摄像头走系统隐私设置；其余能力桌面浏览器内核自己处理或不支持。

const { Notification, shell, systemPreferences } = require('electron')

const KNOWN = ['microphone', 'camera', 'notifications', 'photos', 'location']

function mediaState(type) {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return 'granted'
  const status = systemPreferences.getMediaAccessStatus(type)
  if (status === 'granted') return 'granted'
  if (status === 'not-determined') return 'prompt'
  if (status === 'restricted') return 'unsupported'
  return 'denied'
}

function state(name) {
  switch (name) {
    case 'microphone':
      return mediaState('microphone')
    case 'camera':
      return mediaState('camera')
    case 'notifications':
      // 桌面系统没有可查询的通知授权状态；首次发通知时由系统处理。
      return Notification.isSupported() ? 'granted' : 'unsupported'
    default:
      // photos（桌面保存走下载 / 保存对话框）与 location（需要第三方定位服务）不提供。
      return 'unsupported'
  }
}

async function request(name) {
  if ((name === 'microphone' || name === 'camera') && process.platform === 'darwin' && state(name) === 'prompt') {
    await systemPreferences.askForMediaAccess(name)
  }
  return state(name)
}

function parseNames(names, declared) {
  if (!Array.isArray(names) || names.length === 0) throw new Error('names must be a non-empty array of strings')
  const out = []
  for (const name of names) {
    if (!KNOWN.includes(name)) throw new Error(`unknown permission ${name}`)
    if (!declared.includes(name)) throw new Error(`${name} is not declared in appshell.config.json permissions`)
    if (!out.includes(name)) out.push(name)
  }
  return out
}

const SETTINGS = {
  darwin: {
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    notifications: 'x-apple.systempreferences:com.apple.preference.notifications',
  },
  win32: {
    microphone: 'ms-settings:privacy-microphone',
    camera: 'ms-settings:privacy-webcam',
    notifications: 'ms-settings:notifications',
  },
}

function registerPermissions({ guard, declared }) {
  guard.handle('appshell:permissions:check', async ({ names }) => {
    const result = {}
    for (const name of parseNames(names, declared)) result[name] = state(name)
    return result
  })
  guard.handle('appshell:permissions:request', async ({ names }) => {
    const result = {}
    for (const name of parseNames(names, declared)) result[name] = await request(name)
    return result
  })
  guard.handle('appshell:permissions:openSettings', async ({ name }) => {
    const target = SETTINGS[process.platform]?.[name] ?? SETTINGS[process.platform]?.microphone
    if (!target) throw new Error('system settings are unavailable on this platform')
    await shell.openExternal(target)
    return true
  })
}

module.exports = { registerPermissions, parseNames }
