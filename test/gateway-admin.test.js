/**
 * Loopback admin surface added with the 0.1.4 hardening pass: deep health,
 * capability matrix, audit export, key rotation, and the pairing payload's
 * status/URL-change fields.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { startFakeUpstream, createGateway, pairDevice } from './helpers.js'

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

function csrfHeaders(extra = {}) {
  return { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest', ...extra }
}

test('admin: deep health reports per-component checks', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })

  const health = await request(instance.gateway, '/health?deep=1')
  assert.equal(health.status, 200)
  const body = await health.json()
  assert.equal(body.code, 0)
  assert.equal(body.data.ok, true)
  assert.equal(body.data.version, 'test')
  const names = body.data.checks.map((check) => check.name)
  for (const expected of ['gateway', 'storage', 'dsh-upstream', 'tunnel', 'weixin', 'capabilities']) {
    assert.ok(names.includes(expected), `missing check ${expected}`)
  }
  const tunnel = body.data.checks.find((check) => check.name === 'tunnel')
  assert.equal(tunnel.ok, true)
  assert.equal(tunnel.optional, true)

  // Shallow health keeps the original compact shape.
  const shallow = await request(instance.gateway, '/health')
  const shallowBody = await shallow.json()
  assert.equal(shallowBody.data.ok, true)
  assert.ok('time' in shallowBody.data)

  const adminHealth = await request(instance.gateway, '/mobile/api/v1/admin/health')
  assert.equal(adminHealth.status, 200)
  assert.equal((await adminHealth.json()).data.ok, true)
})

test('admin: deep health returns 503 when the DSH upstream is unreachable', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
  })

  await upstream.close()
  const health = await request(instance.gateway, '/health?deep=1')
  assert.equal(health.status, 503)
  const body = await health.json()
  assert.equal(body.data.ok, false)
  const upstreamCheck = body.data.checks.find((check) => check.name === 'dsh-upstream')
  assert.equal(upstreamCheck.ok, false)
})

test('admin: capabilities, pairing payload and status carry the new fields', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })

  const capabilities = await request(instance.gateway, '/mobile/api/v1/admin/capabilities')
  assert.equal(capabilities.status, 200)
  const capabilityData = (await capabilities.json()).data
  assert.equal(typeof capabilityData.controller, 'boolean')
  assert.equal(typeof capabilityData.weixin, 'boolean')
  assert.equal(capabilityData.tunnel.enabled, false)

  const pairing = await request(instance.gateway, '/mobile/api/v1/admin/pairing')
  const pairingData = (await pairing.json()).data
  assert.equal(pairingData.status.valid, true)
  assert.equal(pairingData.status.used, false)
  assert.equal(typeof pairingData.urlChangedAt, 'number')
  assert.equal(pairingData.previousUrl, '')
  assert.equal(pairingData.tunnel.enabled, false)

  const { cookie } = await pairDevice(instance.gateway)
  const status = await request(instance.gateway, '/mobile/api/v1/status', { cookie })
  const statusData = (await status.json()).data
  assert.ok(statusData.capabilities)
  assert.equal(statusData.capabilities.tunnel.enabled, false)

  // A tunnel hostname change is recorded and exposed for the re-pair banner.
  instance.gateway.tunnel.url = 'https://first.trycloudflare.com'
  instance.gateway.handleTunnelStatusChange()
  instance.gateway.tunnel.url = 'https://second.trycloudflare.com'
  instance.gateway.handleTunnelStatusChange()
  const changed = (await (await request(instance.gateway, '/mobile/api/v1/admin/pairing')).json()).data
  assert.equal(changed.previousUrl, 'https://first.trycloudflare.com')
  assert.ok(changed.urlChangedAt > 0)
})

test('admin: audit export filters and never includes the full pairing code', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })

  const update = await request(instance.gateway, '/mobile/api/v1/admin/settings', {
    method: 'POST',
    headers: csrfHeaders(),
    body: JSON.stringify({ sessionMaxAge: 7200 }),
  })
  assert.equal(update.status, 200)

  const audit = await request(instance.gateway, '/mobile/api/v1/admin/audit?action=admin.settings.updated')
  assert.equal(audit.status, 200)
  const auditData = (await audit.json()).data
  assert.ok(Array.isArray(auditData.entries))
  assert.ok(auditData.entries.length >= 1)
  assert.ok(auditData.entries.every((entry) => entry.message === 'admin.settings.updated'))
  assert.equal(typeof auditData.total, 'number')

  // `action` is a case-insensitive prefix, so a short prefix matches the event family.
  const prefix = await request(instance.gateway, '/mobile/api/v1/admin/audit?action=ADMIN.SETTINGS&limit=10')
  const prefixData = (await prefix.json()).data
  assert.ok(prefixData.total >= 1)
  assert.ok(prefixData.entries.every((entry) => entry.message.startsWith('admin.settings')))

  const fullCode = instance.gateway.pairing.describe().code
  const everything = await request(instance.gateway, '/mobile/api/v1/admin/audit?limit=200')
  const text = JSON.stringify((await everything.json()).data)
  assert.ok(!text.includes(fullCode), 'audit export must not contain the pairing code')
})

test('admin: key rotation keeps existing sessions valid', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })

  const { cookie } = await pairDevice(instance.gateway)
  const rotate = await request(instance.gateway, '/mobile/api/v1/admin/key/rotate', {
    method: 'POST',
    headers: csrfHeaders(),
  })
  assert.equal(rotate.status, 200)
  const rotateData = (await rotate.json()).data
  assert.equal(rotateData.rotated, true)
  assert.equal(typeof rotateData.activeKid, 'string')
  assert.ok(rotateData.keyIds.length >= 1)
  assert.equal(rotateData.sessionsInvalidated, 0)

  const me = await request(instance.gateway, '/mobile/api/v1/me', { cookie })
  assert.equal(me.status, 200)
})
