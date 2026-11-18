// webview-app-shell/web —— 业务 Web 调用外壳原生能力的薄封装。不依赖打包器与 Capacitor npm 包，
// 直接用壳注入的 window.Capacitor，所以在浏览器里（无壳）调用会得到「不可用」而不是报错。

// iOS / Android 壳是 Capacitor（window.Capacitor.Plugins），桌面壳由预加载挂在 window.appshell.plugins；
// 两边插件同名同语义。
function plugins() {
  const w = globalThis.window
  return w?.Capacitor?.Plugins ?? w?.appshell?.plugins ?? {}
}

/** 当前壳平台；小程序标记可能在 WeixinJSBridgeReady 后才出现，UA 可用于同步识别。 */
export function shellPlatform() {
  const w = globalThis.window
  const capacitor = w?.Capacitor?.getPlatform?.()
  if (capacitor === 'ios' || capacitor === 'android') return capacitor
  if (w?.appshell?.platform === 'desktop') return 'desktop'
  if (w?.appshell?.platform === 'harmony' || harmonyShellInfo()) return 'harmony'
  if (w?.__wxjs_environment === 'miniprogram' || /\bminiProgram\b/i.test(w?.navigator?.userAgent ?? '')) return 'miniprogram'
  return 'web'
}

function decodePcm(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1)
}

/** 当前壳是否提供原生录音（iOS 与 Android 都有；浏览器里为 false，业务退回 getUserMedia）。 */
export function nativeRecorderAvailable() {
  if (shellPlatform() === 'harmony') return false
  const recorder = plugins().NativeRecorder
  return typeof recorder?.start === 'function' && typeof recorder?.readChunks === 'function'
}

/**
 * 开始原生录音，按序、不重不漏地把 PCM 段交给 onChunk。
 *
 * 原生先落盘再推事件；JS 被挂起（后台、锁屏）时事件会丢，这里在发现序号跳号或页面回到前台时
 * 用 readChunks 补拉，并在交付后 ack，原生才删除对应的段。onChunk 抛错时不 ack，下次补拉会重发。
 *
 * @param {object} options
 * @param {8000|16000|24000|48000} options.sampleRate
 * @param {number} options.chunkMs 200..5000
 * @param {string} [options.label]
 * @param {(chunk: {seq: number, sampleRate: number, level: number, pcm: Int16Array}) => void | Promise<void>} options.onChunk
 * @param {(state: {state: string, reason: string}) => void} [options.onState]
 */
