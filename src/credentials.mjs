// Signing / upload credentials stored in a dedicated build Apollo app (separate properties namespaces).
//
// Item layout (strict, no unknown keys):
//   schemaVersion = 1
//   type          = harmony | android | appleAsc | wechat | artifact
//   version       = operator-chosen version string; must equal the version the build config expects
//   field.<name>  = single-line text value (passwords, aliases, ids, tokens)
//   file.<name>.bytes / file.<name>.sha256 / file.<name>.chunks = decoded size, SHA-256, chunk count
//   file.<name>.<i> = base64 chunk i (each <= CHUNK_CHARS so it fits Apollo's per-item limit)
//
// Values are kept in memory; files are written only by materialize(), into a private temp dir
// outside the checkout, and removed by cleanup().
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { fail } from './util.mjs'

export const CHUNK_CHARS = 19_000
const MAX_FILE_BYTES = 1024 * 1024
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SIGN_ALGS = ['SHA256withECDSA', 'SHA384withECDSA', 'SHA256withRSA', 'SHA384withRSA']

/** Required files / fields per credential type. File names double as the materialized file names. */
export const CREDENTIAL_TYPES = {
  harmony: { files: { storeFile: 'app.p12', certpath: 'app.cer', profile: 'app.p7b' }, fields: ['storePassword', 'keyPassword', 'keyAlias', 'signAlg'] },
  android: { files: { storeFile: 'release.keystore' }, fields: ['storePassword', 'keyAlias', 'keyPassword'] },
  appleAsc: { files: { p8: 'AuthKey.p8' }, fields: ['keyId', 'issuerId'] },
  wechat: { files: { privateKey: 'private.key' }, fields: [] },
  artifact: { files: {}, fields: ['token'] },
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function field(value, where) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\r\n\0]/.test(value)) fail(`${where} 必须是非空单行文本，且无首尾空白`)
  return value
}

/** Parse and verify a credential namespace. Returns { type, version, fields, files: {name: Buffer} }. */
export function parseCredentialNamespace(configurations, { where, expectedType, expectedVersion }) {
  const items = { ...configurations }
  const take = key => {
    if (!(key in items)) fail(`${where}: 缺少 ${key}`)
    const value = items[key]
    delete items[key]
    return value
  }
  if (take('schemaVersion') !== '1') fail(`${where}: schemaVersion 只支持 1`)
  const type = take('type')
  if (type !== expectedType) fail(`${where}: type 是 ${type}，期望 ${expectedType}`)
  const version = take('version')
  if (!VERSION.test(version)) fail(`${where}: version 格式无效`)
  if (version !== expectedVersion) fail(`${where}: 发布的 version 是 ${version}，构建配置期望 ${expectedVersion}（Apollo 在流水线期间被改动，或配置未同步）`)
  const spec = CREDENTIAL_TYPES[type]
  const fields = {}
  for (const name of spec.fields) fields[name] = field(take(`field.${name}`), `${where}: field.${name}`)
  if ('signAlg' in fields && !SIGN_ALGS.includes(fields.signAlg)) fail(`${where}: signAlg 只能是 ${SIGN_ALGS.join(' / ')}`)
  const files = {}
  for (const name of Object.keys(spec.files)) {
    const bytes = Number(take(`file.${name}.bytes`))
    const digest = take(`file.${name}.sha256`)
    const count = Number(take(`file.${name}.chunks`))
    if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_FILE_BYTES) fail(`${where}: file.${name}.bytes 无效`)
    if (!/^[0-9a-f]{64}$/.test(digest)) fail(`${where}: file.${name}.sha256 无效`)
    if (!Number.isInteger(count) || count < 1 || count > Math.ceil((MAX_FILE_BYTES * 4) / 3 / CHUNK_CHARS) + 1) fail(`${where}: file.${name}.chunks 无效`)
    let encoded = ''
    for (let i = 0; i < count; i++) {
      const chunk = take(`file.${name}.${i}`)
      if (!/^[A-Za-z0-9+/=]+$/.test(chunk) || chunk.length > CHUNK_CHARS) fail(`${where}: file.${name}.${i} 不是合法的 base64 分片`)
      encoded += chunk
    }
    const buffer = Buffer.from(encoded, 'base64')
    if (buffer.toString('base64') !== encoded) fail(`${where}: file.${name} 的 base64 内容不规范`)
    if (buffer.length !== bytes || sha256(buffer) !== digest) fail(`${where}: file.${name} 的大小或 SHA-256 与清单不符（分片缺失或损坏）`)
    files[name] = buffer
  }
  const unknown = Object.keys(items)
  if (unknown.length) fail(`${where}: 未知配置项 ${unknown.slice(0, 5).join(', ')}`)
  return { type, version, fields, files }
}

