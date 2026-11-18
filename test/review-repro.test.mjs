import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '../src/artifact.mjs'
const require = createRequire(import.meta.url)
const { startLocalSite } = require('../templates/desktop/lib/site.js')

// Confirmed review findings, not silently treated as fixed regressions.
test('static serving refuses a symlink that escapes the packaged web root', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appshell-audit-'))
  const web = path.join(dir, 'web')
  fs.mkdirSync(web)
  fs.writeFileSync(path.join(web, 'index.html'), 'fixture')
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'outside-web-root')
  fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(web, 'linked.txt'))
  const site = await startLocalSite({ webRoot: () => web, apiPath: '/api', apiTarget: 'https://api.example.com', userDataDir: path.join(dir, 'data') })
  try {
    const response = await fetch(`${site.origin}/linked.txt`, { headers: { Cookie: `appshell_site_nonce=${site.nonce}` } })
    assert.notEqual(await response.text(), 'outside-web-root')
  } finally {
    await new Promise(resolve => site.server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('artifact publishing rejects cleartext origins before dispatching credentials', async () => {
  let dispatched = false
  await assert.rejects(async () => {
    const client = createClient('http://artifacts.example.com', 'fixture-token', async () => {
      dispatched = true
      return new Response('{"item":{}}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    await client.request('/api/v1/projects/example/releases')
  }, /HTTPS|https/)
  assert.equal(dispatched, false)
})
