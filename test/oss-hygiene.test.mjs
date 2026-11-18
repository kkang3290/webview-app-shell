import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ignored = new Set(['.git', 'node_modules'])
const textExtensions = new Set(['.cjs', '.ets', '.gradle', '.java', '.js', '.json', '.json5', '.kt', '.mjs', '.md', '.plist', '.pro', '.properties', '.rb', '.swift', '.ts', '.txt', '.xml'])

function filesUnder(dir) {
  const result = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.name === '.DS_Store') continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) result.push(...filesUnder(file))
    else if (textExtensions.has(path.extname(entry.name)) || entry.name === 'package.json') result.push(file)
  }
  return result
}

test('published source contains no organization-specific identifiers or private endpoints', () => {
  const forbidden = [
    ['edu', 'mind'].join(''),
    ['minute', 'x'].join(''),
    ['edu', 'mind', 'x'].join(''),
    ['dimension', '-', 'gate'].join(''),
    ['platform', 'ctl'].join(''),
    ['client', '-', 'bootstrap'].join(''),
  ]
  const findings = []
  for (const file of filesUnder(root)) {
    const text = fs.readFileSync(file, 'utf8').toLowerCase()
    for (const token of forbidden) {
      if (text.includes(token)) findings.push(`${path.relative(root, file)}: ${token}`)
    }
  }
  assert.deepEqual(findings, [])
})
