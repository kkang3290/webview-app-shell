// Where an operation's configuration comes from.
//
//   appshell.config.json  file mode (historical): everything in the repository file + local env/files.
//   appshell.source.json  Apollo mode: the repository only says where the config lives; the build
//                         config, toolchains and credentials are all published in Apollo.
//
// The two files are mutually exclusive. In Apollo mode nothing falls back to the repository file,
// environment variables or another environment: missing / unauthorized / unpublished / drifted
// configuration fails before any build work.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { CONFIG_FILE, ConfigError, parseConfig, environment, loadConfig } from './config.mjs'
import { fetchNamespace } from './apollo.mjs'
import { CREDENTIAL_TYPES, parseCredentialNamespace } from './credentials.mjs'
import { fileContext, apolloContext } from './context.mjs'

export const SOURCE_FILE = 'appshell.source.json'
export const LOCK_SCHEMA = 1
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const ENV_VAR = /^[A-Z][A-Z0-9_]*$/
const RESERVED = ['schemaVersion', '_tools', '_credentials']

function bad(where, message) {
  throw new ConfigError(`${where}: ${message}`)
}

function exact(value, keys, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad(where, '必须是对象')
  for (const key of Object.keys(value)) if (!keys.includes(key)) bad(`${where}.${key}`, `未知字段（允许：${keys.join(', ')}）`)
  for (const key of keys) if (!(key in value)) bad(`${where}.${key}`, '缺失')
  return value
}

/** Walk up from start; the first directory containing either file is the project root. */
export function findProject(start) {
  let dir = path.resolve(start)
  for (;;) {
    const hasConfig = fs.existsSync(path.join(dir, CONFIG_FILE))
    const hasSource = fs.existsSync(path.join(dir, SOURCE_FILE))
    if (hasConfig && hasSource) throw new ConfigError(`${dir} 同时有 ${CONFIG_FILE} 和 ${SOURCE_FILE}：两种配置来源只能选一个`)
    if (hasConfig) return { root: dir, mode: 'file' }
    if (hasSource) return { root: dir, mode: 'apollo' }
    const parent = path.dirname(dir)
    if (parent === dir) throw new ConfigError(`从 ${start} 向上找不到 ${CONFIG_FILE} 或 ${SOURCE_FILE}`)
    dir = parent
  }
}

export function parseSource(raw) {
  const where = SOURCE_FILE
  exact(raw, ['schemaVersion', 'source', 'appId', 'cluster', 'namespace', 'keyringFileEnv', 'environments'], where)
  if (raw.schemaVersion !== 1) bad(`${where}.schemaVersion`, '只支持 1')
  if (raw.source !== 'apollo') bad(`${where}.source`, '只支持 apollo')
  if (typeof raw.appId !== 'string' || !APP_ID.test(raw.appId)) bad(`${where}.appId`, 'Apollo appId 格式无效')
  if (typeof raw.cluster !== 'string' || !APP_ID.test(raw.cluster)) bad(`${where}.cluster`, 'Apollo cluster 格式无效')
  if (typeof raw.namespace !== 'string' || !NAMESPACE.test(raw.namespace)) bad(`${where}.namespace`, 'Apollo namespace 格式无效')
  if (typeof raw.keyringFileEnv !== 'string' || !ENV_VAR.test(raw.keyringFileEnv)) bad(`${where}.keyringFileEnv`, '环境变量名只含大写字母、数字、_')
  const environments = raw.environments
  if (!environments || typeof environments !== 'object' || Array.isArray(environments) || !Object.keys(environments).length) bad(`${where}.environments`, '至少一个环境')
  for (const [name, env] of Object.entries(environments)) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) bad(`${where}.environments`, `环境名 ${name} 无效`)
    exact(env, ['endpoint'], `${where}.environments.${name}`)
    let url
    try { url = new URL(env.endpoint) } catch { bad(`${where}.environments.${name}.endpoint`, '不是 URL') }
    if (url.protocol !== 'https:' || url.origin !== env.endpoint) bad(`${where}.environments.${name}.endpoint`, '必须是规范化的 HTTPS origin（Apollo ConfigService 地址）')
  }
  return Object.freeze(raw)
}

/**
 * Root of trust: one env var names a JSON file { "<appId>": "<AccessKey secret>" }. Read once; the
 * env var is then removed from this process so build subprocesses never see where the keys are.
 */
