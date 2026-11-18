'use strict'
// 桌面端 web 产物热更新（能力组 hotUpdate）。
//
// 前端有新版本时不重发安装包：主进程后台查最新的 desktop-webbundle → 下载 → 校验 sha256 → 解压到
// userData/appshell-webbundles/<版本>/ → 等页面点「启用」后切换本地站点的服务目录。
//
// 必须守住的三件事：
// 1. 热更包必须比安装包里烘进去的那版新：装了更新的安装包后旧热更包立刻作废。
// 2. 只接受同 appId、同环境、干净源码构建的包（包内 appshell-build.json），发错环境的包不会被装上。
// 3. 两阶段确认：切包后 confirmed=false，页面入口调 notifyReady（或 POST <前缀>/web-bundle-ready）才算确认；
//    连续两次冷启动没等到确认就回退内置产物。确认必须放在入口首次绘制后，不能放在登录后的页面里。

const crypto = require('node:crypto')
const fsp = require('node:fs/promises')
const https = require('node:https')
const path = require('node:path')
const zlib = require('node:zlib')

const MANIFEST_FILE = 'appshell-build.json'
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30_000
const MAX_BOOT_ATTEMPTS = 2

/** 按 "." 分段比数值；任何一段不是纯数字就判 false——宁可不更新，不拿脏数据切包。 */
function isNewerVersion(remote, local) {
  const parse = v => (typeof v === 'string' && v !== '' && v.split('.').every(p => /^\d+$/.test(p)) ? v.split('.').map(Number) : null)
  const a = parse(remote)
  const b = parse(local)
  if (!a || !b) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

async function readManifest(dir) {
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, MANIFEST_FILE), 'utf8'))
    return manifest && typeof manifest === 'object' ? manifest : null
  } catch {
    return null
  }
}

/** 目录能 serve（有 index.html），且清单与本应用、本环境一致、来自干净源码。 */
async function checkBundle(dir, { appId, environment }) {
  try {
    if (!(await fsp.stat(path.join(dir, 'index.html'))).isFile()) return '缺少 index.html'
  } catch {
    return '缺少 index.html'
  }
  const manifest = await readManifest(dir)
  if (!manifest) return `缺少 ${MANIFEST_FILE}`
  if (manifest.appId !== appId) return `appId 不符（包里是 ${manifest.appId}）`
  if (manifest.environment !== environment) return `环境不符（包里是 ${manifest.environment}）`
  if (manifest.sourceDirty !== false) return '来自未提交的源码'
  if (!/^\d+\.\d+\.\d+$/.test(manifest.webVersion ?? '')) return 'webVersion 不是三段数字'
  return null
}

async function readState(file) {
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', chunk => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location && redirects < 3) {
        res.resume()
        resolve(download(new URL(res.headers.location, url).toString(), redirects + 1))
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`下载返回 ${status}`))
        return
      }
      collect(res).then(resolve, reject)
    })
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('下载超时')))
    req.on('error', reject)
  })
}

async function fetchSha256(url, get = download) {
  try {
    const token = (await get(url)).toString('utf8').trim().split(/\s+/)[0] ?? ''
    return /^[0-9a-fA-F]{64}$/.test(token) ? token.toLowerCase() : null
  } catch {
    return null
  }
}

/** 契约：GET <apiTarget><apiPath><latestPath> 返回 protojson `{ version, url }`（缺省 = 空串 = 没有）。 */
function parseLatest(body) {
  let data
  try {
    data = JSON.parse(body.toString('utf8'))
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const field = key => (data[key] === undefined || data[key] === null ? '' : typeof data[key] === 'string' ? data[key] : null)
  const version = field('version')
  const url = field('url')
  if (!version || !url || !/^\d+\.\d+\.\d+$/.test(version)) return null
  return { version, url }
}

function fetchLatest({ apiTarget, apiPath, latestPath }) {
  const url = new URL(`${apiPath}${latestPath}`, apiTarget)
  return new Promise(resolve => {
    const req = https.get(url, res => {
      if (res.statusCode !== 200) {
        res.resume()
        resolve(null)
        return
      }
      collect(res).then(body => resolve(parseLatest(body)), () => resolve(null))
    })
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('检查更新超时')))
    req.on('error', () => resolve(null))
  })
}