export async function startNativeRecording({ sampleRate, chunkMs, label = '', inputId, onChunk, onState }) {
  if (!nativeRecorderAvailable()) throw new Error('NativeRecorder 不可用：当前不是启用了 recording 能力的 App 壳')
  if (typeof onChunk !== 'function') throw new Error('onChunk 必填')
  const recorder = plugins().NativeRecorder
  const handles = []
  let sessionId = null
  let delivered = 0
  let acked = 0
  let tail = Promise.resolve()
  const early = []
  const earlyStates = []

  // 所有交付串行执行：事件与补拉交错到达时，不会乱序或重复。
  const serial = task => {
    tail = tail.then(task).catch(error => {
      console.error('[appshell] 原生录音交付失败，稍后补拉重试', error)
    })
    return tail
  }

  const deliver = async chunk => {
    if (chunk.seq !== delivered + 1) return false
    await onChunk({ seq: chunk.seq, sampleRate: chunk.sampleRate, level: chunk.level, pcm: decodePcm(chunk.data) })
    delivered = chunk.seq
    if (delivered - acked >= 10) {
      await recorder.ack({ sessionId, uptoSeq: delivered })
      acked = delivered
    }
    return true
  }

  const drain = async () => {
    if (!sessionId) return
    for (;;) {
      const page = await recorder.readChunks({ sessionId, afterSeq: delivered, limit: 30 })
      for (const chunk of page.chunks) {
        if (chunk.seq <= delivered) continue
        if (!(await deliver(chunk))) return
      }
      if (!page.hasMore || page.chunks.length === 0) return
    }
  }

  const onEvent = chunk => serial(async () => {
    if (chunk.seq <= delivered) return
    if (!(await deliver(chunk))) await drain()
  })

  handles.push(await recorder.addListener('chunk', chunk => {
    if (!sessionId) early.push(chunk)
    else if (chunk.sessionId === sessionId) void onEvent(chunk)
  }))
  if (onState) {
    handles.push(await recorder.addListener('state', state => {
      // start() 返回前就会到达 recording/started，那时还不知道 sessionId，先存着。
      if (!sessionId) earlyStates.push(state)
      else if (!state.sessionId || state.sessionId === sessionId) onState(state)
    }))
  }
  const onVisible = () => {
    if (document.visibilityState === 'visible') void serial(drain)
  }
  document.addEventListener('visibilitychange', onVisible)

  const cleanup = () => {
    document.removeEventListener('visibilitychange', onVisible)
    for (const handle of handles) void handle.remove()
  }

  let started
  try {
    started = await recorder.start({ sampleRate, chunkMs, label, inputId })
  } catch (error) {
    cleanup()
    throw error
  }
  sessionId = started.sessionId
  for (const chunk of early.splice(0)) if (chunk.sessionId === sessionId) void onEvent(chunk)
  for (const state of earlyStates.splice(0)) if (!state.sessionId || state.sessionId === sessionId) onState?.(state)

  return {
    sessionId,
    get deliveredSeq() { return delivered },
    pause: () => recorder.pause(),
    resume: () => recorder.resume(),
    /** 录音中切换麦克风（例如连上蓝牙耳机后）；传 undefined 交还系统默认。 */
    setInput: inputId => recorder.setInput({ inputId }),
    /** 停止并补齐全部段，返回 { sessionId, filePath, durationMs, lastSeq, interruptions }。 */
    async stop() {
      const summary = await recorder.stop()
      await serial(drain)
      await tail
      if (delivered !== summary.lastSeq) {
        cleanup()
        throw new Error(`原生录音未交付完整：${delivered}/${summary.lastSeq}，段保留在原生侧可稍后恢复`)
      }
      await recorder.ack({ sessionId, uptoSeq: delivered })
      cleanup()
      return summary
    },
  }
}

/** 列出原生侧保留的录音会话（含 App 被杀前未交付完的），用于启动时恢复或清理。 */
export async function listNativeRecordings() {
  if (!nativeRecorderAvailable()) return []
  return (await plugins().NativeRecorder.listSessions()).sessions
}

/** 读出一个已停止会话里尚未 ack 的段（恢复用），按序回调后 ack。 */
export async function recoverNativeRecording(sessionId, onChunk) {
  const recorder = plugins().NativeRecorder
  let after = 0
  for (;;) {
    const page = await recorder.readChunks({ sessionId, afterSeq: after, limit: 30 })
    for (const chunk of page.chunks) {
      await onChunk({ seq: chunk.seq, sampleRate: chunk.sampleRate, level: chunk.level, pcm: decodePcm(chunk.data) })
      after = chunk.seq
    }
    if (after > 0) await recorder.ack({ sessionId, uptoSeq: after })
    if (!page.hasMore || page.chunks.length === 0) return after
  }
}

export function discardNativeRecording(sessionId) {
  return plugins().NativeRecorder.discard({ sessionId })
}

// ─── 权限 ──────────────────────────────────────────────────────

/** 统一权限接口；浏览器里返回 undefined（交给浏览器自己的权限流程）。 */
export function shellPermissions() {
  const plugin = plugins().Permissions
  if (typeof plugin?.check !== 'function') return undefined
  return {
    /** @param {Array<'microphone'|'camera'|'notifications'|'photos'|'location'>} names */
    check: names => plugin.check({ names }),
    request: names => plugin.request({ names }),
    openSettings: () => plugin.openSettings(),
  }
}

// ─── Harmony Web 录音辅助（采集仍由 getUserMedia / MediaRecorder 完成）────────

/** 同步读取经过同源校验的 Harmony 身份；普通网页与其他壳返回 undefined。 */
export function harmonyShellInfo() {
  const w = globalThis.window
  if (w?.appshell?.platform !== 'harmony' || w.top !== w.self) return undefined
  try {
    const info = w.appshell.plugins?.App?.getInfoSync?.()
    if (info?.protocolVersion !== 1 || info.platform !== 'harmony' ||
        info.siteOrigin !== w.location?.origin || !info.siteOrigin.startsWith('https://') ||
        typeof info.id !== 'string' || !info.id || typeof info.name !== 'string' || !info.name ||
        typeof info.appVersion !== 'string' || !info.appVersion ||
        !Number.isSafeInteger(info.build) || info.build < 1 || !Array.isArray(info.plugins) ||
        !info.plugins.includes('App') || info.plugins.some(name => !['App', 'Permissions', 'WebRecording'].includes(name))) return undefined
    return info
  } catch { return undefined }
}