export function readKeyring(envName, env = process.env) {
  const file = env[envName]
  if (!file) return {}
  delete env[envName]
  if (!path.isAbsolute(file)) throw new ConfigError(`${envName} 必须是绝对路径`)
  let raw
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new ConfigError(`${envName} 指向的钥匙串不是可读的 JSON`) }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('Apollo 钥匙串必须是 { appId: secret } 对象')
  for (const [appId, secret] of Object.entries(raw)) {
    if (!APP_ID.test(appId) || typeof secret !== 'string' || !secret || /\s/.test(secret)) throw new ConfigError(`Apollo 钥匙串里 ${appId} 的条目无效`)
  }
  return raw
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  return JSON.stringify(value)
}

export function configurationsDigest(configurations) {
  return createHash('sha256').update(canonical(configurations)).digest('hex')
}

function parseJsonItem(configurations, key, where) {
  try { return JSON.parse(configurations[key]) } catch { bad(`${where} 的配置项 ${key}`, '必须是 JSON') }
}

export function parseTools(value) {
  const where = 'Apollo _tools'
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad(where, '必须是对象')
  for (const key of Object.keys(value)) if (!['harmony', 'desktop'].includes(key)) bad(`${where}.${key}`, '未知工具链（允许：harmony, desktop）')
  if (value.desktop !== undefined) {
    exact(value.desktop, ['macIdentity', 'macKeychain', 'winCertSha1'], `${where}.desktop`)
    for (const key of ['macIdentity', 'macKeychain', 'winCertSha1']) {
      const v = value.desktop[key]
      if (v !== null && (typeof v !== 'string' || !v.trim())) bad(`${where}.desktop.${key}`, '必须是非空字符串或 null')
    }
  }
  // _tools.harmony is validated against the filesystem when a Harmony build actually needs it.
  return Object.freeze(value)
}

export function parseCredentialRefs(value, buildAppId) {
  const where = 'Apollo _credentials'
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad(where, '必须是对象')
  for (const [name, ref] of Object.entries(value)) {
    if (!CREDENTIAL_TYPES[name]) bad(`${where}.${name}`, `未知凭据（允许：${Object.keys(CREDENTIAL_TYPES).join(', ')}）`)
    exact(ref, ['appId', 'namespace', 'version'], `${where}.${name}`)
    if (typeof ref.appId !== 'string' || !APP_ID.test(ref.appId)) bad(`${where}.${name}.appId`, 'Apollo appId 格式无效')
    // A dedicated build app may hold config and credentials in different namespaces. Its AccessKey
    // can read ALL of them: namespaces organize data, they are not a client-read isolation boundary.
    if (typeof ref.namespace !== 'string' || !NAMESPACE.test(ref.namespace)) bad(`${where}.${name}.namespace`, 'Apollo namespace 格式无效')
    if (typeof ref.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(ref.version)) bad(`${where}.${name}.version`, '格式无效')
  }
  return Object.freeze(value)
}

/** Build namespace items -> { raw appshell config, tools, credentialRefs }. One JSON item per top-level key. */
export function assembleBuildConfig(configurations, buildAppId) {
  const where = 'Apollo 构建配置'
  if (configurations.schemaVersion !== '1') bad(`${where}.schemaVersion`, '只支持 1')
  const raw = { schemaVersion: 1 }
  for (const key of Object.keys(configurations)) {
    if (RESERVED.includes(key)) continue
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) bad(where, `配置项名 ${key} 无效（每个顶层字段一项，值为 JSON）`)
    raw[key] = parseJsonItem(configurations, key, where)
  }
  for (const key of ['_tools', '_credentials']) if (!(key in configurations)) bad(`${where}.${key}`, '缺失（没有就写 {}）')
  const tools = parseTools(parseJsonItem(configurations, '_tools', where))
  const credentialRefs = parseCredentialRefs(parseJsonItem(configurations, '_credentials', where), buildAppId)
  return { raw, tools, credentialRefs }
}

function readLock(file, source, envName) {
  let lock
  try { lock = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new ConfigError(`锁文件 ${file} 不是可读的 JSON`) }
  exact(lock, ['schemaVersion', 'appId', 'cluster', 'namespace', 'endpoint', 'environment', 'releaseKey', 'digest', 'configurations'], '锁文件')
  if (lock.schemaVersion !== LOCK_SCHEMA) throw new ConfigError('锁文件 schemaVersion 不支持')
  const expected = { appId: source.appId, cluster: source.cluster, namespace: source.namespace, endpoint: source.environments[envName].endpoint, environment: envName }
  for (const [key, value] of Object.entries(expected)) {
    if (lock[key] !== value) throw new ConfigError(`锁文件的 ${key} 是 ${lock[key]}，当前是 ${value}：不是这个项目 / 环境的锁`)
  }
  if (configurationsDigest(lock.configurations) !== lock.digest) throw new ConfigError('锁文件内容与摘要不符（被改动过）')
  return lock
}

