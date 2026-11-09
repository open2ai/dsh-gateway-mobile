/**
 * Runtime switches: read/update `/admin/settings` without restarting the host,
 * persistence through admin-settings.json, and input validation.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { startFakeUpstream, createGateway } from './helpers.js'

function request(gateway, path, options = {}) {
  return fetch(`${gateway.origin}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body,
    redirect: 'manual',
  })
}

function csrf() {
  return { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' }
}

test('runtime settings: GET exposes the switches and their defaults', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })

  const response = await request(instance.gateway, '/mobile/api/v1/admin/settings')
  assert.equal(response.status, 200)
  const data = (await response.json()).data
  assert.equal(data.sessionMaxAge, 3600)
  assert.equal(typeof data.runtime, 'object')
  assert.equal(data.runtime.tunnelEnabled, false)
  assert.equal(data.runtime.weixinEnabled, true)
  assert.equal(data.runtime.logLevel, 'error')
  assert.equal(data.runtime.proxyRequestTimeoutMs, 0)
  assert.deepEqual(data.restartRequired, [])
})

test('runtime settings: updates apply immediately and persist to disk', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })

  const update = await request(instance.gateway, '/mobile/api/v1/admin/settings', {
    method: 'POST',
    headers: csrf(),
    body: JSON.stringify({ logLevel: 'debug', proxyRequestTimeoutMs: 15000, weixinEnabled: false }),
  })
  assert.equal(update.status, 200)
  const data = (await update.json()).data
  assert.equal(data.runtime.logLevel, 'debug')
  assert.equal(data.runtime.proxyRequestTimeoutMs, 15000)
  assert.equal(data.runtime.weixinEnabled, false)

  // Applied to the live config objects used by the proxy/logger.
  assert.equal(instance.config.log.level, 'debug')
  assert.equal(instance.config.proxy.requestTimeoutMs, 15000)
  assert.equal(instance.config.weixin.enabled, false)

  // Persisted for the next start.
  const { SettingsStore } = await import('../lib/settings.js')
  const reloaded = new SettingsStore({ dataDir: instance.dataDir }).load()
  assert.deepEqual(reloaded, {
    logLevel: 'debug',
    proxyRequestTimeoutMs: 15000,
    weixinEnabled: false,
  })
})

test('runtime settings: auth and runtime fields can be mixed and are validated', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })

  const mixed = await request(instance.gateway, '/mobile/api/v1/admin/settings', {
    method: 'POST',
    headers: csrf(),
    body: JSON.stringify({ sessionMaxAge: 7200, logLevel: 'warn' }),
  })
  assert.equal(mixed.status, 200)
  const mixedData = (await mixed.json()).data
  assert.equal(mixedData.sessionMaxAge, 7200)
  assert.equal(mixedData.runtime.logLevel, 'warn')

  const badLevel = await request(instance.gateway, '/mobile/api/v1/admin/settings', {
    method: 'POST',
    headers: csrf(),
    body: JSON.stringify({ logLevel: 'verbose' }),
  })
  assert.equal(badLevel.status, 400)
  assert.equal((await badLevel.json()).code, 1001)

  const badTimeout = await request(instance.gateway, '/mobile/api/v1/admin/settings', {
    method: 'POST',
    headers: csrf(),
    body: JSON.stringify({ proxyRequestTimeoutMs: -1 }),
  })
  assert.equal(badTimeout.status, 400)

  const empty = await request(instance.gateway, '/mobile/api/v1/admin/settings', {
    method: 'POST',
    headers: csrf(),
    body: JSON.stringify({}),
  })
  assert.equal(empty.status, 400)
})
