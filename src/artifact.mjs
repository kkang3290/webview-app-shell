// 可选 Artifact Service 客户端。建版本（已存在则复用）→ 逐个文件上传（同目标已就绪且 SHA-256
// 相同则跳过，不同直接报错）→ 发布（不可变）→ 绑定环境的 stable 渠道 → 回读 latest 与 .sha256 校验。
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { fail, log } from './util.mjs'

export class ArtifactHttpError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

const CONTENT_TYPES = {
  apk: 'application/vnd.android.package-archive',
  aab: 'application/octet-stream',
  ipa: 'application/octet-stream',
  hap: 'application/octet-stream',
  zip: 'application/zip',
  dmg: 'application/x-apple-diskimage',
  exe: 'application/vnd.microsoft.portable-executable',
  tgz: 'application/gzip',
  'tar.gz': 'application/gzip',
  json: 'application/json',
  sig: 'application/octet-stream',
}

export function contentType(format) {
  const type = CONTENT_TYPES[format]
  if (!type) fail(`不认识的制品格式 ${format}（支持 ${Object.keys(CONTENT_TYPES).join(' / ')}）`)
  return type
}

/** 发布令牌必须通过 --token-env 显式指定；不读取其他工具的登录状态。 */
export function resolveToken({ tokenEnv } = {}) {
  if (!tokenEnv) fail('发布需要 --token-env <变量名> 指定令牌来源')
  const value = process.env[tokenEnv]?.trim()
  if (!value) fail(`--token-env ${tokenEnv}：环境变量为空`)
  return value
}

export function fileSha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export function createClient(baseUrl, token, fetchImpl = fetch) {
  let origin
  try { origin = new URL(baseUrl) } catch { fail('Artifact Service 必须是合法 HTTPS origin') }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    fail('Artifact Service 必须是 HTTPS origin，不能包含凭据、路径、查询或片段')
  }
  const base = origin.origin
  async function request(requestPath, { method = 'GET', body } = {}) {
    const response = await fetchImpl(`${base}${requestPath}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && ('error' in payload || 'message' in payload)
        ? JSON.stringify(payload) : `HTTP ${response.status}`
      throw new ArtifactHttpError(`Artifact Service ${method} ${requestPath}：${detail}`, response.status)
    }
    return payload
  }
  return { request, fetch: fetchImpl }
}

const enc = encodeURIComponent

async function ensureRelease(client, project, version, notes) {
  try {
    return (await client.request(`/api/v1/projects/${enc(project)}/releases`, { method: 'POST', body: { version, notes } })).item
  } catch (error) {
    if (!(error instanceof ArtifactHttpError) || error.status !== 409) throw error
    return (await client.request(`/api/v1/projects/${enc(project)}/releases/${enc(version)}`)).item
  }
}

async function ensureUpload(client, project, release, file) {
  const sha256 = fileSha256(file.file)
  const existing = release.artifacts?.find(a =>
    a.platform === file.platform && a.architecture === file.architecture && a.format === file.format)
  if (existing?.status === 'ready') {
    if (existing.sha256 !== sha256) fail(`${release.version} 里 ${file.platform}/${file.architecture}/${file.format} 已存在但 SHA-256 不同；版本不可变，换一个版本号`)
    log(`  已存在，跳过：${path.basename(file.file)}`)
    return release
  }
  if (release.status !== 'draft') fail(`${release.version} 已发布，不能再补文件；换一个版本号`)
  if (existing?.uploadId) await client.request(`/api/v1/uploads/${enc(existing.uploadId)}`, { method: 'DELETE' })

  const ticket = (await client.request(`/api/v1/projects/${enc(project)}/releases/${enc(release.version)}/artifacts`, {
    method: 'POST',
    body: {
      platform: file.platform,
      architecture: file.architecture,
      format: file.format,
      fileName: path.basename(file.file),
      contentType: contentType(file.format),
      sizeBytes: fs.statSync(file.file).size,
      sha256,
    },
  })).item
  log(`  上传 ${path.basename(file.file)}（${(fs.statSync(file.file).size / 1048576).toFixed(1)} MB）`)
  const upload = await client.fetch(ticket.url, { method: ticket.method, headers: ticket.headers, body: fs.readFileSync(file.file) })
  if (!upload.ok) throw new ArtifactHttpError(`上传 ${path.basename(file.file)} 失败：HTTP ${upload.status}`, upload.status)
  await client.request(`/api/v1/uploads/${enc(ticket.uploadId)}/complete`, { method: 'POST', body: {} })
  return (await client.request(`/api/v1/projects/${enc(project)}/releases/${enc(release.version)}`)).item
}

async function verifyLatest(client, project, environment, version, file) {
  const query = new URLSearchParams({ environment, channel: 'stable', platform: file.platform, architecture: file.architecture, format: file.format })
  const payload = await client.request(`/v1/projects/${enc(project)}/latest?${query}`)
  const resolved = payload.item?.artifacts?.[0]
  const expected = fileSha256(file.file)
  if (payload.item?.version !== version || payload.item.artifacts.length !== 1 || resolved?.sha256 !== expected || !resolved.downloadUrl) {
    fail(`发布后回读不一致：${environment}/stable/${file.platform}/${file.architecture}/${file.format} 解析到 ${payload.item?.version ?? '无'}`)
  }
  const checksum = await client.fetch(`${resolved.downloadUrl}.sha256`)
  if (!checksum.ok || (await checksum.text()) !== `${expected}  ${path.basename(file.file)}\n`) {
    fail(`发布后校验文件不一致：${path.basename(file.file)}`)
  }
  return resolved.downloadUrl
}

/**
 * 发布一个不可变版本（可含多份文件），并把 environment 的 stable 渠道指向它。
 * files: [{ file, platform, architecture, format }]
 */
export async function publishRelease(client, { project, version, environment, notes, files, candidate = false }) {
  if (!files.length) fail('没有要发布的文件')
  for (const f of files) {
    if (!fs.existsSync(f.file) || !fs.statSync(f.file).isFile()) fail(`找不到文件 ${f.file}`)
    contentType(f.format)
  }
  let release = await ensureRelease(client, project, version, notes)
  if (release.status === 'yanked') fail(`${project}/${version} 已撤回，换一个版本号`)
  for (const f of files) release = await ensureUpload(client, project, release, f)
  if (release.status === 'draft') {
    release = (await client.request(`/api/v1/projects/${enc(project)}/releases/${enc(version)}/publish`, { method: 'POST', body: {} })).item
  }
  if (candidate) {
    // 只上传为候选：版本已不可变，但不改环境的线上版本，由使用者在配置的服务中设为线上版本。
    log(`已上传候选版本 ${project}/${version}（未上线）：请在配置的制品服务中将 ${environment} 指向此版本`)
    return []
  }
  const urls = []
  for (const f of files) {
    await client.request(`/api/v1/projects/${enc(project)}/channels/stable`, {
      method: 'PUT', body: { environment, version, platform: f.platform, architecture: f.architecture },
    })
    urls.push({ ...f, downloadUrl: await verifyLatest(client, project, environment, version, f) })
  }
  log(`已发布 ${project}/${version} → ${environment}/stable`)
  for (const u of urls) log(`  ${u.platform}/${u.architecture}/${u.format}：${u.downloadUrl}`)
  return urls
}
