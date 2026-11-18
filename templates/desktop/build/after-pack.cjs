'use strict'
// electron-builder 的 afterPack 钩子（appshell 生成，不要手改）：
// 0. 正式包翻转 Electron 熔丝（build/fuses.json，Debug 包为 null）：关掉 --inspect 等调试入口。各平台都做，必须在签名之前；
// 以下只对 macOS：
// 1. 把各语言的权限弹窗文案写进 <语言>.lproj/InfoPlist.strings——TCC 弹窗按系统语言取，Info.plist 里那份只是兜底；
// 2. 没有配置签名证书时补一个 ad-hoc 签名：Apple Silicon 上完全没签名的可执行文件会被内核直接拒绝，
//    而且前两步刚改过二进制和 Resources，必须「先改、后签名」。
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

/** .strings 的转义只有反斜杠和双引号两条，顺序不能反。 */
function serializeStrings(entries) {
  return Object.entries(entries)
    .map(([key, value]) => `"${key}" = "${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}";\n`)
    .join('')
}

function writeUsageDescriptions(appPath, locales) {
  for (const [dir, entries] of Object.entries(locales)) {
    const lproj = path.join(appPath, 'Contents', 'Resources', `${dir}.lproj`)
    fs.mkdirSync(lproj, { recursive: true })
    const file = path.join(lproj, 'InfoPlist.strings')
    fs.writeFileSync(file, serializeStrings(entries), 'utf8')
    // 没有 BOM 的 .strings 历史上按 UTF-16 读；转成二进制 plist 没有歧义（Xcode 打包时也这么做）
    execFileSync('/usr/bin/plutil', ['-convert', 'binary1', file], { stdio: 'inherit' })
  }
}

/**
 * @electron/fuses treats any path containing ".app" as a macOS bundle and looks for
 * Contents/Frameworks/... — the generated project lives under ".appshell", so a Windows/Linux
 * binary path always matches. Flip those from inside the output directory so the path is just
 * "<name>.exe". macOS keeps the normal path (it really is a bundle).
 */
async function flipFuses(context, config) {
  if (context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas') {
    await context.packager.addElectronFuses(context, config)
    return
  }
  const cwd = process.cwd()
  process.chdir(context.appOutDir)
  try {
    await context.packager.addElectronFuses({ ...context, appOutDir: '.' }, config)
  } finally {
    process.chdir(cwd)
  }
}

module.exports = async function afterPack(context) {
  const fuses = JSON.parse(fs.readFileSync(path.join(__dirname, 'fuses.json'), 'utf8'))
  if (fuses) await flipFuses(context, await context.packager.generateFuseConfig(fuses))
  if (context.electronPlatformName !== 'darwin') return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const locales = JSON.parse(fs.readFileSync(path.join(__dirname, 'usage-locales.json'), 'utf8'))
  writeUsageDescriptions(appPath, locales)
  // 配了证书就交给 electron-builder 在后面正式签名
  if (context.packager.platformSpecificBuildOptions.identity !== null) return
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], { stdio: 'inherit' })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
}

module.exports.serializeStrings = serializeStrings
module.exports.flipFuses = flipFuses
