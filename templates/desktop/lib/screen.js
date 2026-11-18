'use strict'
// 屏幕共享（能力组 screenCapture，桌面部分）。与手机端同名插件 ScreenCapture，但桌面不由原生推流：
// 页面用 getDisplayMedia 自己采集（Electron 原生支持，桌面不会挂起页面），原生只负责
//   - 列出可共享的屏幕 / 窗口（带缩略图、应用图标），截一张快照；
//   - 页面先 select 选定来源，下一次 getDisplayMedia 就拿到这个来源（不弹 Chromium 的选择框）。
// 只放行本应用窗口发起的采集；没选来源的 getDisplayMedia 一律拒绝。

const SOURCE_ID = /^(screen|window):[0-9]+:[0-9]+$/
// 选定来源后多久内必须调 getDisplayMedia：防止很久以前的选择被之后的页面悄悄复用
const SELECTION_TTL_MS = 30_000

function intIn(value, min, max, fallback) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`参数必须是 ${min}~${max} 的整数`)
  return value
}

/** listSources 的参数：types 默认屏幕 + 窗口；thumbnail 宽度 0 表示不要缩略图（更快）。 */
function normalizeListOptions(options = {}) {
  const types = options.types ?? ['screen', 'window']
  if (!Array.isArray(types) || types.length === 0 || types.some(t => !['screen', 'window'].includes(t))) {
    throw new Error("types 只能包含 'screen' / 'window'")
  }
  const thumbnailWidth = intIn(options.thumbnailWidth, 0, 1920, 320)
  // 默认不列本应用自己的窗口：共享课堂窗口本身只会得到无限镜像
  return { types: [...new Set(types)], thumbnailWidth, icons: options.icons !== false, includeOwnWindows: options.includeOwnWindows === true }
}

function normalizeSnapshot(options = {}) {
  if (!SOURCE_ID.test(options.sourceId ?? '')) throw new Error('sourceId 无效（来自 listSources）')
  return { sourceId: options.sourceId, maxWidth: intIn(options.maxWidth, 64, 7680, 1920), quality: intIn(options.quality, 10, 100, 85) }
}

/**
 * @param {{ electron: typeof import('electron'), isTrusted: (contents: import('electron').WebContents) => boolean,
 *   windowIdOf: (contents: import('electron').WebContents) => string | null }} deps
 */
function createScreenCapture(deps) {
  const { desktopCapturer, session, systemPreferences, screen, webContents: WebContents, BrowserWindow } = deps.electron
  /** webContents.id → { sourceId, at }：每个窗口自己的一次性选择 */
  const selections = new Map()

  function permission() {
    if (process.platform !== 'darwin') return 'granted'
    // macOS：屏幕录制授权只能在系统设置里给；not-determined 时第一次采集会弹系统提示
    return systemPreferences.getMediaAccessStatus('screen')
  }

  async function listSources(raw) {
    const options = normalizeListOptions(raw)
    const size = options.thumbnailWidth === 0 ? { width: 0, height: 0 } : { width: options.thumbnailWidth, height: Math.round(options.thumbnailWidth * 9 / 16) }
    const sources = await desktopCapturer.getSources({ types: options.types, thumbnailSize: size, fetchWindowIcons: options.icons })
    const displays = new Map(screen.getAllDisplays().map(d => [String(d.id), d]))
    const own = options.includeOwnWindows ? new Set() : new Set(BrowserWindow.getAllWindows().map(w => w.getMediaSourceId()))
    return {
      sources: sources.filter(source => !own.has(source.id)).map(source => {
        const kind = source.id.startsWith('screen:') ? 'screen' : 'window'
        const display = kind === 'screen' ? displays.get(source.display_id) : null
        return {
          id: source.id,
          kind,
          name: source.name,
          ...(display ? { displayId: source.display_id, bounds: display.bounds, scaleFactor: display.scaleFactor, primary: display.id === screen.getPrimaryDisplay().id } : {}),
          ...(options.thumbnailWidth && !source.thumbnail.isEmpty() ? { thumbnail: source.thumbnail.toDataURL() } : {}),
          ...(options.icons && source.appIcon && !source.appIcon.isEmpty() ? { icon: source.appIcon.toDataURL() } : {}),
        }
      }),
    }
  }

  async function snapshot(raw) {
    const options = normalizeSnapshot(raw)
    const kind = options.sourceId.startsWith('screen:') ? 'screen' : 'window'
    const sources = await desktopCapturer.getSources({ types: [kind], thumbnailSize: { width: options.maxWidth, height: options.maxWidth }, fetchWindowIcons: false })
    const source = sources.find(s => s.id === options.sourceId)
    if (!source || source.thumbnail.isEmpty()) throw new Error('这个屏幕或窗口已经不在了')
    const jpeg = source.thumbnail.toJPEG(options.quality)
    const { width, height } = source.thumbnail.getSize()
    return { image: `data:image/jpeg;base64,${jpeg.toString('base64')}`, width, height }
  }

  function select(raw, contents) {
    if (raw?.sourceId === null) {
      selections.delete(contents.id)
      return
    }
    if (!SOURCE_ID.test(raw?.sourceId ?? '')) throw new Error('sourceId 无效（来自 listSources）')
    selections.set(contents.id, { sourceId: raw.sourceId, at: Date.now() })
  }

  /** getDisplayMedia 的处理：只给本应用窗口、且刚 select 过的来源。 */
  async function handleRequest(request, callback) {
    const contents = request.frame ? WebContents.fromFrame(request.frame) : null
    const selection = contents ? selections.get(contents.id) : null
    if (contents) selections.delete(contents.id)
    if (!contents || !deps.isTrusted(contents) || !selection || Date.now() - selection.at > SELECTION_TTL_MS) {
      callback({})
      return
    }
    try {
      const kind = selection.sourceId.startsWith('screen:') ? 'screen' : 'window'
      const sources = await desktopCapturer.getSources({ types: [kind], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
      const source = sources.find(s => s.id === selection.sourceId)
      // 只给画面：声音（系统声音）不在这个能力里
      callback(source ? { video: source } : {})
    } catch {
      callback({})
    }
  }

  return {
    register(guard) {
      session.defaultSession.setDisplayMediaRequestHandler((request, callback) => { void handleRequest(request, callback) })
      guard.handle('appshell:screen:capabilities', async () => ({
        platform: 'desktop', screens: true, windows: true, stream: [], replay: false, permission: permission(),
      }))
      guard.handle('appshell:screen:listSources', payload => listSources(payload))
      guard.handle('appshell:screen:snapshot', payload => snapshot(payload))
      guard.handle('appshell:screen:select', (payload, { sender }) => select(payload, sender))
    },
    forget(contents) {
      selections.delete(contents.id)
    },
  }
}

module.exports = { createScreenCapture, normalizeListOptions, normalizeSnapshot, SOURCE_ID, SELECTION_TTL_MS }
