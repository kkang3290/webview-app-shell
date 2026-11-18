'use strict'
// 后台上传（主进程）：与 iOS / Android 同名同语义。窗口关了也继续（应用没退出就行）；
// 退出时没传完的任务留在记录里，下次启动接着传。4xx 不重试，交回业务重新签名。

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const crypto = require('node:crypto')

const ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_INLINE_BYTES = 10 * 1024 * 1024
const MAX_ATTEMPTS = 8
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

function retryable(status) {
  return status === 408 || status === 429 || status >= 500
}

/** 正式包只收 https；Debug 包额外允许本机回环 http，便于对着本机测试服务联调。 */
function allowedUrl(raw, debug) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  return debug && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port !== ''
}

function validHeaderName(name) {
  return /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(name) && !['content-length', 'host'].includes(name.toLowerCase())
}

/** 只允许 App 自己数据目录里的文件：页面不能借上传把别处的文件带出去。 */
function resolveSource(file, allowedRoot) {
  const resolved = fs.realpathSync(path.resolve(file))
  const root = fs.realpathSync(allowedRoot)
  if (!resolved.startsWith(root + path.sep)) throw new Error('file must be inside the app data directory')
  if (!fs.statSync(resolved).isFile()) throw new Error('file not found')
  return resolved
}