export function webRecordingAvailable() {
  const plugin = plugins().WebRecording
  return harmonyShellInfo()?.plugins.includes('WebRecording') === true &&
    typeof plugin?.setState === 'function' && typeof plugin?.addListener === 'function'
}

function requireWebRecording() {
  if (!webRecordingAvailable()) throw Object.assign(new Error('WebRecording is unavailable'), { code: 'UNSUPPORTED' })
  return plugins().WebRecording
}

/** 告知原生当前 Web 录音/收尾状态，以维护后台任务与录音中断通知；不会启动录音。 */
export async function setWebRecordingState({ active, finishing }) {
  if (typeof active !== 'boolean' || typeof finishing !== 'boolean') {
    throw Object.assign(new Error('active and finishing must be booleans'), { code: 'INVALID_ARGUMENT' })
  }
  await requireWebRecording().setState({ active, finishing })
}

export async function onWebRecordingInterrupted(listener) {
  return requireWebRecording().addListener('interrupted', listener)
}

// ─── 后台上传 ──────────────────────────────────────────────────

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

export function backgroundUploadAvailable() {
  return typeof plugins().BackgroundUpload?.enqueue === 'function'
}

/**
 * 交给系统在后台上传（App 被挂起或被杀也会继续）。url 用业务服务端签好的地址；
 * headers 必须包含 Content-Type（签名通常包含它，两端系统默认值不同）。
 * file 二选一：{ path }（App 自己目录里的文件，如原生录音的 filePath）或 { data }（base64，≤ 10 MiB）。
 */
export function enqueueBackgroundUpload({ id, url, method, headers, file, label }) {
  if (!backgroundUploadAvailable()) throw new Error('BackgroundUpload 不可用：当前不是启用了 backgroundUpload 能力的 App 壳')
  return plugins().BackgroundUpload.enqueue({ id, url, method, headers, file, label })
}

export function listBackgroundUploads() {
  return plugins().BackgroundUpload.list().then(result => result.uploads)
}

export function cancelBackgroundUpload(id) {
  return plugins().BackgroundUpload.cancel({ id })
}

export function removeBackgroundUpload(id) {
  return plugins().BackgroundUpload.remove({ id })
}

/** 订阅上传事件，返回取消订阅函数。 */
export async function onBackgroundUpload({ onProgress, onState }) {
  const plugin = plugins().BackgroundUpload
  const handles = []
  if (onProgress) handles.push(await plugin.addListener('progress', onProgress))
  if (onState) handles.push(await plugin.addListener('state', onState))
  return () => handles.forEach(handle => void handle.remove())
}

/** 等一个上传结束（成功 / 失败 / 取消）。事件可能在页面挂起时丢失，所以同时轮询记录。 */
export async function waitForBackgroundUpload(id, { pollMs = 2000 } = {}) {
  const plugin = plugins().BackgroundUpload
  return new Promise((resolve, reject) => {
    let done = false
    let handle
    const finish = record => {
      if (done || !TERMINAL.has(record.state)) return
      done = true
      clearInterval(timer)
      void handle?.remove()
      resolve(record)
    }
    const poll = () => plugin.get({ id }).then(finish, error => {
      if (done) return
      done = true
      clearInterval(timer)
      void handle?.remove()
      reject(error)
    })
    const timer = setInterval(poll, pollMs)
    plugin.addListener('state', record => { if (record.id === id) finish(record) }).then(h => { handle = h; if (done) void h.remove() })
    void poll()
  })
}

// ─── 麦克风输入（内置 / 蓝牙 / 有线 / USB）───────────────────────

export function listNativeInputs() {
  return plugins().NativeRecorder.listInputs().then(result => result.inputs)
}

/** 耳机连上 / 断开时回调新的输入列表，返回取消订阅函数。 */
export async function onNativeInputsChanged(callback) {
  const handle = await plugins().NativeRecorder.addListener('inputs', event => callback(event.inputs))
  return () => void handle.remove()
}

// ─── 推送（Android 极光或个推，聚合厂商通道 / iOS APNs）──────────────────

