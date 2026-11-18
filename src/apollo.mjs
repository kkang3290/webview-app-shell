// Apollo ConfigService client: HTTPS, HMAC-SHA1 signature over "timestamp\npath",
// bounded response, no redirects. Errors never include configuration values or secrets.
import { createHmac } from 'node:crypto'

import { fail } from './util.mjs'

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const TIMEOUT_MS = 20_000

export function apolloPath(appId, cluster, namespace) {
  return `/configs/${encodeURIComponent(appId)}/${encodeURIComponent(cluster)}/${encodeURIComponent(namespace)}`
}

/** Authorization headers. A null secret produces an unsigned request (used only by `apollo verify`). */
export function apolloHeaders(appId, pathname, secret, now = Date.now()) {
  if (secret === null) return {}
  const timestamp = String(now)
  const signature = createHmac('sha1', secret).update(`${timestamp}\n${pathname}`).digest('base64')
  return { Timestamp: timestamp, Authorization: `Apollo ${appId}:${signature}` }
}

async function readBounded(response) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) fail('Apollo 响应过大')
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      fail('Apollo 响应过大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8')
}

/** Raw request; returns { status, configurations, releaseKey }. Callers decide which statuses are acceptable. */
export async function requestNamespace({ endpoint, appId, cluster, namespace, secret, fetchImpl = fetch, now }) {
  let base
  try { base = new URL(endpoint) } catch { fail(`Apollo 端点无效：${endpoint}`) }
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.username) fail(`Apollo 端点必须是 HTTPS origin：${endpoint}`)
  const pathname = apolloPath(appId, cluster, namespace)
  let response
  try {
    response = await fetchImpl(`${base.origin}${pathname}`, {
      method: 'GET', redirect: 'manual', headers: apolloHeaders(appId, pathname, secret, now),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    fail(`Apollo 连接失败：${appId}/${namespace}（${base.origin}）`)
  }
  if (response.status !== 200) {
    await response.body?.cancel?.().catch(() => {})
    return { status: response.status }
  }
  let body
  try { body = JSON.parse(await readBounded(response)) } catch (error) {
    if (error?.message === 'Apollo 响应过大') throw error
    fail(`Apollo 返回的不是 JSON：${appId}/${namespace}`)
  }
  if (!body || typeof body.releaseKey !== 'string' || !body.releaseKey || !body.configurations
    || typeof body.configurations !== 'object' || Array.isArray(body.configurations)) {
    fail(`Apollo 返回的发布内容无效：${appId}/${namespace}`)
  }
  for (const [key, value] of Object.entries(body.configurations)) {
    if (typeof value !== 'string') fail(`Apollo ${appId}/${namespace} 的配置项 ${key} 不是字符串`)
  }
  return { status: 200, configurations: body.configurations, releaseKey: body.releaseKey }
}

/** Fetch a published namespace or fail closed. Unpublished namespaces return 404 from ConfigService. */
export async function fetchNamespace(options) {
  const result = await requestNamespace(options)
  if (result.status === 401 || result.status === 403) fail(`Apollo 拒绝访问 ${options.appId}/${options.namespace}（HTTP ${result.status}）：检查该 appId 的 AccessKey`)
  if (result.status === 404) fail(`Apollo 没有已发布的 ${options.appId}/${options.namespace}（HTTP 404）：先在 Portal 发布`)
  if (result.status !== 200) fail(`Apollo 读取 ${options.appId}/${options.namespace} 失败（HTTP ${result.status}）`)
  return result
}