/** 绝对地址只认 https（完整性靠旁挂 sha256，传输层不再降级）；相对路径拼到 API 源上。 */
function resolveBundleUrl(raw, apiTarget) {
  if (raw.startsWith('/')) return new URL(raw, apiTarget).toString()
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function readString(buffer, start, length) {
  const slice = buffer.subarray(start, start + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? length : end).toString('utf8').trim()
}

/**
 * 极简 ustar 解包（发布端用 `tar --format=ustar` 打包）。遇到长名扩展（GNU 'L' / pax 'x' 'g'）直接报错：
 * 静默跳过会得到一个缺文件的「成功」解压。条目越出目标目录也报错。
 */
async function extractTarGz(archive, destDir) {
  const tar = zlib.gunzipSync(archive)
  await fsp.rm(destDir, { recursive: true, force: true })
  await fsp.mkdir(destDir, { recursive: true })
  const root = path.resolve(destDir)
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const fullName = prefix ? `${prefix}/${name}` : name
    const size = Number.parseInt(readString(header, 124, 12) || '0', 8)
    const type = String.fromCharCode(header[156] ?? 0)
    offset += 512
    if (Number.isNaN(size) || size < 0 || offset + size > tar.length) throw new Error(`tar 条目损坏：${fullName}`)
    if (type === 'L' || type === 'x' || type === 'g') throw new Error(`tar 含不支持的扩展条目（${type}），发布端必须用 --format=ustar`)
    const out = path.resolve(destDir, fullName)
    if (out !== root && !out.startsWith(root + path.sep)) throw new Error(`非法 tar 条目：${fullName}`)
    if (type === '5') await fsp.mkdir(out, { recursive: true })
    else if (type === '0' || type === '\0') {
      await fsp.mkdir(path.dirname(out), { recursive: true })
      await fsp.writeFile(out, tar.subarray(offset, offset + size))
    }
    offset += Math.ceil(size / 512) * 512
  }
}

/**
 * @param {{ bakedRoot: string, userDataDir: string, appId: string, environment: string,
 *   apiTarget: string, apiPath: string, latestPath: string, log?: (msg: string) => void,
 *   fetchLatestImpl?: Function, downloadImpl?: Function }} options
 */