export function pushAvailable() {
  return typeof plugins().Push?.register === 'function'
}

/**
 * 在用户同意隐私政策之后调用。返回 { provider: 'jpush' | 'getui' | 'apns', token, environment? }，
 * 交给业务后端保存；后端按 provider 选择极光 / 个推 REST API 或 APNs（environment 决定 sandbox / production）。
 * 个推的 token 是 clientId。
 */
export function registerPush() {
  if (!pushAvailable()) throw new Error('Push 不可用：当前不是启用了 push 能力的 App 壳')
  return plugins().Push.register()
}

export function getPushToken() {
  return plugins().Push.getToken()
}

/** 用户撤回同意或退出登录时调用：停止推送，下次启动不再自动注册。 */
export function unregisterPush() {
  return plugins().Push.unregister()
}

/** 冷启动时用户点开的那条通知（只返回一次）。 */
export function takeLaunchNotification() {
  return plugins().Push.getLaunchNotification().then(result => result.notification ?? null)
}

export function clearNotifications() {
  return plugins().Push.clearAll()
}

export function setBadge(count) {
  return plugins().Push.setBadge({ count })
}

/** 订阅推送事件，返回取消订阅函数。opened 事件在页面未就绪时会被保留，订阅后补发。 */
export async function onPush({ onToken, onReceived, onOpened, onMessage }) {
  const plugin = plugins().Push
  const handles = []
  if (onToken) handles.push(await plugin.addListener('token', onToken))
  if (onReceived) handles.push(await plugin.addListener('received', onReceived))
  if (onOpened) handles.push(await plugin.addListener('opened', onOpened))
  if (onMessage) handles.push(await plugin.addListener('message', onMessage))
  return () => handles.forEach(handle => void handle.remove())
}

// ─── 屏幕共享（能力组 screenCapture）────────────────────────────
// 手机：原生整屏采集 + RTMPS 推流 + 原生续租（网页进后台不断），可选分段回放补传。
// 桌面：原生只列来源 / 截快照；selectScreenSource 之后的下一次 getDisplayMedia 拿到选定来源，画面由页面自己发。

export function screenCaptureAvailable() {
  return typeof plugins().ScreenCapture?.capabilities === 'function'
}

/** { platform, screens, windows, stream: ['rtmps'] | [], replay, permission? }；stream 为空表示由页面自己采集（桌面）。 */
export function screenCaptureCapabilities() {
  if (!screenCaptureAvailable()) return Promise.resolve(null)
  return plugins().ScreenCapture.capabilities()
}

/** 手机：开始共享。参数见 docs/screen-capture.md；地址主机必须在 screenCapture.allowedHosts 里。 */
export function startScreenCapture({ stream, lease, replay }) {
  const plugin = plugins().ScreenCapture
  if (typeof plugin?.start !== 'function') throw new Error('ScreenCapture.start 不可用：当前壳不由原生推流（桌面用 getDisplayMedia）')
  return plugin.start(replay ? { stream, lease, replay } : { stream, lease })
}

export function stopScreenCapture() {
  return plugins().ScreenCapture.stop()
}

export function screenCaptureState() {
  return plugins().ScreenCapture.state()
}

/** 订阅状态变化（requesting / sharing / stopped / failed / denied），返回取消订阅函数。手机端。 */
export async function onScreenCaptureState(callback) {
  const plugin = plugins().ScreenCapture
  if (typeof plugin?.addListener !== 'function') return () => {}
  const handle = await plugin.addListener('state', event => callback(event.state))
  return () => void handle.remove()
}

/** 桌面：列出可共享的屏幕 / 窗口。 */
export function listScreenSources(options) {
  return plugins().ScreenCapture.listSources(options ?? {}).then(result => result.sources)
}

/** 桌面：给某个屏幕 / 窗口截一张 JPEG。 */
export function snapshotScreenSource(sourceId, { maxWidth, quality } = {}) {
  return plugins().ScreenCapture.snapshot({ sourceId, maxWidth, quality })
}

/** 桌面：选定来源后立刻 getDisplayMedia（30 秒内有效、只用一次）。返回只含画面的 MediaStream。 */
export async function captureScreenSource(sourceId, constraints = { video: true }) {
  await plugins().ScreenCapture.select({ sourceId })
  return navigator.mediaDevices.getDisplayMedia({ ...constraints, audio: false })
}
