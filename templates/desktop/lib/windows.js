'use strict'
// 多窗口（能力组 windows）：辅助窗口加载**本站点**的某个路由，同一个本地同源站点、同一个登录态。
// 窗口里放什么由网页决定（悬浮窗、辅助窗、聊天窗、批注浮层）。
//
// 安全：route 只能是本站点路径；辅助窗口与主窗口同样沙箱、同样只留在本源；overlay 只能由主窗口打开；
// 窗口之间的消息经主进程转发，收件方只能是已登记的窗口。

const fs = require('node:fs')
const path = require('node:path')

const KINDS = ['floating', 'panel', 'overlay']
const ANCHORS = ['bottom-right', 'top-right', 'center']
const ID = /^[a-z][a-z0-9-]{0,31}$/

/** 本站点路径：以单个 / 开头，不含协议、反斜杠、换行，不能是 //host 这种协议相对地址。 */
function validRoute(route) {
  return typeof route === 'string' && /^\/(?!\/)[^\s\\]*$/.test(route) && !/^\/[^/]*:/.test(route)
}

/** 按锚点把窗口放进工作区（避开 Dock / 任务栏），边距 16。 */
function placeBounds({ width, height, x, y, anchor }, workArea) {
  const w = Math.min(width, workArea.width)
  const h = Math.min(height, workArea.height)
  if (Number.isFinite(x) && Number.isFinite(y)) return { x: Math.round(x), y: Math.round(y), width: w, height: h }
  const margin = 16
  if (anchor === 'top-right') return { x: workArea.x + workArea.width - w - margin, y: workArea.y + margin, width: w, height: h }
  if (anchor === 'center') return { x: Math.round(workArea.x + (workArea.width - w) / 2), y: Math.round(workArea.y + (workArea.height - h) / 2), width: w, height: h }
  return { x: workArea.x + workArea.width - w - margin, y: workArea.y + workArea.height - h - margin, width: w, height: h }
}

/** 把窗口夹进工作区（尺寸已由 placeBounds 收缩过）：位置越界就贴边。 */
function clampToArea(bounds, area) {
  return {
    ...bounds,
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height),
  }
}

