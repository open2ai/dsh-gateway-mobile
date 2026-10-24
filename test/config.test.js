import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULTS, normalizeConfig } from '../lib/config.js'

const env = { DSH_HOME: 'C:/tmp/dsh-home' }

test('normalizeConfig applies defaults and derives dataDir', () => {
  const config = normalizeConfig(undefined, { env, home: env.DSH_HOME })
  assert.equal(config.enabled, true)
  assert.equal(config.gateway.host, '127.0.0.1')
  assert.equal(config.gateway.port, 3081)
  assert.equal(config.tunnel.enabled, true)
  assert.equal(config.tunnel.mode, 'quick')
  assert.equal(config.auth.pairingTokenExpiry, 900)
  assert.equal(config.auth.sessionMaxAge, 86400)
  assert.equal(config.proxy.maxRequestSize, 10 * 1024 * 1024)
  assert.equal(config.dataDir.replaceAll('\\', '/'), 'C:/tmp/dsh-home/gateway-mobile')
  assert.equal(DEFAULTS.gateway.host, '127.0.0.1')
})

test('normalizeConfig merges nested overrides', () => {
  const config = normalizeConfig(
    { gateway: { port: 0 }, auth: { sessionMaxAge: 7200 }, tunnel: { enabled: false } },
    { env, home: env.DSH_HOME },
  )
  assert.equal(config.gateway.port, 0)
  assert.equal(config.auth.sessionMaxAge, 7200)
  assert.equal(config.tunnel.enabled, false)
})

test('normalizeConfig lets auth lifetimes be overridden by environment variables', () => {
  const config = normalizeConfig(undefined, {
    env: { ...env, DSH_GATEWAY_SESSION_MAX_AGE: '604800', DSH_GATEWAY_PAIRING_TOKEN_EXPIRY: '600' },
    home: env.DSH_HOME,
  })
  assert.equal(config.auth.sessionMaxAge, 604800)
  assert.equal(config.auth.pairingTokenExpiry, 600)
})

test('normalizeConfig rejects a non-loopback gateway host', () => {
  assert.throws(
    () => normalizeConfig({ gateway: { host: '0.0.0.0' } }, { env, home: env.DSH_HOME }),
    /loopback/,
  )
})

test('normalizeConfig requires a token in named mode', () => {
  assert.throws(
    () => normalizeConfig({ tunnel: { mode: 'named', domain: 'dsh.example.com' } }, { env, home: env.DSH_HOME }),
    /tunnel\.token/,
  )
})

test('normalizeConfig requires OAuth credentials when requireOAuth is true', () => {
  assert.throws(
    () => normalizeConfig({ auth: { requireOAuth: true } }, { env, home: env.DSH_HOME }),
    /no OAuth provider/,
  )
})

test('normalizeConfig validates numeric ranges', () => {
  assert.throws(
    () => normalizeConfig({ gateway: { port: 70000 } }, { env, home: env.DSH_HOME }),
    /gateway\.port/,
  )
})