/** Write a parsed credential's files into a fresh private directory. Returns { dir, paths, cleanup }. */
export function materialize(credential) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `appshell-${credential.type}-`))
  fs.chmodSync(dir, 0o700)
  const paths = {}
  try {
    for (const [name, buffer] of Object.entries(credential.files)) {
      const file = path.join(dir, CREDENTIAL_TYPES[credential.type].files[name])
      fs.writeFileSync(file, buffer, { mode: 0o600, flag: 'wx' })
      paths[name] = file
    }
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return { dir, paths, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** Build the Apollo items for a credential from local files (used by `appshell credentials pack`). */
export function packCredential({ type, version, files, fields }) {
  const spec = CREDENTIAL_TYPES[type]
  if (!spec) fail(`未知凭据类型 ${type}（可选：${Object.keys(CREDENTIAL_TYPES).join(', ')}）`)
  if (!VERSION.test(version ?? '')) fail('version 必须是 1-64 位字母、数字、._-')
  const items = { schemaVersion: '1', type, version }
  for (const key of Object.keys(fields ?? {})) if (!spec.fields.includes(key)) fail(`${type} 不需要字段 ${key}`)
  for (const name of spec.fields) items[`field.${name}`] = field(fields?.[name], `fields.${name}`)
  if ('field.signAlg' in items && !SIGN_ALGS.includes(items['field.signAlg'])) fail(`signAlg 只能是 ${SIGN_ALGS.join(' / ')}`)
  for (const key of Object.keys(files ?? {})) if (!(key in spec.files)) fail(`${type} 不需要文件 ${key}`)
  for (const name of Object.keys(spec.files)) {
    const file = files?.[name]
    if (typeof file !== 'string' || !path.isAbsolute(file)) fail(`files.${name} 必须是绝对路径`)
    const stat = fs.lstatSync(file, { throwIfNoEntry: false })
    if (!stat?.isFile()) fail(`files.${name} 必须是存在的普通文件：${file}`)
    const buffer = fs.readFileSync(file)
    if (buffer.length < 1 || buffer.length > MAX_FILE_BYTES) fail(`files.${name} 大小必须在 1 字节到 1 MiB 之间`)
    const encoded = buffer.toString('base64')
    const chunks = Math.ceil(encoded.length / CHUNK_CHARS)
    items[`file.${name}.bytes`] = String(buffer.length)
    items[`file.${name}.sha256`] = sha256(buffer)
    items[`file.${name}.chunks`] = String(chunks)
    for (let i = 0; i < chunks; i++) items[`file.${name}.${i}`] = encoded.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS)
  }
  return items
}

/** Apollo Portal "text" editing format for properties namespaces: one `key = value` per line. */
export function toPropertiesText(items) {
  return Object.entries(items).map(([key, value]) => `${key} = ${value}`).join('\n') + '\n'
}

/** Java .properties escaping for values written for Gradle (backslash, separators, leading space, non-ASCII). */
export function javaPropertiesValue(value) {
  return value.replace(/\\/g, '\\\\').replace(/^ /, '\\ ').replace(/[=:#!]/g, ch => `\\${ch}`)
    .replace(/[^\x20-\x7e]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
