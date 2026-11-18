// 构建业务 Web 并写入外壳清单 appshell-build.json。
// 清单是原生侧（Gradle 校验、热更新契约）认包的唯一依据：appId + 环境 + 干净源码。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

import { run, fail } from './util.mjs'
import { webVersion } from './config.mjs'
import { operationContext } from './context.mjs'

export const MANIFEST_FILE = 'appshell-build.json'

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

export function sourceState(root) {
  let commit
  try {
    commit = git(root, 'rev-parse', 'HEAD')
  } catch {
    fail(`${root} 不是 git 仓库；外壳只打包可追溯的提交`)
  }
  return { commit, dirty: git(root, 'status', '--porcelain') !== '' }
}

/**
 * 构建 Web，返回 { dir, manifest }。dir 是产物目录，清单已写入其中。
 * 手机端用 config.web 与环境的 buildEnv；桌面端传 web / buildEnv 覆盖（同源网页版构建）。
 */
export function buildWeb(config, { platform, env, appId, build, allowDirty, web = config.web, buildEnv = env.buildEnv, appVersion = config.app.version }) {
  const before = sourceState(config.root)
  if (before.dirty && !allowDirty) {
    fail('Web 工作区有未提交改动。先提交再打包；调试包可加 --allow-dirty（清单会记为 dirty，热更新契约会拒收）')
  }
  const [command, ...args] = web.command
  run(command, args, {
    cwd: config.root,
    env: {
      ...process.env,
      ...buildEnv,
      APPSHELL_PLATFORM: platform,
      APPSHELL_ENV: env.name,
      APPSHELL_APP_ID: appId,
    },
  })
  const after = sourceState(config.root)
  if (after.commit !== before.commit) fail('构建期间 Web 提交发生了变化，产物来源不可信')
  if (!before.dirty && after.dirty) fail('构建过程改动了 Web 工作区（产物写进了受版本控制的目录？）')

  const dir = path.join(config.root, web.outDir)
  if (!fs.existsSync(path.join(dir, 'index.html'))) fail(`Web 构建后 ${web.outDir}/index.html 不存在`)
  fs.rmSync(path.join(dir, MANIFEST_FILE), { force: true })
  const manifest = {
    schemaVersion: 1,
    appId,
    platform,
    environment: env.name,
    webVersion: webVersion(config),
    app: { version: appVersion, build },
    sourceCommit: after.commit,
    sourceDirty: after.dirty,
    // Apollo 模式：公开配置来源（appId / namespace / releaseKey / 配置摘要），不含任何凭据信息
    ...(operationContext().provenance() ? { configSource: operationContext().provenance() } : {}),
    bundleSha256: digestDirectory(dir),
    builtAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
  return { dir, manifest }
}

/** 目录摘要：按相对路径排序，逐个文件 sha256。与打包方式无关，同内容同摘要。 */
export function digestDirectory(dir) {
  const hash = createHash('sha256')
  for (const relative of listFiles(dir)) {
    if (relative === MANIFEST_FILE) continue
    const content = fs.readFileSync(path.join(dir, relative))
    hash.update(relative.split(path.sep).join('/'))
    hash.update('\0')
    hash.update(createHash('sha256').update(content).digest('hex'))
    hash.update('\n')
  }
  return hash.digest('hex')
}

export function listFiles(dir, prefix = '') {
  const out = []
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(dir, relative))
    else if (entry.isFile()) out.push(relative)
    else fail(`Web 产物里不允许符号链接或特殊文件：${relative}`)
  }
  return out.sort()
}
