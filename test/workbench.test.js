import assert from 'node:assert/strict'
import test from 'node:test'
import { PROXIED_HEADER, registerWorkbenchBridge } from '../lib/workbench/bridge.js'

/**
 * Minimal fake of the Cordis context and Gateway surface the workbench bridge
 * needs. The bridge must only read live status and never mutate the gateway.
 */
function harness() {
  const registered = []
  const effects = []
  const calls = { issue: 0 }
  const ctx = {
    effect(callback, label) {
      effects.push({ label, dispose: callback() })
    },
    connection: {
      fetch: {
        register(route) {
          registered.push(route)
          return async () => {}
        },
      },
    },
  }
  const status = {
    gateway: { port: 3081, publicBase: 'https://example.trycloudflare.com', uptime: 3600 },
    tunnel: {
      enabled: true,
      mode: 'quick',
      state: 'connected',
      connected: true,
      url: 'https://example.trycloudflare.com',
      publicBase: 'https://example.trycloudflare.com',
      protocol: 'http2',
      lastError: '',
    },
    activeDevices: 2,
    onlineDevices: 1,
    capabilities: { controller: true, workspaceRegistry: true, userQuestions: true, weixin: true },
  }
  const gateway = {
    origin: 'http://127.0.0.1:3081',
    statusPayload: () => status,
    pairingPayload: async () => ({
      code: 'AAAA-BBBB',
      codeRaw: 'AAAABBBB',
      expiresIn: 900,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      pairingUrl: 'https://example.trycloudflare.com/mobile/pair#pairing=AAAABBBB',
      qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      tunnel: status.tunnel,
      status: { valid: true, expiresIn: 900, used: false },
      previousUrl: '',
      urlChangedAt: 0,
    }),
    pairing: {
      issue() {
        calls.issue += 1
      },
    },
    devices: {
      devices: new Map([
        ['dev_aaaaaaaaaaaaaaaa', { deviceId: 'dev_aaaaaaaaaaaaaaaa', deviceName: 'Phone', userAgent: 'UA' }],
      ]),
      toPublic: (device) => ({
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        displayName: device.deviceName,
        userAgent: device.userAgent,
        createdAt: '2026-11-10T00:00:00.000Z',
        lastActiveAt: '2026-11-10T01:00:00.000Z',
        lastIp: '127.0.0.1',
        oauthBindings: [],
        isOnline: true,
        isCurrent: false,
        revoked: false,
        expired: false,
      }),
    },
    logger: {
      recent: (limit) => [{ timestamp: '2026-11-10T01:00:00.000Z', level: 'info', message: `log-${limit}` }],
    },
    authSettings: () => ({ sessionMaxAge: 86400, pairingTokenExpiry: 900, limits: {} }),
    runtimeSettings: () => ({
      tunnelEnabled: true,
      weixinEnabled: true,
      logLevel: 'info',
      proxyRequestTimeoutMs: 30_000,
    }),
  }
  return { ctx, gateway, registered, effects, calls, status }
}

function routeById(registered, path) {
  const route = registered.find((entry) => entry.path === path)
  assert.ok(route, `route ${path} must be registered`)
  return route
}

