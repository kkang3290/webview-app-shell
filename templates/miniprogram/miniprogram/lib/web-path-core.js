// Shared by Node configuration/generation and the Mini Program runtime. No URL API required.
export function validateMiniProgramPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 8192) return false
  let decoded = value
  // Keep the original path boundary: an encoded ?/# must not hide encoded traversal.
  let pathname = value.split(/[?#]/, 1)[0]
  for (let depth = 0; depth < 16; depth += 1) {
    if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\u0000- \u007f-\u009f]/.test(decoded)) return false
    if (pathname.split('/').some(segment => segment === '.' || segment === '..')) return false
    if (!decoded.includes('%')) return true
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) return true
      decoded = next
      pathname = decodeURIComponent(pathname)
    } catch {
      return false
    }
  }
  return false
}

export function validateMiniProgramOrigin(value) {
  if (typeof value !== 'string') return false
  const match = /^https:\/\/([^/:?#@\\\s]+)(?::([0-9]{1,5}))?$/.exec(value)
  if (!match || match[1].length > 253) return false
  if (!match[1].split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return false
  return !match[2] || (Number(match[2]) >= 1 && Number(match[2]) <= 65535)
}

export function miniProgramWebUrl(siteOrigin, entryPath, incomingPath = undefined) {
  if (!validateMiniProgramOrigin(siteOrigin)) throw new Error('Invalid Mini Program siteOrigin')
  if (!validateMiniProgramPath(entryPath)) throw new Error('Invalid Mini Program entryPath')
  const selected = incomingPath === undefined ? entryPath : incomingPath
  if (!validateMiniProgramPath(selected)) throw new Error('Invalid Mini Program path')
  return siteOrigin + selected
}
