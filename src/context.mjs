// Operation context: the single place adapters get toolchains, signing material, upload keys and
// tokens from. File mode (appshell.config.json) keeps the historical env-var / local-file behaviour;
// Apollo mode (appshell.source.json) serves the same seams from Apollo and never falls back to env.
import fs from 'node:fs'
import path from 'node:path'

import { fail, log } from './util.mjs'
import { resolveToken } from './artifact.mjs'
import { ascKeyFromEnv } from './ios.mjs'
import { signingFromEnv } from './desktop.mjs'
import { miniProgramKeyFromEnv } from './miniprogram.mjs'
import { resolveToolchain, resolveSigning, validateToolchain } from './harmony.mjs'
import { materialize, javaPropertiesValue } from './credentials.mjs'

export function fileContext() {
  return {
    source: 'file',
    provenance: () => null,
    prepare: async () => {},
    harmonyToolchain: harmony => resolveToolchain(harmony),
    harmonySigning: harmony => resolveSigning(harmony),
    harmonySigningStatus: harmony => {
      if (harmony.signing === null) return 'Harmony 签名未配置（harmony.signing 为 null）：只能打 debug 未签名包'
      if (!process.env[harmony.signing.configEnv]) return `Harmony 签名：${harmony.signing.configEnv} 未设置，只能打 debug 未签名包；release / publish 会失败`
      return null
    },
    androidSigningProperties: (config, type) => {
      const configured = config.android.signing.propertiesFile
      if (!configured) {
        if (type === 'release') fail('release 包需要 android.signing.propertiesFile')
        return null
      }
      const file = path.resolve(config.root, configured)
      if (type === 'release' && !fs.existsSync(file)) fail(`签名配置不存在：${file}`)
      return file
    },
    ascKey: () => ascKeyFromEnv(),
    desktopSigning: () => ({ ...signingFromEnv(), ...(process.env.APPSHELL_MAC_KEYCHAIN ? { macKeychain: process.env.APPSHELL_MAC_KEYCHAIN } : {}) }),
    wechatKeyPath: () => miniProgramKeyFromEnv(),
    artifactToken: ({ tokenEnv }) => resolveToken({ tokenEnv }),
    cleanup: () => {},
  }
}

/**
 * tools / credentialRefs: the build config's `_tools` / `_credentials` objects.
 * loadCredential(name): async fetch + verify of one credential namespace. The CLI calls prepare()
 * for everything an operation needs before building, so accessors below are synchronous and a
 * missing / unauthorized / drifted credential fails before any build work starts.
 */
export function apolloContext({ provenance, tools, credentialRefs, loadCredential }) {
  const loaded = new Map()
  const cleanups = []
  const credential = name => {
    if (!credentialRefs[name]) return null
    if (!loaded.has(name)) fail(`内部错误：凭据 ${name} 没有预取`)
    return loaded.get(name)
  }
  const files = name => {
    const parsed = credential(name)
    if (!parsed) return null
    const written = materialize(parsed)
    cleanups.push(written.cleanup)
    return { ...parsed, paths: written.paths, dir: written.dir }
  }
  return {
    source: 'apollo',
    provenance: () => provenance,
    prepare: async names => {
      for (const name of names) {
        if (credentialRefs[name] && !loaded.has(name)) loaded.set(name, await loadCredential(name))
      }
    },
    harmonyToolchain: () => {
      if (!tools.harmony) fail('Apollo 构建配置的 _tools 里没有 harmony 工具链')
      return validateToolchain(tools.harmony, 'Apollo _tools.harmony')
    },
    harmonySigning: () => {
      const c = files('harmony')
      if (!c) fail('release HAP 需要签名：Apollo 构建配置的 _credentials 里没有 harmony')
      return { storeFile: c.paths.storeFile, certpath: c.paths.certpath, profile: c.paths.profile, ...c.fields }
    },
    harmonySigningStatus: () => credentialRefs.harmony ? null : 'Harmony 签名未在 Apollo _credentials 配置：只能打 debug 未签名包',
    androidSigningProperties: (config, type) => {
      if (type !== 'release') return null
      const c = files('android')
      if (!c) fail('release 包需要签名：Apollo 构建配置的 _credentials 里没有 android')
      const file = path.join(c.dir, 'signing.properties')
      const lines = { storeFile: c.paths.storeFile, ...c.fields }
      fs.writeFileSync(file, Object.entries(lines).map(([k, v]) => `${k}=${javaPropertiesValue(v)}`).join('\n') + '\n', { mode: 0o600 })
      return file
    },
    ascKey: () => {
      const c = files('appleAsc')
      return c ? { path: c.paths.p8, id: c.fields.keyId, issuer: c.fields.issuerId } : null
    },
    desktopSigning: () => {
      const desktop = tools.desktop ?? { macIdentity: null, macKeychain: null, winCertSha1: null }
      return {
        ...(desktop.macIdentity ? { macIdentity: desktop.macIdentity } : {}),
        ...(desktop.macKeychain ? { macKeychain: desktop.macKeychain } : {}),
        ...(desktop.winCertSha1 ? { winCertSha1: desktop.winCertSha1 } : {}),
      }
    },
    wechatKeyPath: () => {
      const c = files('wechat')
      if (!c) fail('微信上传需要密钥：Apollo 构建配置的 _credentials 里没有 wechat')
      return c.paths.privateKey
    },
    artifactToken: ({ tokenEnv }) => {
      const c = credential('artifact')
      if (!c) fail('发布需要 Apollo 构建配置的 _credentials.artifact；不会回退本地令牌')
      if (tokenEnv) log(`Artifact 令牌来自 Apollo（_credentials.artifact），忽略 --token-env ${tokenEnv}`)
      return c.fields.token
    },
    cleanup: () => { while (cleanups.length) cleanups.pop()() },
  }
}

let current = fileContext()

export function operationContext() {
  return current
}

/**
 * Install the context for one CLI operation; returns a restore function. Ctrl+C / SIGTERM also
 * remove materialized credentials before exiting (a hard kill is left to the runner's workspace reset).
 */
export function useContext(context) {
  const previous = current
  current = context
  const onSignal = signal => {
    try { context.cleanup() } finally { process.exit(signal === 'SIGINT' ? 130 : 143) }
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  return () => {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    try { context.cleanup() } finally { current = previous }
  }
}
