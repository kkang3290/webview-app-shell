'use strict'
// 预加载：把外壳插件挂到 window.appshell.plugins，名字与方法和 iOS / Android（Capacitor 插件）一致，
// webview-app-shell/web 因此三端一套代码。页面只能碰到这里列出的方法，没有通用的 IPC 转发口子。
//
// NativeRecorder 在这里采集：桌面端不会挂起页面，所以直接用 getUserMedia；每段 PCM 与原件片段经 IPC
// 交给主进程落盘，补拉 / 确认语义与手机端一致。

const { contextBridge, ipcRenderer } = require('electron')

// Electron 会把主进程抛的错包成「Error invoking remote method '…': Error: 原因」；剥掉外壳，
// 让页面看到与 iOS / Android 一致的错误文字。
const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload).catch(error => {
  const message = String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, '')
  throw new Error(message)
})

function emitter() {
  const listeners = new Map()
  return {
    add(event, callback) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(callback)
      return Promise.resolve({ remove: async () => { listeners.get(event)?.delete(callback) } })
    },
    emit(event, data) {
      for (const callback of listeners.get(event) ?? []) {
        try {
          callback(data)
        } catch (error) {
          console.error('[appshell] listener failed', error)
        }
      }
    },
  }
}

function base64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function inputType(label) {
  const text = label.toLowerCase()
  if (/bluetooth|airpods|buds|hands-free|headset \(/.test(text)) return 'bluetooth'
  if (/usb/.test(text)) return 'usb'
  if (/headset|headphone|耳机/.test(text)) return 'wired'
  if (text === '' || /built-in|internal|内建|内置|macbook|麦克风阵列|microphone array/.test(text)) return 'builtin'
  return 'other'
}

// ─── NativeRecorder ─────────────────────────────────────────

const recorderEvents = emitter()
let recording = null
let currentInputId = null

async function listInputs() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter(device => device.kind === 'audioinput' && device.deviceId !== 'communications')
    .map(device => ({
      id: device.deviceId,
      type: inputType(device.label),
      name: device.label || 'Microphone',
      active: recording !== null && (currentInputId ?? 'default') === device.deviceId,
    }))
}

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  void listInputs().then(inputs => recorderEvents.emit('inputs', { inputs }))
})