async function startWebBundleUpdater(options) {
  const { bakedRoot, userDataDir, appId, environment } = options
  const log = options.log ?? (msg => console.log(`[appshell] ${msg}`))
  const getLatest = options.fetchLatestImpl ?? (() => fetchLatest(options))
  const get = options.downloadImpl ?? download
  const bundlesDir = path.join(userDataDir, 'appshell-webbundles')
  const stateFile = path.join(bundlesDir, 'state.json')
  const baked = await readManifest(bakedRoot)
  const bakedVersion = baked && /^\d+\.\d+\.\d+$/.test(baked.webVersion ?? '') ? baked.webVersion : null

  let state = await readState(stateFile)
  let webRoot = bakedRoot
  let timer = null

  const persist = async () => {
    await fsp.mkdir(bundlesDir, { recursive: true })
    await fsp.writeFile(stateFile, JSON.stringify(state, null, 2))
  }
  const resetToBaked = async (badVersion = null) => {
    // installed 留着：它可能正是比内置产物更新、只是还没启用的包；
    // 但如果回退的原因是这个包本身坏了，就记下来，不再自动启用、也不再下载同一版本。
    const bad = new Set(state.bad ?? [])
    if (badVersion) bad.add(badVersion)
    const installed = state.installed && !bad.has(state.installed.version) ? state.installed : undefined
    state = { installed, bad: [...bad] }
    webRoot = bakedRoot
    await persist()
  }
  const isBad = version => (state.bad ?? []).includes(version)
  const pending = () => {
    const installed = state.installed
    if (!installed || isBad(installed.version)) return null
    const current = state.active?.version ?? bakedVersion
    if (current === null || !isNewerVersion(installed.version, current)) return null
    return installed
  }
  const prune = async () => {
    const keep = new Set([state.active?.path, state.installed?.path].filter(Boolean).map(p => path.resolve(p)))
    let entries = []
    try {
      entries = await fsp.readdir(bundlesDir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'state.json') continue
      const full = path.resolve(bundlesDir, entry)
      if (!keep.has(full)) await fsp.rm(full, { recursive: true, force: true }).catch(() => {})
    }
  }

  const checkOnce = async () => {
    const current = state.active?.version ?? bakedVersion
    if (current === null) return 'no-baseline'
    const latest = await getLatest()
    if (!latest || !isNewerVersion(latest.version, current)) return 'up-to-date'
    if (isBad(latest.version)) return 'known-bad'
    if (state.installed?.version === latest.version) return 'already-installed'
    const url = resolveBundleUrl(latest.url, options.apiTarget)
    if (!url) {
      log(`热更包地址不可用：${latest.url}`)
      return 'bad-url'
    }
    const expected = await fetchSha256(`${url}.sha256`, get)
    if (!expected) return 'no-checksum'
    const archive = await get(url)
    const actual = crypto.createHash('sha256').update(archive).digest('hex')
    if (actual !== expected) {
      log(`热更包 sha256 不匹配：期望 ${expected} 实际 ${actual}`)
      return 'checksum-mismatch'
    }
    const dir = path.join(bundlesDir, latest.version)
    await extractTarGz(archive, dir)
    const problem = await checkBundle(dir, { appId, environment })
    const manifest = problem ? null : await readManifest(dir)
    if (problem || manifest.webVersion !== latest.version) {
      log(`热更包 ${latest.version} 不可用：${problem ?? `清单版本是 ${manifest.webVersion}`}`)
      await fsp.rm(dir, { recursive: true, force: true })
      return 'rejected'
    }
    state.installed = { version: latest.version, path: dir }
    await persist()
    await prune()
    log(`热更包 ${latest.version} 已就绪，等待启用`)
    return 'installed'
  }

  // —— 自动启用：上次后台下载好的包，这次冷启动直接切过去（启动时不可能在录音）——
  if (options.apply === 'next-launch') {
    const ready = pending()
    if (ready && !(await checkBundle(ready.path, { appId, environment }))) {
      log(`自动启用热更包 ${ready.version}`)
      state.active = ready
      state.confirmed = false
      state.attempts = 0
      await persist()
    }
  }

  // —— 启动检查 ——
  const active = state.active
  if (active) {
    const problem = await checkBundle(active.path, { appId, environment })
    if (bakedVersion !== null && !isNewerVersion(active.version, bakedVersion)) {
      log(`安装包已带 ${bakedVersion}，弃用热更包 ${active.version}`)
      await resetToBaked()
    } else if (problem) {
      log(`热更包 ${active.version} 不可用（${problem}），回退内置产物`)
      await resetToBaked(active.version)
    } else if (!state.confirmed && (state.attempts ?? 0) + 1 >= MAX_BOOT_ATTEMPTS) {
      log(`热更包 ${active.version} 连续启动未确认，回退内置产物`)
      await resetToBaked(active.version)
    } else {
      if (!state.confirmed) {
        state.attempts = (state.attempts ?? 0) + 1
        await persist()
      }
      webRoot = active.path
    }
  }

  if (bakedVersion === null) {
    log(`内置产物没有 ${MANIFEST_FILE} 的 webVersion，不启用热更新`)
  } else if (options.poll !== false) {
    void checkOnce().catch(error => log(`检查热更新失败：${error.message}`))
    timer = setInterval(() => void checkOnce().catch(error => log(`检查热更新失败：${error.message}`)), CHECK_INTERVAL_MS)
    timer.unref()
  }

  return {
    currentWebRoot: () => webRoot,
    bakedVersion: () => bakedVersion,
    activeVersion: () => state.active?.version ?? bakedVersion,
    pending,
    checkNow: checkOnce,
    apply: async () => {
      const installed = pending()
      if (!installed) return false
      if (await checkBundle(installed.path, { appId, environment })) return false
      state.active = installed
      state.confirmed = false
      state.attempts = 0
      await persist()
      webRoot = installed.path
      return true
    },
    confirmReady: async () => {
      if (!state.active || state.confirmed) return
      state.confirmed = true
      state.attempts = 0
      await persist()
    },
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

module.exports = { startWebBundleUpdater, isNewerVersion, extractTarGz, parseLatest, resolveBundleUrl, checkBundle, MANIFEST_FILE }
