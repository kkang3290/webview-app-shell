import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseConfig } from '../src/config.mjs'
import { resolveToken } from '../src/artifact.mjs'
import { apolloContext } from '../src/context.mjs'
import { publish } from '../src/publish.mjs'

// A normal local build must not require a proprietary publishing service.
const fixture = {
  schemaVersion: 1, engine: 'webview', app: { name: 'ExampleApp', version: '1.0.0' },
  web: { command: ['npm', 'run', 'build'], outDir: 'dist', version: { packageJson: 'package.json' } },
  environments: { test: { buildEnv: {}, artifactEnvironment: 'test', desktop: null } },
  capabilities: [], permissions: [],
  navigation: { nativeBackEvent: 'appshell:back', rootPages: [{ path: '/', childQuery: [] }], shortcuts: [] },
  theme: { startupBackground: '#FFFFFF', startupInk: '#111111', startupActive: '#3366CC', legacyNavigationBar: '#FFFFFF' },
  strings: { backAgainToDesktop: 'Press back again to leave' },
  wechat: null, push: null, screenCapture: null,
  android: { applicationId: 'com.example.app', versionCode: 1, storageDir: 'ExampleApp', resources: 'resources/android', nativeHttp: false, signing: { propertiesFile: null }, hotUpdate: null, legacyActivities: [], extension: null },
  ios: { bundleId: 'com.example.app', version: '1.0.0', buildNumber: 1, deploymentTarget: '17.0', deviceFamily: '1,2', teamId: null, resources: 'resources/ios', nativeHttp: false, backgroundRecording: false, pullToRefresh: { enabled: false, blockSelector: null }, usageDescriptions: {}, extension: null, hotUpdate: null },
  desktop: null, release: null,
}

test('artifact publishing with release: null fails before invoking any build', async () => {
  await assert.rejects(publish(structuredClone(fixture), { name: 'test', artifactEnvironment: 'test' }, {
    platform: 'android', kind: 'app', dryRun: true,
  }), /release.*Artifact/)
})

test('local webview configuration accepts release: null', () => {
  const config = parseConfig(structuredClone(fixture), '/example')
  assert.equal(config.android.applicationId, 'com.example.app')
  assert.equal(config.release, null)
})

test('a configured release adapter still requires an explicit HTTPS service and project', () => {
  const raw = structuredClone(fixture)
  raw.release = { artifactService: 'http://artifacts.example.com', artifactProject: 'example-app' }
  assert.throws(() => parseConfig(raw, '/example'), /release.artifactService/)
  raw.release.artifactService = 'https://artifacts.example.com'
  assert.equal(parseConfig(raw, '/example').release.artifactProject, 'example-app')
})

test('the public example is a complete parseable build configuration without a release service', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../examples/basic/appshell.config.json', import.meta.url), 'utf8'))
  assert.equal(parseConfig(raw, '/example').release, null)
})

test('publishing requires an explicitly selected token environment variable', () => {
  assert.throws(() => resolveToken(), /--token-env/)
})

test('token lookup reads only the explicitly selected environment variable', () => {
  process.env.APPSHELL_TEST_TOKEN = ' test-token '
  try { assert.equal(resolveToken({ tokenEnv: 'APPSHELL_TEST_TOKEN' }), 'test-token') }
  finally { delete process.env.APPSHELL_TEST_TOKEN }
  assert.throws(() => resolveToken({ tokenEnv: 'APPSHELL_TEST_TOKEN' }), /环境变量为空/)
})

test('Apollo publishing never falls back to local token environment variables', () => {
  process.env.APPSHELL_TEST_TOKEN = 'local-token'
  try {
    const ctx = apolloContext({ provenance: {}, tools: {}, credentialRefs: {}, loadCredential: async () => { throw new Error('not used') } })
    assert.throws(() => ctx.artifactToken({ tokenEnv: 'APPSHELL_TEST_TOKEN' }), /_credentials/)
  } finally { delete process.env.APPSHELL_TEST_TOKEN }
})
