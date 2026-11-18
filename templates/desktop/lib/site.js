'use strict'
// 本地同源站点：把 Web 产物和后端 API 摆进同一个 origin（http://127.0.0.1:<端口>）。
// 网页按浏览器同源的假设写，桌面端一行不用改；后端也不必为桌面端开 CORS。
// API 前缀与目标由配置给出。

const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const NONCE_COOKIE = 'appshell_site_nonce'
const PORT_FILENAME = 'appshell-site-port'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

function isApiPath(url, apiPrefix) {
  if (!url) return false
  const pathname = url.split('?')[0]
  return pathname === apiPrefix || pathname.startsWith(`${apiPrefix}/`)
}

function readCookie(header, name) {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    return part.slice(eq + 1).trim()
  }
  return null
}

// 回环地址拦不住浏览器：本机任意网页都能往 127.0.0.1 的端口发请求。没有这道口令，
// 本进程就是一个通往业务后端的开放中继。用 cookie 而不是请求头：<script src>、<audio src>
// 这类浏览器自己发的请求加不了头；也不能放 URL 里（会跟着 Referer、日志漏出去）。
function hasNonce(req, nonce) {
  const got = readCookie(req.headers.cookie, NONCE_COOKIE)
  if (got === null) return false
  const a = Buffer.from(got)
  const b = Buffer.from(nonce)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function stripNonceCookie(header) {
  if (!header) return undefined
  const kept = header.split(';')
    .filter(part => part.slice(0, Math.max(part.indexOf('='), 0)).trim() !== NONCE_COOKIE)
    .map(part => part.trim())
    .filter(Boolean)
  return kept.length ? kept.join('; ') : undefined
}

// 页面与站点本来同源，上游的 CORS 头对自己人没用；原样转出等于允许别的网页读响应。
function sanitizeResponseHeaders(headers) {
  const out = { ...headers }
  for (const key of Object.keys(out)) {
    if (key.toLowerCase().startsWith('access-control-')) delete out[key]
  }
  return out
}

function serializeHeaders(headers) {
  return Object.entries(sanitizeResponseHeaders(headers))
    .flatMap(([key, value]) => {
      if (value === undefined) return []
      return Array.isArray(value) ? value.map(v => `${key}: ${v}`) : [`${key}: ${value}`]
    })
    .join('\r\n')
}

function proxyOptions(req, target) {
  // Host 跟着目标走：网关按 Host 路由，原样带 127.0.0.1 会被拒。
  const headers = { ...req.headers, host: target.host }
  // 删键而不是赋 undefined：值为 undefined 的头会让 http 客户端直接抛错。
  const cookie = stripNonceCookie(req.headers.cookie)
  if (cookie === undefined) delete headers.cookie
  else headers.cookie = cookie
  return {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || 443,
    method: req.method,
    path: req.url,
    headers,
  }
}

function proxyHttp(req, res, target) {
  const upstream = https.request(proxyOptions(req, target), response => {
    res.writeHead(response.statusCode || 502, sanitizeResponseHeaders(response.headers))
    response.pipe(res)
  })
  upstream.on('error', error => {
    // 断网、VPN 掉线是常态：回 502 交给页面的错误处理，不能把进程带崩。
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`上游不可达：${error.message}`)
  })
  req.pipe(upstream)
}

function noDelay(stream) {
  if (typeof stream.setNoDelay === 'function') stream.setNoDelay(true)
}

// WebSocket：实时转写这类长连接走 API 前缀；漏了升级转发，表现是「一直连不上」。
function proxyUpgrade(req, socket, head, target) {
  const upstream = https.request(proxyOptions(req, target))
  upstream.end()
  upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${serializeHeaders(response.headers)}\r\n\r\n`)
    if (upstreamHead.length) socket.unshift(upstreamHead)
    if (head.length) upstreamSocket.unshift(head)
    noDelay(socket)
    noDelay(upstreamSocket)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    upstreamSocket.on('error', () => socket.destroy())
    socket.on('error', () => upstreamSocket.destroy())
  })
  // 上游拒绝升级（鉴权失败等）：把它的 HTTP 响应原样回给页面，页面能看到真实状态码。
  upstream.on('response', response => {
    socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${serializeHeaders(response.headers)}\r\n\r\n`)
    response.pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
}

async function statFile(file) {
  try {
    const stat = await fsp.stat(file)
    return stat.isFile() ? stat : null
  } catch {
    return null
  }
}

