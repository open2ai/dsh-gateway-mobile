import assert from 'node:assert/strict'
import test from 'node:test'
import { registerWorkbenchBridge } from '../lib/workbench/bridge.js'

/**
 * Minimal fake of the Cordis context and Gateway surface the workbench bridge
 * needs. The bridge must only read live status and never mutate the gateway.
 */
function harness() {
  const registered = []
  const effects = []
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
  }
  return { ctx, gateway, registered, effects }
}

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

test('workbench bridge registers the read-only ping route', () => {
  const { ctx, gateway, registered, effects } = harness()
  registerWorkbenchBridge(ctx, gateway, '0.2.0-next.0')

  assert.equal(registered.length, 1)
  assert.equal(registered[0].path, '/api/gateway-mobile/read/ping')
  assert.deepEqual(registered[0].methods, ['GET'])
  assert.equal(registered[0].requestBody, 'buffered')
  assert.equal(effects.length, 1)
  assert.match(effects[0].label, /\/api\/gateway-mobile\/read\/ping/)
  assert.equal(typeof effects[0].dispose, 'function')
})

test('ping response is phone-safe, non-cacheable and read-only', async () => {
  const { ctx, gateway, registered } = harness()
  registerWorkbenchBridge(ctx, gateway, '0.2.0-next.0')

  const response = await registered[0].fetch(new Request('http://127.0.0.1:3080/api/gateway-mobile/read/ping'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'no-store')

  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'dsh-gateway-mobile')
  assert.equal(body.version, '0.2.0-next.0')
  assert.equal(body.gateway.port, 3081)
  assert.equal(body.gateway.adminUrl, 'http://127.0.0.1:3081/mobile/admin')
  assert.equal(body.tunnel.connected, true)
  assert.equal(body.tunnel.url, 'https://example.trycloudflare.com')
  assert.equal(body.devices.active, 2)
  assert.equal(body.devices.online, 1)
  assert.equal(body.capabilities.weixin, true)

  // Read-only contract: no pairing code, QR, tokens or device identifiers.
  const serialized = JSON.stringify(body)
  assert.doesNotMatch(serialized, /pairing|qrSvg|codeRaw|session|token|secret/i)
})
