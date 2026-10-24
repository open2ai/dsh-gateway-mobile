import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../lib/config.js'
import { DeviceManager } from '../lib/devices.js'
import { CODES } from '../lib/errors.js'
import { Logger } from '../lib/logger.js'
import { OAuthManager } from '../lib/oauth.js'
import { SecretBox } from '../lib/store.js'

function oauthManager(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-oauth-'))
  const config = normalizeConfig(
    {
      auth: {
        oauthProviders: ['github'],
        githubClientId: 'client-id',
        githubClientSecret: 'client-secret',
        ...overrides,
      },
      log: { level: 'error' },
    },
    { env: { DSH_HOME: dir }, home: dir },
  )
  const logger = new Logger({ level: 'error' })
  const devices = new DeviceManager({ dataDir: dir, maxDevices: 3, inactiveExpiryDays: 30, logger })
  const box = new SecretBox(dir).load()
  return {
    oauth: new OAuthManager({ config, logger, devices, box, publicBase: () => 'https://abc.trycloudflare.com' }),
    devices,
  }
}

test('oauth: authorize URL uses the minimal scope and public callback', () => {
  const { oauth } = oauthManager()
  assert.deepEqual(oauth.enabledProviders(), ['github'])
  const url = new URL(oauth.authorizeUrl('github', 'dev_0123456789abcdef'))
  assert.equal(url.hostname, 'github.com')
  assert.equal(url.searchParams.get('client_id'), 'client-id')
  assert.equal(url.searchParams.get('scope'), 'read:user')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://abc.trycloudflare.com/auth/github/callback')
  assert.match(url.searchParams.get('state'), /^[^.]+\.[^.]+$/)
})

test('oauth: unknown/invalid state is rejected before any network call', async () => {
  const { oauth } = oauthManager()
  await assert.rejects(
    () => oauth.handleCallback('github', 'code', 'invalid.state'),
    (error) => error.code === CODES.INVALID_OAUTH_STATE,
  )
})

test('oauth: unconfigured provider is rejected', () => {
  const { oauth } = oauthManager({ oauthProviders: ['github'], githubClientId: '', githubClientSecret: '' })
  assert.deepEqual(oauth.enabledProviders(), [])
  assert.throws(() => oauth.authorizeUrl('github', 'dev_0123456789abcdef'), (error) => error.code === CODES.OAUTH_NOT_CONFIGURED)
})

test('oauth: callback page posts a result to the opener', () => {
  const { oauth } = oauthManager()
  const html = oauth.callbackPage({ ok: true, provider: 'github', username: 'alice' })
  assert.match(html, /dsh-oauth/)
  assert.match(html, /alice/)
  assert.match(html, /window\.close/)
})

test('oauth: full callback exchange binds the device (mocked provider)', async () => {
  const { oauth, devices } = oauthManager()
  const device = devices.register({ deviceName: 'OAuth Phone' })
  const authorizeUrl = new URL(oauth.authorizeUrl('github', device.deviceId))
  const state = authorizeUrl.searchParams.get('state')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('github.com/login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'access-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (String(url) === 'https://api.github.com/user') {
      return new Response(JSON.stringify({ id: 42, login: 'alice', avatar_url: 'https://example/avatar.png' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  try {
    const result = await oauth.handleCallback('github', 'auth-code', state)
    assert.equal(result.deviceId, device.deviceId)
    assert.equal(result.binding.provider, 'github')
    assert.equal(result.binding.username, 'alice')
    assert.equal(result.binding.providerUserId, '42')
    const device2 = devices.get(device.deviceId)
    assert.equal(device2.oauthBindings[0].username, 'alice')
  } finally {
    globalThis.fetch = originalFetch
  }
})
