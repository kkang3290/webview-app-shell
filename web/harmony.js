// Self-contained document-start script. The Harmony generator embeds this string in BridgeScript.ets.
function installHarmonyBridge() {
  const w = window
  if (w.top !== w.self || w.appshell || typeof w.appshellNative?.getInfo !== 'function' ||
      typeof w.appshellNative?.postMessage !== 'function') return
  const host = w.appshellNative
  const fail = (code, message) => Object.assign(new Error(message), { code })
  const readInfo = () => {
    const info = JSON.parse(host.getInfo())
    if (info?.protocolVersion !== 1 || info.platform !== 'harmony' ||
        info.siteOrigin !== w.location.origin || !info.siteOrigin.startsWith('https://') ||
        typeof info.id !== 'string' || !info.id || typeof info.name !== 'string' || !info.name ||
        typeof info.appVersion !== 'string' || !info.appVersion ||
        !Number.isSafeInteger(info.build) || info.build < 1 || !Array.isArray(info.plugins) ||
        !info.plugins.includes('App') || info.plugins.some(name => !['App', 'Permissions', 'WebRecording'].includes(name))) {
      throw fail('UNTRUSTED_ORIGIN', 'Invalid Harmony host identity')
    }
    return Object.freeze({ ...info, plugins: Object.freeze([...info.plugins]) })
  }
  let info
  try { info = readInfo() } catch { return }
  let closed = false
  let sequence = 0
  const prefix = `hs-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const pending = new Map()
  const listeners = new Set()
  const current = () => !closed && w.top === w.self && w.location.origin === info.siteOrigin
  const finish = (id, error, data) => {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    clearTimeout(entry.timer)
    if (error) entry.reject(error)
    else entry.resolve(data)
  }
  const request = (plugin, method, options = {}) => {
    if (!current()) return Promise.reject(fail('PAGE_CLOSED', 'Harmony document is no longer active'))
    if (pending.size >= 64) return Promise.reject(fail('BUSY', 'Too many pending Harmony requests'))
    const id = `${prefix}-${++sequence}`
    let raw
    try {
      raw = JSON.stringify({ id, plugin, method, options })
      if (raw.length > 4096) throw fail('INVALID_ARGUMENT', 'Harmony request is too large')
    } catch (error) { return Promise.reject(error) }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(id, fail('TIMEOUT', 'Harmony host did not respond')), 15000)
      pending.set(id, { resolve, reject, timer })
      try { host.postMessage(raw) } catch { finish(id, fail('BRIDGE_ERROR', 'Harmony transport failed')) }
    })
  }
  const response = event => {
    if (!current()) return
    const reply = event.detail
    if (!reply || typeof reply.id !== 'string' || typeof reply.ok !== 'boolean') return
    if (reply.ok) finish(reply.id, null, reply.data)
    else finish(reply.id, fail(typeof reply.error?.code === 'string' ? reply.error.code : 'NATIVE_ERROR',
      typeof reply.error?.message === 'string' ? reply.error.message : 'Harmony request failed'))
  }
  const interrupted = event => {
    if (!current() || event.detail?.plugin !== 'WebRecording' || event.detail.event !== 'interrupted' ||
        typeof event.detail.data?.reason !== 'string') return
    for (const listener of [...listeners]) {
      try { listener(event.detail.data) } catch (error) { console.error('[appshell] interruption listener failed', error) }
    }
  }
  const close = () => {
    if (closed) return
    // Best effort release. Native navigation/lifecycle invalidation is the authoritative cleanup.
    try { host.postMessage(JSON.stringify({ id: `${prefix}-${++sequence}`, plugin: 'WebRecording',
      method: 'setState', options: { active: false, finishing: false } })) } catch { /* Host is already gone. */ }
    closed = true
    for (const id of pending.keys()) finish(id, fail('PAGE_CLOSED', 'Harmony document was closed'))
    listeners.clear()
    w.removeEventListener('appshell:response', response)
    w.removeEventListener('appshell:event', interrupted)
    w.removeEventListener('pagehide', close)
    w.addEventListener('pageshow', restore, { once: true })
  }
  // BFCache restores must create a fresh transport rather than reuse a closed lease or pending requests.
  const restore = event => { if (event.persisted) w.location.reload() }
  const pluginMap = {
    App: Object.freeze({
      getInfoSync: () => {
        if (!current()) throw fail('PAGE_CLOSED', 'Harmony document is no longer active')
        return readInfo()
      },
      getInfo: () => request('App', 'getInfo'),
    }),
  }
  if (info.plugins.includes('Permissions')) pluginMap.Permissions = Object.freeze({
    check: options => request('Permissions', 'check', options),
    request: options => request('Permissions', 'request', options),
    openSettings: () => request('Permissions', 'openSettings'),
  })
  if (info.plugins.includes('WebRecording')) pluginMap.WebRecording = Object.freeze({
    setState: options => request('WebRecording', 'setState', options),
    addListener: async (name, listener) => {
      if (!current()) throw fail('PAGE_CLOSED', 'Harmony document is no longer active')
      if (name !== 'interrupted' || typeof listener !== 'function') throw fail('INVALID_ARGUMENT', 'Unknown WebRecording event')
      listeners.add(listener)
      return { remove: async () => { listeners.delete(listener) } }
    },
  })
  w.addEventListener('appshell:response', response)
  w.addEventListener('appshell:event', interrupted)
  w.addEventListener('pagehide', close)
  Object.defineProperty(w, 'appshell', { value: Object.freeze({ platform: 'harmony', plugins: Object.freeze(pluginMap) }),
    configurable: false, writable: false })
}

export const HARMONY_BOOTSTRAP = `;(${installHarmonyBridge.toString()})();`
