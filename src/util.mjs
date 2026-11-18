import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const TEMPLATES = path.join(PACKAGE_ROOT, 'templates')
const require = createRequire(import.meta.url)

export class AppShellError extends Error {}

export function fail(message) {
  throw new AppShellError(message)
}

export function log(message) {
  process.stderr.write(`appshell: ${message}\n`)
}

export function run(command, args, { cwd, env = process.env, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: capture ? 'utf8' : undefined,
  })
  if (result.error) fail(`无法启动 ${command}：${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${args.join(' ')} 失败（退出码 ${result.status}）`)
  return capture ? result.stdout : undefined
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export function writeSha256(file) {
  const line = `${sha256File(file)}  ${path.basename(file)}\n`
  fs.writeFileSync(`${file}.sha256`, line)
  return line.slice(0, 64)
}

export function copyDir(source, destination) {
  fs.mkdirSync(destination, { recursive: true })
  fs.cpSync(source, destination, { recursive: true, force: true, verbatimSymlinks: true })
}

/** 外壳自带的 Capacitor 包目录（随 webview-app-shell 锁版本，不用业务仓库自己的）。 */
export function capacitorPackage(name) {
  return path.dirname(require.resolve(`@capacitor/${name}/package.json`))
}

/**
 * 生成目录里放一份指向外壳自带 Capacitor 的 node_modules，cap CLI、Gradle、CocoaPods
 * 都按相对路径找它，不受业务仓库依赖树（可能装了别的 Capacitor 版本）影响。
 */
export function linkCapacitor(workDir) {
  // cap CLI 要求在 npm 包根目录运行，并从这里的 dependencies 识别平台包。
  const pkg = name => JSON.parse(fs.readFileSync(path.join(capacitorPackage(name), 'package.json'), 'utf8')).version
  fs.writeFileSync(path.join(workDir, 'package.json'), JSON.stringify({
    name: 'appshell-generated',
    private: true,
    description: '由 appshell 生成，随时可删',
    dependencies: Object.fromEntries(['core', 'android', 'ios'].map(name => [`@capacitor/${name}`, pkg(name)])),
    devDependencies: { '@capacitor/cli': pkg('cli') },
  }, null, 2) + '\n')
  const scope = path.join(workDir, 'node_modules', '@capacitor')
  fs.mkdirSync(scope, { recursive: true })
  for (const name of ['cli', 'core', 'android', 'ios']) {
    fs.symlinkSync(capacitorPackage(name), path.join(scope, name), 'dir')
  }
}

export function cap(workDir, args) {
  const cli = path.join(capacitorPackage('cli'), 'bin', 'capacitor')
  run(process.execPath, [cli, ...args], { cwd: workDir })
}

export function javaString(value) {
  return JSON.stringify(value)
}

export function xmlText(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, "\\'")
}

export function workDir(config, platform) {
  return path.join(config.root, '.appshell', platform)
}

export function outDir(config) {
  const dir = path.join(config.root, '.appshell', 'out')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function artifactName(config, kind, version, envName, suffix) {
  return `${config.app.name.replace(/[^A-Za-z0-9]+/g, '')}-${kind}-${version}-${envName}${suffix}`
}

/**
 * 找一个能 require "xcodeproj" 的 Ruby。Homebrew 的 CocoaPods 把 gem 装在自己的 GEM_HOME 里，
 * 系统 ruby 看不到，所以按 pod 包装脚本里的 GEM_HOME 与解释器再试一次。
 */
export function xcodeprojRuby() {
  const probe = (command, env) =>
    spawnSync(command, ['-e', 'require "xcodeproj"'], { stdio: 'ignore', env }).status === 0
  if (probe('ruby', process.env)) return { command: 'ruby', env: process.env }
  const which = spawnSync('which', ['pod'], { encoding: 'utf8' })
  const pod = which.status === 0 ? which.stdout.trim() : null
  const wrapper = pod ? fs.readFileSync(pod, 'utf8') : ''
  const match = wrapper.match(/GEM_HOME="([^"]+)" exec "([^"]+)"/)
  if (match) {
    const shebang = fs.readFileSync(match[2], 'utf8').split('\n')[0].replace(/^#!/, '').trim().split(/\s+/)
    const env = { ...process.env, GEM_HOME: match[1] }
    if (shebang.length === 1 && probe(shebang[0], env)) return { command: shebang[0], env }
  }
  fail('找不到带 xcodeproj gem 的 Ruby：安装 CocoaPods（brew install cocoapods）或 gem install xcodeproj')
}