async function serveStatic(req, res, webRoot) {
  let pathname
  try {
    pathname = decodeURIComponent((req.url || '/').split('?')[0])
  } catch {
    res.writeHead(400).end()
    return
  }
  const resolved = path.resolve(path.join(webRoot, pathname))
  const root = path.resolve(webRoot)
  if (pathname.includes('\0') || (resolved !== root && !resolved.startsWith(root + path.sep))) {
    res.writeHead(403).end()
    return
  }
  // Resolve links before reading: a lexical prefix check alone allows a linked file outside webRoot.
  const realRoot = await fsp.realpath(root)
  const safeFile = async candidate => {
    try {
      const actual = await fsp.realpath(candidate)
      if (actual !== realRoot && !actual.startsWith(realRoot + path.sep)) return null
      const stat = await statFile(actual)
      return stat ? { path: actual, stat } : null
    } catch { return null }
  }
  const file = await safeFile(resolved)
  if (file) {
    // 带内容 hash 的 /assets/ 长缓存，index.html 等不缓存（与 nginx 的分档一致）。
    res.writeHead(200, {
      'content-type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'content-length': file.stat.size,
      'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    fs.createReadStream(file.path).pipe(res)
    return
  }
  // 缺失的 hash 资源回 404，不走 SPA fallback：否则 HTML 被当 JS 解析，报错与真实原因无关。
  if (pathname.startsWith('/assets/')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  const index = await safeFile(path.join(webRoot, 'index.html'))
  if (!index) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('没有找到可用的 Web 产物')
    return
  }
  res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' })
  fs.createReadStream(index.path).pipe(res)
}

/** `<prefix>/web-bundle-{status,apply,ready}`：供页面查询、启用和确认热更新。 */
function handleWebBundle(req, res, webBundles) {
  const pathname = new URL(req.url, 'http://local').pathname
  const json = (status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-cache' })
    res.end(text)
  }
  if (pathname === `${webBundles.prefix}/web-bundle-status`) {
    json(200, { pending: webBundles.pending(), apply: webBundles.applyMode })
    return true
  }
  if (pathname === `${webBundles.prefix}/web-bundle-apply` && req.method === 'POST') {
    void webBundles.apply().then(ok => json(ok ? 200 : 409, { ok }), () => json(500, { ok: false }))
    return true
  }
  if (pathname === `${webBundles.prefix}/web-bundle-ready` && req.method === 'POST') {
    void webBundles.confirmReady().then(() => res.writeHead(204).end(), () => res.writeHead(500).end())
    return true
  }
  return false
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

async function readRememberedPort(file) {
  try {
    const port = Number(await fsp.readFile(file, 'utf8'))
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 0
  } catch (error) {
    if (error && error.code === 'ENOENT') return 0
    throw error
  }
}

/**
 * @param {{ webRoot: () => string, apiPath: string, apiTarget: string, userDataDir: string,
 *   desktopInfo?: { path: string, body: object } | null,
 *   webBundles?: { prefix: string, pending: () => unknown, apply: () => Promise<boolean>, confirmReady: () => Promise<void> } }} options
 * @returns {Promise<{ server: http.Server, origin: string, nonce: string }>}
 */
async function startLocalSite({ webRoot, apiPath, apiTarget, userDataDir, webBundles, desktopInfo }) {
  const target = new URL(apiTarget)
  const nonce = crypto.randomBytes(32).toString('base64url')
  const server = http.createServer((req, res) => {
    if (!hasNonce(req, nonce)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('本地站点只服务本应用的窗口（缺少启动口令）')
      return
    }
    // 热更新端点在启动口令之后：同一把 nonce 保护它们
    if (desktopInfo && (req.url || '').split('?')[0] === desktopInfo.path) {
      const text = JSON.stringify(desktopInfo.body)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-cache' })
      res.end(text)
      return
    }
    if (webBundles && handleWebBundle(req, res, webBundles)) return
    if (isApiPath(req.url, apiPath)) {
      proxyHttp(req, res, target)
      return
    }
    // 每个请求现问一次服务目录：启用热更包后页面原地 reload 就落到新目录
    void serveStatic(req, res, webRoot()).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Web 资源不可用')
    })
  })
  server.on('upgrade', (req, socket, head) => {
    if (!hasNonce(req, nonce) || !isApiPath(req.url, apiPath)) {
      socket.destroy()
      return
    }
    proxyUpgrade(req, socket, head, target)
  })
  // 首次由系统分配，之后复用同一端口：Chromium 的 localStorage 按 origin（含端口）隔离，
  // 换端口等于丢掉登录态。被占用时回退到系统分配，不让应用起不来。
  const portFile = path.join(userDataDir, PORT_FILENAME)
  const remembered = await readRememberedPort(portFile)
  try {
    await listen(server, remembered)
  } catch (error) {
    if (!remembered || error.code !== 'EADDRINUSE') throw error
    await listen(server, 0)
  }
  const address = server.address()
  await fsp.mkdir(userDataDir, { recursive: true })
  await fsp.writeFile(portFile, String(address.port), 'utf8')
  return { server, origin: `http://127.0.0.1:${address.port}`, nonce }
}

module.exports = { startLocalSite, NONCE_COOKIE, isApiPath, readCookie, stripNonceCookie, sanitizeResponseHeaders }