async function openStream(inputId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...(inputId ? { deviceId: { exact: inputId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })
}

function setState(state, reason, interrupted = false) {
  recording.state = state
  void invoke('appshell:recorder:state', { sessionId: recording.sessionId, state, interrupted })
  recorderEvents.emit('state', { state, reason, sessionId: recording.sessionId, lastSeq: recording.seq })
}

function attachSource(stream) {
  recording.stream = stream
  recording.source = recording.context.createMediaStreamSource(stream)
  recording.source.connect(recording.processor)
  recording.source.connect(recording.archiveDestination)
  const [track] = stream.getAudioTracks()
  // 设备被拔掉、被系统收回：推 interrupted，页面可以提示并调用 setInput 换设备。
  track.addEventListener('ended', () => {
    if (recording && recording.stream === stream && recording.state === 'recording') setState('interrupted', 'device-lost', true)
  })
}

function detachSource() {
  recording.source?.disconnect()
  recording.stream?.getTracks().forEach(track => track.stop())
  recording.source = null
  recording.stream = null
}

// 段与原件片段按产生顺序串行交给主进程：并发 invoke 会乱序。
function enqueue(task) {
  recording.tail = recording.tail.then(task).catch(error => {
    console.error('[appshell] recorder write failed', error)
    recorderEvents.emit('state', { state: recording?.state ?? 'idle', reason: 'write-failed', sessionId: recording?.sessionId })
  })
  return recording.tail
}

function publish(samples) {
  const session = recording
  const seq = ++session.seq
  const pcm = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  const durationMs = Math.round((samples.length / session.sampleRate) * 1000)
  const startMs = session.publishedMs
  session.publishedMs += durationMs
  return enqueue(async () => {
    const { level } = await invoke('appshell:recorder:chunk', { sessionId: session.sessionId, seq, pcm })
    recorderEvents.emit('chunk', {
      sessionId: session.sessionId, seq, startMs, durationMs, sampleRate: session.sampleRate, level, data: base64(pcm),
    })
  })
}

const NativeRecorder = {
  async start({ sampleRate, chunkMs, label, inputId }) {
    if (recording) throw new Error('a recording is already active')
    const stream = await openStream(inputId)
    let began
    try {
      began = await invoke('appshell:recorder:begin', { sampleRate, chunkMs, label })
    } catch (error) {
      stream.getTracks().forEach(track => track.stop())
      throw error
    }
    // AudioContext 按目标采样率创建，Chromium 负责重采样；静音增益节点只为让处理节点持续工作。
    const context = new AudioContext({ sampleRate })
    const processor = context.createScriptProcessor(4096, 1, 1)
    const mute = context.createGain()
    mute.gain.value = 0
    processor.connect(mute).connect(context.destination)
    // 原件单声道：麦克风本来就是单声道，双声道只会让文件大一倍。
    const archiveDestination = context.createMediaStreamDestination()
    archiveDestination.channelCount = 1
    archiveDestination.channelCountMode = 'explicit'
    const chunkFrames = Math.round((sampleRate * chunkMs) / 1000)
    recording = {
      sessionId: began.sessionId, filePath: began.filePath, sampleRate, context, processor, archiveDestination,
      buffer: new Int16Array(chunkFrames), filled: 0, seq: 0, publishedMs: 0, state: 'recording', tail: Promise.resolve(),
    }
    currentInputId = inputId ?? null
    processor.onaudioprocess = event => {
      if (!recording || recording.state !== 'recording') return
      const input = event.inputBuffer.getChannelData(0)
      for (let i = 0; i < input.length; i++) {
        const sample = Math.max(-1, Math.min(1, input[i]))
        recording.buffer[recording.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
        if (recording.filled === recording.buffer.length) {
          void publish(recording.buffer.slice())
          recording.filled = 0
        }
      }
    }
    attachSource(stream)
    // 原件：从同一个 AudioContext 出一路给 MediaRecorder，换麦克风时原件不中断。
    const mediaRecorder = new MediaRecorder(archiveDestination.stream, { mimeType: 'audio/webm;codecs=opus' })
    mediaRecorder.ondataavailable = event => {
      const session = recording
      if (!session || event.data.size === 0) return
      void enqueue(async () => {
        const data = new Uint8Array(await event.data.arrayBuffer())
        await invoke('appshell:recorder:archive', { sessionId: session.sessionId, data })
      })
    }
    mediaRecorder.start(1000)
    recording.mediaRecorder = mediaRecorder
    recorderEvents.emit('state', { state: 'recording', reason: 'started', sessionId: began.sessionId, lastSeq: 0 })
    return { state: 'recording', sessionId: began.sessionId, lastSeq: 0, durationMs: 0, sampleRate, interruptions: 0, filePath: began.filePath }
  },

  async pause() {
    if (!recording) throw new Error('no active recording')
    recording.mediaRecorder.pause()
    await recording.context.suspend()
    setState('paused', 'requested')
    return NativeRecorder.getStatus()
  },

  async resume() {
    if (!recording) throw new Error('no active recording')
    if (!recording.stream || recording.stream.getAudioTracks()[0]?.readyState !== 'live') {
      detachSource()
      attachSource(await openStream(currentInputId))
    }
    await recording.context.resume()
    recording.mediaRecorder.resume()
    setState('recording', 'resumed')
    return NativeRecorder.getStatus()
  },

  async stop() {
    if (!recording) throw new Error('no active recording')
    const session = recording
    session.state = 'stopping'
    await new Promise(resolve => {
      session.mediaRecorder.addEventListener('stop', resolve, { once: true })
      session.mediaRecorder.stop()
    })
    if (session.filled > 0) void publish(session.buffer.slice(0, session.filled))
    await session.tail
    detachSource()
    session.processor.disconnect()
    await session.context.close()
    recording = null
    const summary = await invoke('appshell:recorder:finish', { sessionId: session.sessionId })
    recorderEvents.emit('state', { state: 'idle', reason: 'stopped' })
    return summary
  },

  async getStatus() {
    const microphone = (await invoke('appshell:permissions:check', { names: ['microphone'] }).catch(() => ({}))).microphone ?? 'unknown'
    if (!recording) return { state: 'idle', microphone }
    return {
      state: recording.state, sessionId: recording.sessionId, lastSeq: recording.seq, durationMs: recording.publishedMs,
      sampleRate: recording.sampleRate, filePath: recording.filePath, microphone,
    }
  },

  readChunks: options => invoke('appshell:recorder:readChunks', options),
  ack: options => invoke('appshell:recorder:ack', options),
  listSessions: () => invoke('appshell:recorder:list'),
  discard: options => invoke('appshell:recorder:discard', options),

  async listInputs() {
    return { inputs: await listInputs() }
  },

  async setInput({ inputId }) {
    if (!recording) throw new Error('no active recording')
    const stream = await openStream(inputId)
    detachSource()
    attachSource(stream)
    currentInputId = inputId ?? null
    if (recording.state === 'interrupted') setState('recording', 'input-changed')
    else recorderEvents.emit('state', { state: recording.state, reason: 'input-changed', sessionId: recording.sessionId })
    return { inputs: await listInputs() }
  },

  addListener: (event, callback) => recorderEvents.add(event, callback),
}

// ─── BackgroundUpload ───────────────────────────────────────

const uploadEvents = emitter()
ipcRenderer.on('appshell:upload:event', (_event, { event, data }) => uploadEvents.emit(event, data))

const BackgroundUpload = {
  enqueue: options => invoke('appshell:upload:enqueue', options),
  get: options => invoke('appshell:upload:get', options),
  list: () => invoke('appshell:upload:list'),
  cancel: options => invoke('appshell:upload:cancel', options),
  remove: options => invoke('appshell:upload:remove', options),
  addListener: (event, callback) => uploadEvents.add(event, callback),
}

// ─── Permissions / App ──────────────────────────────────────

const Permissions = {
  check: options => invoke('appshell:permissions:check', options),
  request: options => invoke('appshell:permissions:request', options),
  openSettings: options => invoke('appshell:permissions:openSettings', options ?? {}),
}

const appEvents = emitter()
ipcRenderer.on('appshell:app:url', (_event, data) => appEvents.emit('url', data))

const App = {
  getInfo: () => invoke('appshell:app:info'),
  /** 启动以来收到、还没取走的深链（含冷启动那一条）。 */
  takeUrls: () => invoke('appshell:app:takeUrls').then(urls => ({ urls })),
  addListener: (event, callback) => appEvents.add(event, callback),
}

/** 热更新：与 Android 同名。页面入口首次绘制后调 notifyReady；activate 成功后主进程会原地重载页面。 */
const WebBundleUpdater = {
  getInfo: () => invoke('appshell:webbundle:info'),
  pending: () => invoke('appshell:webbundle:pending'),
  activate: () => invoke('appshell:webbundle:activate'),
  notifyReady: () => invoke('appshell:webbundle:notifyReady'),
}

const windowEvents = emitter()
ipcRenderer.on('appshell:windows:message', (_event, data) => windowEvents.emit('message', data))
ipcRenderer.on('appshell:windows:closed', (_event, data) => windowEvents.emit('closed', data))
ipcRenderer.on('appshell:windows:visibility', (_event, data) => windowEvents.emit('visibility', data))
ipcRenderer.on('appshell:windows:appDeactivated', (_event, data) => windowEvents.emit('appDeactivated', data))

/** 多窗口：辅助窗口加载本站点的路由；窗口之间用 post / 'message' 事件整帧传消息。 */
const Windows = {
  /** 当前这个窗口的 id：主窗口是 'main'。 */
  self: () => invoke('appshell:windows:self'),
  open: spec => invoke('appshell:windows:open', spec),
  close: options => invoke('appshell:windows:close', options),
  setVisible: options => invoke('appshell:windows:setVisible', options),
  setBounds: options => invoke('appshell:windows:setBounds', options),
  setIgnoreMouse: options => invoke('appshell:windows:setIgnoreMouse', options),
  setFocusable: options => invoke('appshell:windows:setFocusable', options),
  list: () => invoke('appshell:windows:list'),
  post: options => invoke('appshell:windows:post', options),
  capturePage: options => invoke('appshell:windows:capturePage', options),
  addListener: (event, callback) => windowEvents.add(event, callback),
}

const systemEvents = emitter()
ipcRenderer.on('appshell:system:trayItem', (_event, data) => systemEvents.emit('trayItem', data))
ipcRenderer.on('appshell:system:mainWindowWillHide', (_event, data) => systemEvents.emit('mainWindowWillHide', data))
ipcRenderer.on('appshell:system:prepareQuit', (_event, data) => systemEvents.emit('prepareQuit', data))

/** 系统集成（桌面）：托盘菜单、主窗口控制、关闭拦截、退出确认、系统隐私设置。 */
const SystemShell = {
  setTray: options => invoke('appshell:system:setTray', options),
  mainWindow: options => invoke('appshell:system:mainWindow', options),
  setHideBehavior: options => invoke('appshell:system:setHideBehavior', options),
  preventQuit: options => invoke('appshell:system:preventQuit', options),
  openPrivacySettings: options => invoke('appshell:system:openPrivacySettings', options),
  addListener: (event, callback) => systemEvents.add(event, callback),
}

/**
 * 屏幕共享（桌面）：列出屏幕 / 窗口、截快照；select 之后的下一次 getDisplayMedia 拿到选定的来源。
 * 与手机端同名，但桌面没有 start / stop（stream 为空数组）：画面由页面自己采集、自己发。
 */
const ScreenCapture = {
  capabilities: () => invoke('appshell:screen:capabilities'),
  listSources: options => invoke('appshell:screen:listSources', options ?? {}),
  snapshot: options => invoke('appshell:screen:snapshot', options),
  select: options => invoke('appshell:screen:select', options),
}

const capabilities = (process.argv.find(arg => arg.startsWith('--appshell-capabilities=')) ?? '')
  .slice('--appshell-capabilities='.length).split(',').filter(Boolean)

const windowId = (process.argv.find(arg => arg.startsWith('--appshell-window-id=')) ?? '').slice('--appshell-window-id='.length) || 'main'

contextBridge.exposeInMainWorld('appshell', {
  platform: 'desktop',
  /** 这个页面所在的窗口：'main' 或辅助窗口的 id（网页据此决定渲染主界面还是浮窗）。 */
  windowId,
  os: process.platform,
  plugins: {
    Permissions,
    App,
    ...(capabilities.includes('recording') ? { NativeRecorder } : {}),
    ...(capabilities.includes('backgroundUpload') ? { BackgroundUpload } : {}),
    ...(capabilities.includes('hotUpdate') ? { WebBundleUpdater } : {}),
    ...(capabilities.includes('windows') ? { Windows } : {}),
    ...(capabilities.includes('system') ? { SystemShell } : {}),
    ...(capabilities.includes('screenCapture') ? { ScreenCapture } : {}),
  },
})