function createUploader({ root, allowedRoot, debug, guard, emit }) {
  const timers = new Map()
  const running = new Map()

  const recordFile = id => path.join(root, `${id}.json`)

  async function save(record) {
    const tmp = `${recordFile(record.id)}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(record))
    await fsp.rename(tmp, recordFile(record.id))
  }

  async function load(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('unknown upload')
    try {
      return JSON.parse(await fsp.readFile(recordFile(id), 'utf8'))
    } catch {
      throw new Error('unknown upload')
    }
  }

  // 给页面的视图：不回显签名 URL、请求头和本地路径。
  function view(record) {
    const { url, headers, source, staged, ...rest } = record
    return rest
  }

  async function update(record, changes) {
    Object.assign(record, changes)
    if (TERMINAL.has(record.state)) record.finishedAt = new Date().toISOString()
    await save(record)
    emit('state', view(record))
  }

  function attempt(record) {
    return new Promise(resolve => {
      const url = new URL(record.url)
      const total = fs.statSync(record.source).size
      const client = url.protocol === 'https:' ? https : http
      const request = client.request(url, { method: record.method, headers: { ...record.headers, 'content-length': total } }, response => {
        response.resume()
        response.on('end', () => {
          const headers = {}
          for (const [name, value] of Object.entries(response.headers)) {
            if (name === 'etag' || name.startsWith('x-')) headers[name] = Array.isArray(value) ? value[0] : value
          }
          resolve({ status: response.statusCode, headers })
        })
      })
      running.set(record.id, request)
      request.on('error', error => resolve({ error }))
      let sent = 0
      let last = 0
      const input = fs.createReadStream(record.source)
      input.on('data', chunk => {
        sent += chunk.length
        const now = Date.now()
        if (now - last > 250 || sent === total) {
          last = now
          emit('progress', { id: record.id, sent, total })
        }
      })
      input.on('error', error => {
        request.destroy(error)
      })
      input.pipe(request)
    }).finally(() => running.delete(record.id))
  }

  async function run(id) {
    timers.delete(id)
    let record
    try {
      record = await load(id)
    } catch {
      return
    }
    if (TERMINAL.has(record.state) || running.has(id)) return
    if (!fs.existsSync(record.source)) {
      await update(record, { state: 'failed', error: 'source file missing' })
      return
    }
    await update(record, { state: 'running', error: undefined })
    const result = await attempt(record)
    record = await load(id)
    if (record.state === 'cancelled') return
    record.attempts += 1
    if (result.status >= 200 && result.status < 300) {
      await update(record, { state: 'succeeded', status: result.status, sent: record.total, responseHeaders: result.headers })
      return
    }
    const transient = result.error !== undefined || retryable(result.status)
    const error = result.error ? `${result.error.code || 'Error'}: ${result.error.message}` : `HTTP ${result.status}`
    if (transient && record.attempts < MAX_ATTEMPTS) {
      await update(record, { state: 'queued', status: result.status, error })
      // 退避：30 秒起，每次翻倍，最多 30 分钟。
      schedule(id, Math.min(30_000 * 2 ** (record.attempts - 1), 1_800_000))
    } else {
      await update(record, { state: 'failed', status: result.status, error })
    }
  }

  function schedule(id, delay) {
    clearTimeout(timers.get(id))
    timers.set(id, setTimeout(() => void run(id), delay))
  }

  guard.handle('appshell:upload:enqueue', async options => {
    const id = options.id ?? crypto.randomUUID()
    if (!ID.test(id)) throw new Error('id must match [A-Za-z0-9_-]{1,64}')
    if (!allowedUrl(options.url, debug)) throw new Error('url must be https (debug builds may also use http://127.0.0.1)')
    if (!['PUT', 'POST'].includes(options.method)) throw new Error('method must be PUT or POST')
    const headers = {}
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (!validHeaderName(name) || typeof value !== 'string') throw new Error(`invalid header ${name}`)
      headers[name] = value
    }
    if (!Object.entries(headers).some(([name, value]) => name.toLowerCase() === 'content-type' && value)) {
      throw new Error('headers must include Content-Type (signed URLs usually sign it; platforms default differently)')
    }
    if (fs.existsSync(recordFile(id))) throw new Error(`upload ${id} already exists`)
    const file = options.file ?? {}
    let source
    let staged = false
    if (typeof file.data === 'string') {
      const bytes = Buffer.from(file.data, 'base64')
      if (bytes.length > MAX_INLINE_BYTES) throw new Error('inline data is limited to 10 MiB; write a file and pass file.path')
      source = path.join(root, `${id}.bin`)
      await fsp.writeFile(source, bytes)
      staged = true
    } else if (typeof file.path === 'string') {
      source = resolveSource(file.path, allowedRoot)
    } else {
      throw new Error('file must be { path } or { data }')
    }
    const record = {
      id, url: options.url, method: options.method, headers, source, staged,
      label: typeof options.label === 'string' ? options.label : '', state: 'queued', sent: 0,
      total: fs.statSync(source).size, attempts: 0, responseHeaders: {}, createdAt: new Date().toISOString(),
    }
    await save(record)
    schedule(id, 0)
    return view(record)
  })

  guard.handle('appshell:upload:get', async ({ id }) => view(await load(id)))

  guard.handle('appshell:upload:list', async () => {
    const records = []
    for (const name of await fsp.readdir(root)) {
      if (!name.endsWith('.json')) continue
      try {
        records.push(view(await load(name.slice(0, -5))))
      } catch {
        // 损坏的记录跳过
      }
    }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return { uploads: records }
  })

  guard.handle('appshell:upload:cancel', async ({ id }) => {
    const record = await load(id)
    clearTimeout(timers.get(id))
    timers.delete(id)
    running.get(id)?.destroy(new Error('cancelled'))
    if (!TERMINAL.has(record.state)) await update(record, { state: 'cancelled' })
    return view(record)
  })

  guard.handle('appshell:upload:remove', async ({ id }) => {
    const record = await load(id)
    if (!TERMINAL.has(record.state)) throw new Error('cancel the upload before removing it')
    await fsp.rm(recordFile(id), { force: true })
    if (record.staged) await fsp.rm(record.source, { force: true })
    return true
  })

  return {
    /** 启动时把上次没传完的任务接着传。 */
    async resume() {
      await fsp.mkdir(root, { recursive: true })
      for (const name of await fsp.readdir(root)) {
        if (!name.endsWith('.json')) continue
        try {
          const record = await load(name.slice(0, -5))
          if (record.state === 'queued' || record.state === 'running') schedule(record.id, 0)
        } catch {
          // 跳过
        }
      }
    },
    stop() {
      for (const timer of timers.values()) clearTimeout(timer)
      for (const request of running.values()) request.destroy(new Error('app quitting'))
    },
  }
}

module.exports = { createUploader, allowedUrl, retryable, validHeaderName, resolveSource }