test('workbench bridge registers read routes plus the pairing regenerate action', () => {
  const { ctx, gateway, registered, effects } = harness()
  assert.equal(registerWorkbenchBridge(ctx, gateway, '0.2.0-next.0'), true)

  assert.deepEqual(
    registered.map((entry) => `${entry.methods.join(',')} ${entry.path}`),
    [
      'GET /api/gateway-mobile/read/ping',
      'GET /api/gateway-mobile/read/pairing',
      'GET /api/gateway-mobile/read/devices',
      'GET /api/gateway-mobile/read/logs',
      'GET /api/gateway-mobile/read/settings',
      'POST /api/gateway-mobile/admin/pairing/regenerate',
    ],
  )
  assert.equal(effects.length, registered.length)
  for (const effect of effects) {
    assert.match(effect.label, /\/api\/gateway-mobile\//)
    assert.equal(typeof effect.dispose, 'function')
  }
})

test('workbench bridge degrades gracefully when exact Fetch routes are absent', () => {
  const ctx = {
    effect() {
      throw new Error('effect must not be called without the Fetch surface')
    },
    connection: {},
  }
  const gateway = { origin: 'http://127.0.0.1:3081', statusPayload: () => ({}) }
  assert.equal(registerWorkbenchBridge(ctx, gateway, '0.2.0-next.0'), false)
})

test('ping marks local callers and keeps the payload phone-safe', async () => {
  const { ctx, gateway, registered } = harness()
  registerWorkbenchBridge(ctx, gateway, '0.2.0-next.0')
  const ping = routeById(registered, '/api/gateway-mobile/read/ping')

  const local = await ping.fetch(new Request('http://127.0.0.1:3080/api/gateway-mobile/read/ping'))
  assert.equal(local.status, 200)
  assert.equal(local.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(local.headers.get('cache-control'), 'no-store')
  const body = await local.json()
  assert.equal(body.local, true)
  assert.equal(body.version, '0.2.0-next.0')
  assert.equal(body.gateway.adminUrl, 'http://127.0.0.1:3081/mobile/admin')
  assert.equal(body.tunnel.connected, true)

  const remote = await ping.fetch(
    new Request('http://127.0.0.1:3080/api/gateway-mobile/read/ping', {
      headers: { [PROXIED_HEADER]: '1' },
    }),
  )
  assert.equal((await remote.json()).local, false)

  // Read-only contract: no pairing code, QR, tokens or device identifiers.
  const serialized = JSON.stringify(body)
  assert.doesNotMatch(serialized, /pairing|qrSvg|codeRaw|session|token|secret|dev_[a-f0-9]/i)
})

test('local-only reads and regeneration reject tunnel-proxied callers', async () => {
  const { ctx, gateway, registered, calls } = harness()
  registerWorkbenchBridge(ctx, gateway, '0.2.0-next.0')

  const localReads = [
    '/api/gateway-mobile/read/pairing',
    '/api/gateway-mobile/read/devices',
    '/api/gateway-mobile/read/logs',
    '/api/gateway-mobile/read/settings',
  ]
  for (const path of localReads) {
    const route = routeById(registered, path)
    const remote = await route.fetch(
      new Request(`http://127.0.0.1:3080${path}`, { headers: { [PROXIED_HEADER]: '1' } }),
    )
    assert.equal(remote.status, 403, `${path} must reject proxied callers`)
    const body = await remote.json()
    assert.equal(body.code, 3003)
  }

  const regenerate = routeById(registered, '/api/gateway-mobile/admin/pairing/regenerate')
  const denied = await regenerate.fetch(
    new Request('http://127.0.0.1:3080/api/gateway-mobile/admin/pairing/regenerate', {
      method: 'POST',
      headers: { [PROXIED_HEADER]: '1' },
    }),
  )
  assert.equal(denied.status, 403)
  assert.equal(calls.issue, 0)

  const allowed = await regenerate.fetch(
    new Request('http://127.0.0.1:3080/api/gateway-mobile/admin/pairing/regenerate', { method: 'POST' }),
  )
  assert.equal(allowed.status, 200)
  assert.equal(calls.issue, 1)
})

test('local reads expose pairing, devices, logs and settings payloads', async () => {
  const { ctx, gateway, registered } = harness()
  registerWorkbenchBridge(ctx, gateway, '0.2.0-next.0')

  const pairing = await routeById(registered, '/api/gateway-mobile/read/pairing').fetch(
    new Request('http://127.0.0.1:3080/api/gateway-mobile/read/pairing'),
  )
  assert.equal(pairing.status, 200)
  assert.equal((await pairing.json()).code, 'AAAA-BBBB')

  const devices = await routeById(registered, '/api/gateway-mobile/read/devices').fetch(
    new Request('http://127.0.0.1:3080/api/gateway-mobile/read/devices'),
  )
  assert.equal(devices.status, 200)
  assert.equal((await devices.json()).devices.length, 1)

  const logs = await routeById(registered, '/api/gateway-mobile/read/logs').fetch(
    new Request('http://127.0.0.1:3080/api/gateway-mobile/read/logs?limit=25'),
  )
  assert.equal(logs.status, 200)
  assert.equal((await logs.json()).logs[0].message, 'log-25')

  const settings = await routeById(registered, '/api/gateway-mobile/read/settings').fetch(
    new Request('http://127.0.0.1:3080/api/gateway-mobile/read/settings'),
  )
  assert.equal(settings.status, 200)
  const settingsBody = await settings.json()
  assert.equal(settingsBody.sessionMaxAge, 86400)
  assert.equal(settingsBody.runtime.tunnelEnabled, true)
})
