/**
 * Lifecycle regression: closing a gateway must release its loopback port so the
 * next plugin activation (or restart) can bind it again. This guards the
 * EADDRINUSE seen when a host reloaded the plugin without the old listener
 * being released.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { startFakeUpstream, createGateway } from './helpers.js'

test('gateway close releases the listening port for the next instance', async (t) => {
  const upstream = await startFakeUpstream()
  t.after(async () => {
    await upstream.close()
  })

  const first = await createGateway({ upstreamOrigin: upstream.origin })
  const port = first.gateway.port
  await first.close()

  const second = await createGateway({
    upstreamOrigin: upstream.origin,
    overrides: { gateway: { port } },
  })
  t.after(async () => {
    await second.close()
  })

  assert.equal(second.gateway.port, port)
  const health = await fetch(`${second.gateway.origin}/health`)
  assert.equal(health.status, 200)
  assert.equal((await health.json()).data.ok, true)
})