/**
 * Resolve one operation's configuration and context.
 * options: { envName, lockFile, fetchImpl, env } — env defaults to process.env (keyring var is consumed).
 */
export async function resolveProject(start, { envName, lockFile, fetchImpl, env = process.env } = {}) {
  const { root, mode } = findProject(start)
  if (mode === 'file') {
    if (lockFile) throw new ConfigError(`--lock 只用于 ${SOURCE_FILE}（Apollo 配置模式）`)
    const config = loadConfig(root)
    return { mode, config, env: envName ? environment(config, envName) : null, context: fileContext() }
  }
  let source
  try { source = parseSource(JSON.parse(fs.readFileSync(path.join(root, SOURCE_FILE), 'utf8'))) } catch (error) {
    if (error instanceof ConfigError) throw error
    throw new ConfigError(`${SOURCE_FILE} 不是合法 JSON`)
  }
  if (typeof envName !== 'string' || !envName) throw new ConfigError('Apollo 配置模式必须用 --env 指定环境')
  if (!source.environments[envName]) throw new ConfigError(`${SOURCE_FILE} 没有环境 ${envName}（有：${Object.keys(source.environments).join(', ')}）`)
  const endpoint = source.environments[envName].endpoint
  const keyring = readKeyring(source.keyringFileEnv, env)
  const secretFor = appId => {
    if (!keyring[appId]) throw new ConfigError(`Apollo 钥匙串（${source.keyringFileEnv}）里没有 ${appId} 的 AccessKey`)
    return keyring[appId]
  }
  let snapshot
  if (lockFile) {
    snapshot = readLock(lockFile, source, envName)
  } else {
    const fetched = await fetchNamespace({ endpoint, appId: source.appId, cluster: source.cluster, namespace: source.namespace, secret: secretFor(source.appId), fetchImpl })
    snapshot = { releaseKey: fetched.releaseKey, configurations: fetched.configurations, digest: configurationsDigest(fetched.configurations) }
  }
  const { raw, tools, credentialRefs } = assembleBuildConfig(snapshot.configurations, source.appId)
  const config = parseConfig(raw, root, { mode: 'apollo' })
  const provenance = Object.freeze({ source: 'apollo', appId: source.appId, cluster: source.cluster, namespace: source.namespace, releaseKey: snapshot.releaseKey, digest: snapshot.digest })
  const loadCredential = async name => {
    const ref = credentialRefs[name]
    const fetched = await fetchNamespace({ endpoint, appId: ref.appId, cluster: source.cluster, namespace: ref.namespace, secret: secretFor(ref.appId), fetchImpl })
    return parseCredentialNamespace(fetched.configurations, { where: `Apollo ${ref.appId}/${ref.namespace}`, expectedType: name, expectedVersion: ref.version })
  }
  return {
    mode, source, config, env: environment(config, envName), snapshot, endpoint,
    context: apolloContext({ provenance, tools, credentialRefs, loadCredential }),
  }
}

/** Public lock for CI: the frozen build namespace; credentials stay in separate namespaces, not in this lock. */
export function lockContents(resolved) {
  if (resolved.mode !== 'apollo') throw new ConfigError(`锁文件只用于 ${SOURCE_FILE}（Apollo 配置模式）`)
  const { source, snapshot, env } = resolved
  return {
    schemaVersion: LOCK_SCHEMA, appId: source.appId, cluster: source.cluster, namespace: source.namespace,
    endpoint: resolved.endpoint, environment: env.name, releaseKey: snapshot.releaseKey, digest: snapshot.digest,
    configurations: snapshot.configurations,
  }
}

/** Credentials each command needs; prefetched (and version-checked) before any build work. */
export function credentialsFor(command, platform, { type, kind, dryRun }) {
  const upload = dryRun ? [] : ['artifact']
  if (command === 'publish') {
    if (platform === 'miniprogram') return dryRun ? [] : ['wechat']
    if (platform === 'ios') return ['appleAsc']
    if (kind === 'webbundle') return upload
    if (platform === 'harmony') return ['harmony', ...upload]
    if (platform === 'android') return ['android', ...upload]
    if (platform === 'desktop') return ['appleAsc', ...upload]
    return upload
  }
  if (command === 'build' && type === 'release') {
    return { harmony: ['harmony'], android: ['android'], ios: ['appleAsc'], desktop: ['appleAsc'] }[platform] ?? []
  }
  return []
}
