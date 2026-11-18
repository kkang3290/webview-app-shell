import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../bin/appshell.mjs', import.meta.url))
const example = fileURLToPath(new URL('../examples/basic/', import.meta.url))
function run(args) { return spawnSync(process.execPath, [cli, ...args], { cwd: example, encoding: 'utf8' }) }

test('CLI parses the public example without signing credentials or network access', () => {
  const result = run(['config', '--env', 'test'])
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.environment.name, 'test')
  assert.equal(output.android.applicationId, 'com.example.app')
  assert.equal(output.release, null)
})

test('CLI reports an undeclared environment without building', () => {
  const result = run(['config', '--env', 'undeclared'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /未知环境/)
})

test('CLI refuses artifact publishing before building when the adapter is disabled', () => {
  const result = run(['publish', 'android', '--env', 'test', '--kind', 'app', '--dry-run'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /release 为 null/)
})
