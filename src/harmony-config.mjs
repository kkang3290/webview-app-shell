// Harmony is opt-in; once enabled every platform field is explicit.
export const HARMONY_KEYS = ['bundleName', 'version', 'versionCode', 'targetSdkVersion', 'compatibleSdkVersion',
  'resources', 'web', 'environments', 'apiPrefixes', 'capabilities', 'permissions', 'toolchainEnv', 'signing', 'strings']

export function validateHarmony(config, fail, mode = 'file') {
  const h = config.harmony
  const obj = (v, w) => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(w, '必须是对象'); return v }
  const keys = (v, w, expected) => {
    obj(v, w)
    for (const k of Object.keys(v)) if (!expected.includes(k)) fail(`${w}.${k}`, '未知字段')
    for (const k of expected) if (!(k in v)) fail(`${w}.${k}`, '缺失')
  }
  const text = (v, w, re) => {
    if (typeof v !== 'string' || !v || v.trim() !== v || (re && !re.test(v))) fail(w, '格式不正确或为空')
  }
  const relative = (v, w) => {
    text(v, w)
    if (/^[\\/]|^[A-Za-z]:|[\x00-\x1f]/.test(v) || v.split(/[\\/]/).some(p => p === '..' || p === '.') || v.includes('\\')) fail(w, '必须是安全的仓库内相对路径')
    if (v === '.appshell' || v.startsWith('.appshell/')) fail(w, '不能指向生成目录 .appshell')
  }
  const subset = (values, w, global, supported) => {
    if (!Array.isArray(values) || new Set(values).size !== values.length) fail(w, '必须是无重复项的数组')
    for (const v of values) {
      if (!global.includes(v)) fail(w, `${v} 未在全局声明`)
      if (!supported.includes(v)) fail(w, `Harmony 尚未实现 ${v}`)
    }
  }
  // Apollo 模式：工具链与签名来自 _tools / _credentials，这两个指向本机的字段不允许出现
  keys(h, 'harmony', mode === 'apollo' ? HARMONY_KEYS.filter(k => k !== 'toolchainEnv' && k !== 'signing') : HARMONY_KEYS)
  text(h.bundleName, 'harmony.bundleName', /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
  text(h.version, 'harmony.version', /^\d+\.\d+\.\d+$/)
  if (!Number.isInteger(h.versionCode) || h.versionCode < 1 || h.versionCode > 2100000000) fail('harmony.versionCode', '必须是 1..2100000000 的整数')
  // This template uses SDK 26 ArkWeb and permission APIs. Do not imply untested older compatibility.
  if (h.targetSdkVersion !== '26.0.0') fail('harmony.targetSdkVersion', '当前模板只支持 26.0.0')
  if (h.compatibleSdkVersion !== '6.1.1(24)') fail('harmony.compatibleSdkVersion', '当前模板最低为 6.1.1(24)')
  relative(h.resources, 'harmony.resources')
  keys(h.web, 'harmony.web', ['command', 'outDir'])
  if (!Array.isArray(h.web.command) || !h.web.command.length) fail('harmony.web.command', '必须是非空命令数组')
  h.web.command.forEach((v, i) => text(v, `harmony.web.command[${i}]`))
  relative(h.web.outDir, 'harmony.web.outDir')
  keys(h.environments, 'harmony.environments', Object.keys(config.environments))
  for (const [name, env] of Object.entries(h.environments)) {
    const w = `harmony.environments.${name}`
    keys(env, w, ['siteOrigin', 'buildEnv'])
    text(env.siteOrigin, `${w}.siteOrigin`, /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/)
    let origin = null
    try { origin = new URL(env.siteOrigin).origin } catch { fail(`${w}.siteOrigin`, '无效 HTTPS origin') }
    if (origin !== env.siteOrigin) fail(`${w}.siteOrigin`, '必须是规范化的 HTTPS origin（小写主机名、无默认端口）')
    obj(env.buildEnv, `${w}.buildEnv`)
    for (const [k, v] of Object.entries(env.buildEnv)) {
      text(k, `${w}.buildEnv 键`, /^[A-Z][A-Z0-9_]*$/)
      if (k.startsWith('APPSHELL_')) fail(`${w}.buildEnv.${k}`, 'APPSHELL_ 前缀保留')
      text(v, `${w}.buildEnv.${k}`)
    }
  }
  if (!Array.isArray(h.apiPrefixes) || !h.apiPrefixes.length || new Set(h.apiPrefixes).size !== h.apiPrefixes.length) fail('harmony.apiPrefixes', '必须是非空无重复前缀数组')
  h.apiPrefixes.forEach((v, i) => text(v, `harmony.apiPrefixes[${i}]`, /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/))
  subset(h.capabilities, 'harmony.capabilities', config.capabilities, ['recording'])
  subset(h.permissions, 'harmony.permissions', config.permissions, ['microphone'])
  if (h.capabilities.includes('recording') && !h.permissions.includes('microphone')) fail('harmony.permissions', 'recording 需要 microphone')
  if (mode !== 'apollo') {
    text(h.toolchainEnv, 'harmony.toolchainEnv', /^[A-Z][A-Z0-9_]*$/)
    if (h.signing !== null) {
      keys(h.signing, 'harmony.signing', ['configEnv'])
      text(h.signing.configEnv, 'harmony.signing.configEnv', /^[A-Z][A-Z0-9_]*$/)
    }
  }
  keys(h.strings, 'harmony.strings', ['microphoneReason', 'errorTitle', 'retryLabel'])
  for (const [k, v] of Object.entries(h.strings)) text(v, `harmony.strings.${k}`)
}
