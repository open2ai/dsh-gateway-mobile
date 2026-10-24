import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { startFakeUpstream, createGateway, pairDevice, sessionCookie } from './helpers.js'

async function request(gateway, path, options = {}) {
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

function rawGet(gateway, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: gateway.port, path: '/', headers },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

test('gateway: auth, pairing, proxy, CSRF, host fence and revocation', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })

  // Unauthenticated HTML navigation redirects to pairing.
  const redirect = await request(instance.gateway, '/')
  assert.equal(redirect.status, 302)
  assert.match(redirect.headers.get('location'), /\/mobile\/pair/)

  // Short admin alias for bookmarks.
  const adminRedirect = await request(instance.gateway, '/admin')
  assert.equal(adminRedirect.status, 302)
  assert.equal(adminRedirect.headers.get('location'), '/mobile/admin')

  // Local admin settings are readable and mutable at runtime.
  const settings = await request(instance.gateway, '/mobile/api/v1/admin/settings')
  assert.equal(settings.status, 200)
  assert.equal((await settings.json()).data.sessionMaxAge, 3600)
  const updated = await request(instance.gateway, '/mobile/api/v1/admin/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
    body: JSON.stringify({ sessionMaxAge: 604800, pairingTokenExpiry: 600 }),
  })
  assert.equal(updated.status, 200)
  const updatedData = (await updated.json()).data
  assert.equal(updatedData.sessionMaxAge, 604800)
  assert.equal(updatedData.pairingTokenExpiry, 600)

  // Pair.
  const { cookie } = await pairDevice(instance.gateway)
  assert.match(cookie, /^dsh_session=/)

  const me = await request(instance.gateway, '/mobile/api/v1/me', { cookie })
  assert.equal(me.status, 200)
  const meBody = await me.json()
  assert.equal(meBody.code, 0)
  assert.equal(meBody.data.device.deviceName, 'Test Phone')

  // Proxy the DSH UI and verify DSH-side Host/Cookie rewriting.
  const page = await request(instance.gateway, '/', { cookie })
  assert.equal(page.status, 200)
  assert.match(await page.text(), /dsh upstream/)
  assert.equal(upstream.state.lastHeaders.host, new URL(upstream.origin).host)
  assert.match(String(upstream.state.lastHeaders.cookie), /dsh=fake-cookie/)

  // Proxy a POST body.
  const api = await request(instance.gateway, '/api', {
    cookie,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  })
  assert.equal(api.status, 200)
  const apiBody = await api.json()
  assert.equal(apiBody.body, '{"hello":"world"}')

  // Host fence.
  assert.equal(await rawGet(instance.gateway, { host: 'evil.example' }), 403)

  // CSRF: state-changing API requires X-Requested-With.
  const noCsrf = await request(instance.gateway, '/mobile/api/v1/logout', { cookie, method: 'POST' })
  assert.equal(noCsrf.status, 403)
  assert.equal((await noCsrf.json()).code, 1007)

  const withCsrf = await request(instance.gateway, '/mobile/api/v1/logout', {
    cookie,
    method: 'POST',
    headers: { 'x-requested-with': 'XMLHttpRequest' },
  })
  assert.equal(withCsrf.status, 200)

  // Revoke self and ensure the session stops working.
  const pair2 = await pairDevice(instance.gateway, 'Second Phone')
  const revoke = await request(instance.gateway, `/mobile/api/v1/devices/${pair2.deviceId}/revoke`, {
    cookie: pair2.cookie,
    method: 'POST',
    headers: { 'x-requested-with': 'XMLHttpRequest' },
  })
  assert.equal(revoke.status, 200)
  const afterRevoke = await request(instance.gateway, '/mobile/api/v1/me', { cookie: pair2.cookie })
  assert.equal(afterRevoke.status, 403)
  assert.equal((await afterRevoke.json()).code, 3001)
})

test('gateway: admin can permanently delete revoked devices', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })
  const first = await pairDevice(instance.gateway, 'Phone A')
  const second = await pairDevice(instance.gateway, 'Phone B')

  // Active devices must be revoked first.
  const denied = await request(instance.gateway, `/mobile/api/v1/devices/${first.deviceId}`, {
    method: 'DELETE',
    headers: { 'x-requested-with': 'XMLHttpRequest' },
  })
  assert.equal(denied.status, 409)
  assert.equal((await denied.json()).code, 4009)

  // Revoke, then delete the record permanently.
  await request(instance.gateway, `/mobile/api/v1/devices/${first.deviceId}/revoke`, {
    method: 'POST',
    headers: { 'x-requested-with': 'XMLHttpRequest' },
  })
  const deleted = await request(instance.gateway, `/mobile/api/v1/devices/${first.deviceId}`, {
    method: 'DELETE',
    headers: { 'x-requested-with': 'XMLHttpRequest' },
  })
  assert.equal(deleted.status, 200)
  assert.equal((await deleted.json()).code, 0)

  // Purge requires the confirmation token.
  const badPurge = await request(instance.gateway, '/mobile/api/v1/devices/purge', {
    method: 'POST',
    headers: { 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/json' },
    body: JSON.stringify({ confirmText: 'nope' }),
  })
  assert.equal(badPurge.status, 400)
  assert.equal((await badPurge.json()).code, 1005)

  await request(instance.gateway, `/mobile/api/v1/devices/${second.deviceId}/revoke`, {
    method: 'POST',
    headers: { 'x-requested-with': 'XMLHttpRequest' },
  })
  const purge = await request(instance.gateway, '/mobile/api/v1/devices/purge', {
    method: 'POST',
    headers: { 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/json' },
    body: JSON.stringify({ confirmText: 'DELETE REVOKED' }),
  })
  assert.equal(purge.status, 200)
  assert.equal((await purge.json()).data.deleted, 1)

  const list = await (await request(instance.gateway, '/mobile/api/v1/devices?all=1')).json()
  assert.equal(list.data.devices.length, 0)
})