/** 校验 open 的参数，返回规范化后的 spec；不合法直接抛错（网页看到的就是 reject）。 */
function normalizeSpec(spec, { fromMain }) {
  if (!spec || typeof spec !== 'object') throw new Error('Windows.open 需要参数')
  if (!ID.test(spec.id ?? '') || spec.id === 'main') throw new Error('id 必须是小写字母开头、只含小写字母数字和 -（不能是 main）')
  if (!validRoute(spec.route)) throw new Error('route 必须是本站点路径，如 /float/transcript')
  if (!KINDS.includes(spec.kind)) throw new Error(`kind 只能是 ${KINDS.join(' / ')}`)
  if (spec.kind === 'overlay' && !fromMain) throw new Error('overlay 只能由主窗口或普通窗口（panel）打开')
  const bounds = spec.bounds ?? {}
  if (spec.kind !== 'overlay') {
    for (const key of ['width', 'height']) {
      // 下限 32：浮动工具条收起后只有一个按钮宽（标注工具条 36×64）
      if (!Number.isInteger(bounds[key]) || bounds[key] < 32 || bounds[key] > 4000) throw new Error(`bounds.${key} 必须是 32~4000 的整数`)
    }
  }
  if (bounds.anchor !== undefined && !ANCHORS.includes(bounds.anchor)) throw new Error(`bounds.anchor 只能是 ${ANCHORS.join(' / ')}`)
  if (spec.displayId !== undefined && !/^[0-9]{1,20}$/.test(String(spec.displayId))) throw new Error('displayId 无效（来自 ScreenCapture.listSources 的 displayId）')
  return {
    id: spec.id,
    route: spec.route,
    kind: spec.kind,
    bounds,
    alwaysOnTop: spec.kind === 'overlay' ? true : Boolean(spec.alwaysOnTop),
    rememberBounds: Boolean(spec.rememberBounds),
    // 屏幕共享时不被采集（标注层、标注工具条）：Windows 用 WDA_EXCLUDEFROMCAPTURE；macOS 上本应用窗口本来就不进屏幕采集
    excludeFromCapture: Boolean(spec.excludeFromCapture),
    // 不抢焦点的窗口（全屏标注层默认不可聚焦，需要键盘输入时再 setFocusable）
    focusable: spec.focusable !== false,
    // 放到哪块显示器（默认鼠标所在的那块）；overlay 铺满它
    displayId: spec.displayId === undefined ? null : String(spec.displayId),
    // 透明背景（浮动工具条这类只显示圆角内容的窗口）；overlay 总是透明
    transparent: spec.kind === 'overlay' || (spec.kind === 'floating' && Boolean(spec.transparent)),
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * @param {{ electron: typeof import('electron'), siteOrigin: () => string, preload: string, debug: boolean,
 *   capabilitiesArg: string, userDataDir: string, isSameOrigin: (url: string, origin: string) => boolean,
 *   mainWindow: () => import('electron').BrowserWindow | null }} deps
 */
function createWindowManager(deps) {
  const { BrowserWindow, screen, shell } = deps.electron
  const windows = new Map() // id → BrowserWindow
  const kinds = new Map() // id → kind：只有主窗口与 panel 能开 overlay（浮窗、标注层不能再铺一层）
  const boundsFile = path.join(deps.userDataDir, 'appshell-window-bounds.json')
  let saved = readJson(boundsFile)

  const contentsOf = id => (id === 'main' ? deps.mainWindow()?.webContents : windows.get(id)?.webContents)

  const emitTo = (id, channel, payload) => {
    const contents = contentsOf(id)
    if (contents && !contents.isDestroyed()) contents.send(channel, payload)
  }
  const broadcast = (channel, payload) => {
    emitTo('main', channel, payload)
    for (const id of windows.keys()) emitTo(id, channel, payload)
  }

  function idOf(contents) {
    if (deps.mainWindow() && contents === deps.mainWindow().webContents) return 'main'
    for (const [id, win] of windows) if (!win.isDestroyed() && win.webContents === contents) return id
    return null
  }

  function persist(id, win) {
    saved = { ...saved, [id]: win.getBounds() }
    try {
      fs.writeFileSync(boundsFile, JSON.stringify(saved))
    } catch {
      // 记不住位置不影响使用
    }
  }

  function open(raw, { from }) {
    const spec = normalizeSpec(raw, { fromMain: from === 'main' || kinds.get(from) === 'panel' })
    const existing = windows.get(spec.id)
    if (existing && !existing.isDestroyed()) {
      // 已经开着：换路由就导航过去，然后带到前面
      const url = new URL(spec.route, deps.siteOrigin()).toString()
      if (existing.webContents.getURL() !== url) void existing.loadURL(url)
      existing.showInactive()
      return { id: spec.id }
    }
    const display = (spec.displayId && screen.getAllDisplays().find(d => String(d.id) === spec.displayId))
      || screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const overlay = spec.kind === 'overlay'
    const remembered = spec.rememberBounds ? saved[spec.id] : null
    const bounds = overlay ? display.bounds : remembered ?? placeBounds(spec.bounds, display.workArea)
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: spec.kind === 'panel',
      transparent: spec.transparent,
      ...(spec.transparent ? { backgroundColor: '#00000000' } : {}),
      hasShadow: !spec.transparent,
      resizable: !overlay,
      movable: !overlay,
      skipTaskbar: spec.kind !== 'panel',
      alwaysOnTop: spec.alwaysOnTop,
      fullscreenable: false,
      // macOS 默认把窗口压在菜单栏下面（y 往下挪 20~40）：全屏 overlay 必须与显示器原点对齐，否则标注墨迹与屏幕错位
      ...(overlay ? { enableLargerThanScreen: true } : {}),
      focusable: spec.focusable,
      title: deps.appName,
      webPreferences: {
        preload: deps.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        devTools: deps.debug,
        additionalArguments: [deps.capabilitiesArg, `--appshell-window-id=${spec.id}`],
      },
    })
    if (spec.alwaysOnTop) win.setAlwaysOnTop(true, overlay ? 'screen-saver' : 'floating')
    // 工具条要压在全屏标注层之上：同为置顶时用更高一级
    if (spec.alwaysOnTop && !overlay && spec.excludeFromCapture) win.setAlwaysOnTop(true, 'pop-up-menu')
    if (spec.excludeFromCapture) win.setContentProtection(true)
    if (overlay) {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      win.setBounds(display.bounds)
    }
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url) && !deps.isSameOrigin(url, deps.siteOrigin())) void shell.openExternal(url)
      return { action: 'deny' }
    })
    // 被导航到站外的辅助窗口不再可信，直接关掉
    win.webContents.on('will-navigate', (event, url) => {
      if (deps.isSameOrigin(url, deps.siteOrigin())) return
      event.preventDefault()
      win.close()
    })
    win.once('ready-to-show', () => (spec.kind === 'panel' ? win.show() : win.showInactive()))
    win.on('show', () => broadcast('appshell:windows:visibility', { id: spec.id, visible: true }))
    win.on('hide', () => broadcast('appshell:windows:visibility', { id: spec.id, visible: false }))
    if (spec.rememberBounds) {
      win.on('moved', () => persist(spec.id, win))
      win.on('resized', () => persist(spec.id, win))
    }
    win.on('closed', () => {
      windows.delete(spec.id)
      kinds.delete(spec.id)
      broadcast('appshell:windows:closed', { id: spec.id })
    })
    windows.set(spec.id, win)
    kinds.set(spec.id, spec.kind)
    void win.loadURL(new URL(spec.route, deps.siteOrigin()).toString())
    return { id: spec.id }
  }

  function get(id) {
    const win = windows.get(id)
    if (!win || win.isDestroyed()) throw new Error(`没有打开的窗口 ${id}`)
    return win
  }

  return {
    idOf,
    /** 主进程别处（例如主窗口失焦）需要通知所有窗口时用。 */
    broadcast,
    closeAll() {
      for (const win of windows.values()) if (!win.isDestroyed()) win.destroy()
      windows.clear()
    },
    register(guard) {
      guard.handle('appshell:windows:open', (payload, ctx) => open(payload, { from: ctx.windowId }))
      guard.handle('appshell:windows:close', ({ id }) => {
        windows.get(id)?.close()
      })
      guard.handle('appshell:windows:setVisible', ({ id, visible }) => {
        const win = get(id)
        if (visible) win.showInactive()
        else win.hide()
      })
      guard.handle('appshell:windows:setBounds', ({ id, bounds }) => {
        const win = get(id)
        const target = { ...win.getBounds(), ...bounds }
        // 按目标位置所在的显示器夹住：拖动可以换屏，但窗口不会整个跑出屏幕
        const display = deps.electron.screen.getDisplayMatching(target)
        win.setBounds(clampToArea(placeBounds(target, display.workArea), display.workArea))
      })
      guard.handle('appshell:windows:setIgnoreMouse', ({ id, ignore, forward }) => {
        get(id).setIgnoreMouseEvents(Boolean(ignore), { forward: Boolean(forward) })
      })
      guard.handle('appshell:windows:list', () => ({
        windows: [...windows].filter(([, w]) => !w.isDestroyed())
          .map(([id, w]) => ({ id, visible: w.isVisible(), bounds: w.getBounds() })),
      }))
      guard.handle('appshell:windows:post', ({ to, message }, ctx) => {
        // '*'：发给本应用其他所有窗口（不含发送方），对应 Tauri emit 的全局广播
        if (to === '*') {
          for (const id of ['main', ...windows.keys()]) if (id !== ctx.windowId) emitTo(id, 'appshell:windows:message', { from: ctx.windowId, message })
          return
        }
        if (to !== 'main' && !windows.has(to)) throw new Error(`没有打开的窗口 ${to}`)
        emitTo(to, 'appshell:windows:message', { from: ctx.windowId, message })
      })
      guard.handle('appshell:windows:setFocusable', ({ id, focusable, focus }) => {
        const win = get(id)
        win.setFocusable(Boolean(focusable))
        // 需要键盘输入（标注文字）时把窗口设为 key window；不 show，不改变层级
        if (focusable && focus) win.focus()
      })
      guard.handle('appshell:windows:capturePage', async ({ id, rect }) => {
        const image = await get(id).webContents.capturePage(rect)
        return { png: image.toPNG().toString('base64') }
      })
      guard.handle('appshell:windows:self', (_payload, ctx) => ({ id: ctx.windowId }))
    },
  }
}

module.exports = { createWindowManager, normalizeSpec, placeBounds, clampToArea, validRoute }
