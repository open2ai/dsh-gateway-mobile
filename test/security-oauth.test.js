/**
 * Phase 2 OAuth allowlist tests: `auth.oauthAllowedUsers` must gate binding by
 * `provider:login` or `provider:providerUserId` (case-insensitive), reject
 * everyone else with CODES.OAUTH_NOT_ALLOWED (HTTP 403), and leave the default
 * open behaviour untouched when the list is empty.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../lib/config.js'
import { DeviceManager } from '../lib/devices.js'
import { CODES, httpStatusFor, isGatewayErrorCode, messageFor } from '../lib/errors.js'
import { Logger } from '../lib/logger.js'
import { OAuthManager } from '../lib/oauth.js'
import { SecretBox } from '../lib/store.js'

function oauthFixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-security-oauth-'))
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
  const oauth = new OAuthManager({
    config,
    logger,
    devices,
    box,
    publicBase: () => 'https://abc.trycloudflare.com',
  })
  return { dir, config, logger, devices, box, oauth }
}

/** Deterministic fetch mock for the GitHub token + user endpoints. */
function githubFetch({ login, id, avatar = '' }) {
  return async (url) => {
    const target = String(url)
    if (target.includes('github.com/login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'access-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (target === 'https://api.github.com/user') {
      return new Response(JSON.stringify({ id, login, avatar_url: avatar }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected fetch: ${target}`)
  }
}

async function withFetch(mock, run) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

/** Authorize + callback through the mocked provider and return the result. */
async function bindWith(oauth, devices, fetchUser) {
  const device = devices.register({ deviceName: 'OAuth Phone' })
  const state = new URL(oauth.authorizeUrl('github', device.deviceId)).searchParams.get('state')
  const result = await withFetch(githubFetch(fetchUser), () => oauth.handleCallback('github', 'auth-code', state))
  return { device, result }
}

test('oauth allowlist accepts a matching provider:login entry case-insensitively', async () => {
  const { oauth, devices } = oauthFixture({ oauthAllowedUsers: ['GitHub:ALICE'] })
  const { device, result } = await bindWith(oauth, devices, { login: 'alice', id: 42 })
  assert.equal(result.binding.username, 'alice')
  assert.equal(result.binding.providerUserId, '42')
  assert.equal(devices.get(device.deviceId).oauthBindings.length, 1)
})

test('oauth allowlist accepts a matching provider:providerUserId entry', async () => {
  const { oauth, devices } = oauthFixture({ oauthAllowedUsers: ['github:42'] })
  const { device, result } = await bindWith(oauth, devices, { login: 'anyone', id: 42 })
  assert.equal(result.binding.provider, 'github')
  assert.equal(devices.get(device.deviceId).oauthBindings.length, 1)
})

test('oauth allowlist rejects a user outside the list with OAUTH_NOT_ALLOWED / 403', async () => {
  const { oauth, devices, logger } = oauthFixture({ oauthAllowedUsers: ['github:bob'] })
  const device = devices.register({ deviceName: 'OAuth Phone' })
  const state = new URL(oauth.authorizeUrl('github', device.deviceId)).searchParams.get('state')
  await assert.rejects(
    () => withFetch(githubFetch({ login: 'alice', id: 42 }), () => oauth.handleCallback('github', 'auth-code', state)),
    (error) => {
      assert.equal(error.code, CODES.OAUTH_NOT_ALLOWED)
      assert.equal(error.httpStatus, 403)
      assert.equal(error.httpStatus, httpStatusFor(CODES.OAUTH_NOT_ALLOWED))
      return true
    },
  )
  // A rejected binding must not be stored on the device.
  assert.equal(devices.get(device.deviceId).oauthBindings.length, 0)
  assert.ok(logger.auditEntries.some((entry) => entry.action === 'oauth.rejected'))
})

test('oauth callbackFromClient applies the same allowlist', async () => {
  const { oauth, devices } = oauthFixture({ oauthAllowedUsers: ['github:bob'] })
  const device = devices.register({ deviceName: 'OAuth Phone' })
  const state = new URL(oauth.authorizeUrl('github', device.deviceId)).searchParams.get('state')
  await assert.rejects(
    () =>
      withFetch(githubFetch({ login: 'alice', id: 42 }), () =>
        oauth.callbackFromClient({ provider: 'github', code: 'auth-code', state }),
      ),
    (error) => error.code === CODES.OAUTH_NOT_ALLOWED,
  )
})

test('empty oauth allowlist keeps the previous open behaviour', async () => {
  const { oauth, devices } = oauthFixture({ oauthAllowedUsers: [] })
  const { device, result } = await bindWith(oauth, devices, { login: 'whoever', id: 7 })
  assert.equal(result.binding.username, 'whoever')
  assert.equal(devices.get(device.deviceId).oauthBindings.length, 1)
})

test('OAUTH_NOT_ALLOWED is a registered bilingual 403 code', () => {
  assert.equal(CODES.OAUTH_NOT_ALLOWED, 4010)
  assert.equal(isGatewayErrorCode(CODES.OAUTH_NOT_ALLOWED), true)
  assert.equal(httpStatusFor(CODES.OAUTH_NOT_ALLOWED), 403)
  assert.notEqual(messageFor(CODES.OAUTH_NOT_ALLOWED, 'zh'), messageFor(CODES.OAUTH_NOT_ALLOWED, 'en'))
  assert.equal(messageFor(CODES.OAUTH_NOT_ALLOWED, 'zh').length > 0, true)
  assert.equal(messageFor(CODES.OAUTH_NOT_ALLOWED, 'en').length > 0, true)
})
