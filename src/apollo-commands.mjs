// `appshell apollo verify` and `appshell credentials pack`.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

import { AppShellError, log } from './util.mjs'
import { requestNamespace } from './apollo.mjs'
import { findProject, parseSource, readKeyring, assembleBuildConfig, SOURCE_FILE } from './source.mjs'
import { packCredential, toPropertiesText, CREDENTIAL_TYPES } from './credentials.mjs'

/**
 * Before importing any key material, prove that ConfigService enforces client auth for every app
 * involved: the right key reads, no signature / a wrong key / another app's key are all rejected.
 * Creating an AccessKey in Portal is not evidence of enforcement.
 */
export async function verifyApollo(positionals, values, { fetchImpl, env = process.env, out = process.stdout } = {}) {
  if (positionals[0] !== 'verify') throw new AppShellError('用法：appshell apollo verify --env <环境>')
  const { root, mode } = findProject(process.cwd())
  if (mode !== 'apollo') throw new AppShellError(`apollo verify 只用于 ${SOURCE_FILE}（Apollo 配置模式）`)
  const source = parseSource(JSON.parse(fs.readFileSync(path.join(root, SOURCE_FILE), 'utf8')))
  if (!values.env || !source.environments[values.env]) throw new AppShellError(`需要 --env（${Object.keys(source.environments).join(' / ')}）`)
  const endpoint = source.environments[values.env].endpoint
  const keyring = readKeyring(source.keyringFileEnv, env)
  if (!keyring[source.appId]) throw new AppShellError(`钥匙串里没有构建配置 ${source.appId} 的 AccessKey`)
  const ask = (appId, namespace, secret) => requestNamespace({ endpoint, appId, cluster: source.cluster, namespace, secret, fetchImpl })
  const build = await ask(source.appId, source.namespace, keyring[source.appId])
  if (build.status !== 200) throw new AppShellError(`用正确的 AccessKey 读取 ${source.appId}/${source.namespace} 失败（HTTP ${build.status}）`)
  const { credentialRefs } = assembleBuildConfig(build.configurations, source.appId)
  const targets = [...new Map([{ appId: source.appId, namespace: source.namespace },
    ...Object.values(credentialRefs).map(ref => ({ appId: ref.appId, namespace: ref.namespace }))]
    .map(ref => [`${ref.appId}/${ref.namespace}`, ref])).values()]
  const rows = []
  if (Object.values(credentialRefs).some(ref => ref.appId === source.appId)) {
    rows.push(`注意：${source.appId} 的 AccessKey 可读取该应用全部 namespace；同应用配置/签名材料不具备读取权限隔离。`)
  }
  let ok = true
  for (const { appId, namespace } of targets) {
    const own = keyring[appId]
    const checks = [
      ['正确签名可读', own ? (await ask(appId, namespace, own)).status : null, s => s === 200],
      ['无签名被拒', (await ask(appId, namespace, null)).status, s => s === 401],
      ['错误密钥被拒', (await ask(appId, namespace, randomBytes(16).toString('hex'))).status, s => s === 401],
    ]
    if (appId !== source.appId) checks.push(['构建配置的密钥读不了它', (await ask(appId, namespace, keyring[source.appId])).status, s => s === 401])
    for (const [name, status, pass] of checks) {
      const passed = status !== null && pass(status)
      if (!passed) ok = false
      rows.push(`${passed ? '✓' : '✗'} ${appId}/${namespace} ${name}${status === null ? '（钥匙串里没有这个 appId 的密钥，未检查）' : `（HTTP ${status}）`}`)
    }
  }
  out.write(rows.join('\n') + '\n')
  if (!ok) out.write('有检查未通过：在 ConfigService 强制鉴权之前，不要把签名材料导入 Apollo。\n')
  return ok ? 0 : 1
}

/**
 * Input JSON (local, contains passwords — delete after packing):
 *   { "version": "harmony-debug-2026-11", "files": { "storeFile": "/abs/app.p12", ... }, "fields": { "keyAlias": "...", ... } }
 * Output: Apollo properties text, written with mode 0600; refuses to overwrite. Values are never printed.
 */
export function packCredentialsCommand(positionals, values, { out = process.stdout } = {}) {
  if (positionals[0] !== 'pack') throw new AppShellError('用法：appshell credentials pack --type <类型> --input <JSON> --out <文件>')
  if (!values.type || !CREDENTIAL_TYPES[values.type]) throw new AppShellError(`--type 必须是 ${Object.keys(CREDENTIAL_TYPES).join(' / ')}`)
  if (!values.input || !values.out) throw new AppShellError('需要 --input <JSON> 与 --out <文件>')
  let input
  try { input = JSON.parse(fs.readFileSync(values.input, 'utf8')) } catch { throw new AppShellError('--input 不是可读的 JSON') }
  const items = packCredential({ type: values.type, version: input.version, files: input.files ?? {}, fields: input.fields ?? {} })
  fs.writeFileSync(values.out, toPropertiesText(items), { mode: 0o600, flag: 'wx' })
  const spec = CREDENTIAL_TYPES[values.type]
  const summary = Object.keys(spec.files).map(name => `${name} ${items[`file.${name}.bytes`]} 字节 / ${items[`file.${name}.chunks`]} 片`)
  out.write(`已写出 ${values.out}（${Object.keys(items).length} 项，${summary.join('，') || '无文件'}；字段：${spec.fields.join(', ') || '无'}）\n`)
  log('在 Apollo Portal 对应 appId 新建 properties namespace，用「文本」模式粘贴后发布；之后删除 --input 文件与这份输出')
  return 0
}