test('gateway: pairing brute-force lockout', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin, overrides: { security: { pairingMaxAttempts: 3, pairingLockoutDuration: 60 } } })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })
  for (const code of ['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC']) {
    const response = await request(instance.gateway, '/mobile/api/v1/pairing/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingToken: code }),
    })
    assert.equal(response.status, 400)
  }
  const locked = await request(instance.gateway, '/mobile/api/v1/pairing/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingToken: 'DDDDDDDD' }),
  })
  assert.equal(locked.status, 429)
  assert.ok((await locked.json()).data.retryAfter > 0)
})

test('gateway: stats, rename, session refresh and rate headers', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })
  const { cookie, deviceId } = await pairDevice(instance.gateway)

  const me = await request(instance.gateway, '/mobile/api/v1/me', { cookie })
  assert.equal(me.status, 200)
  assert.ok(me.headers.get('x-ratelimit-limit'))
  assert.ok(me.headers.get('x-ratelimit-remaining'))

  const status = await (await request(instance.gateway, '/mobile/api/v1/status', { cookie })).json()
  assert.ok(status.data.stats.todayRequests >= 1)

  const rename = await request(instance.gateway, `/mobile/api/v1/devices/${deviceId}`, {
    cookie,
    method: 'PATCH',
    headers: { 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/json' },
    body: JSON.stringify({ deviceName: 'Renamed Phone' }),
  })
  assert.equal(rename.status, 200)
  assert.equal((await rename.json()).data.device.deviceName, 'Renamed Phone')

  const refresh = await request(instance.gateway, '/mobile/api/v1/session/refresh', {
    cookie,
    method: 'POST',
    headers: { 'x-requested-with': 'XMLHttpRequest' },
  })
  assert.equal(refresh.status, 200)
  const refreshedCookie = sessionCookie(refresh)
  assert.ok(refreshedCookie)
  assert.notEqual(refreshedCookie, cookie)
  assert.equal((await request(instance.gateway, '/mobile/api/v1/me', { cookie: refreshedCookie })).status, 200)

  const adminStats = await request(instance.gateway, '/mobile/api/v1/admin/stats?days=7')
  assert.equal(adminStats.status, 200)
  assert.ok((await adminStats.json()).data.totalRequests >= 1)
})

test('gateway: local admin bootstrap works without a session', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })
  const adminPage = await request(instance.gateway, '/mobile/admin')
  assert.equal(adminPage.status, 200)
  assert.match(await adminPage.text(), /admin/i)
  const pairing = await request(instance.gateway, '/mobile/api/v1/admin/pairing')
  assert.equal(pairing.status, 200)
  const body = await pairing.json()
  assert.equal(body.code, 0)
  assert.match(body.data.pairingUrl, /\/mobile\/pair#pairing=/)
  assert.ok(body.data.qrSvg === '' || body.data.qrSvg.includes('<svg'))
  const pairPage = await request(instance.gateway, '/mobile/pair')
  assert.equal(pairPage.status, 200)
  const asset = await request(instance.gateway, '/mobile/assets/common.js')
  assert.equal(asset.status, 200)
  const { cookie } = await pairDevice(instance.gateway)
  const shell = await request(instance.gateway, '/mobile/shell', { cookie })
  assert.equal(shell.status, 200)
  assert.match(await shell.text(), /iframe/i)
  const diag = await request(instance.gateway, '/mobile/diag', { cookie })
  assert.equal(diag.status, 200)
  assert.match(await diag.text(), /remote\.mux/i)
})

test('gateway: admin endpoints are loopback-only', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })
  const { cookie } = await pairDevice(instance.gateway)
  const response = await request(instance.gateway, '/mobile/api/v1/admin/pairing', {
    cookie,
    headers: { 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'test' },
  })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).code, 3003)
})

test('gateway: loopback admin API is exempt from the remote rate limit', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({
    upstreamOrigin: upstream.origin,
    overrides: { security: { rateLimitMax: 2, rateLimitWindow: 60 } },
  })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })
  for (let index = 0; index < 6; index += 1) {
    const response = await request(instance.gateway, '/mobile/api/v1/status')
    assert.equal(response.status, 200)
  }
})
