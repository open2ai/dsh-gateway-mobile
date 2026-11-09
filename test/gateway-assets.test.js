/**
 * Served HTML carries the content-hash asset versions from build.json, and the
 * manifest itself is reachable for the service worker.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { startFakeUpstream, createGateway } from './helpers.js'

const manifestPath = path.resolve('web/assets/build.json')

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

test('admin HTML references content-hashed assets and exposes build.json', async (t) => {
  const manifest = readManifest()
  if (!manifest) {
    t.skip('web/assets/build.json is absent; run npm run build:web')
    return
  }
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })

  const page = await fetch(`${instance.gateway.origin}/mobile/admin`)
  assert.equal(page.status, 200)
  const html = await page.text()
  for (const name of ['admin.js', 'admin.css']) {
    const hash = manifest.assets[name]
    assert.ok(typeof hash === 'string' && hash.length >= 4, `manifest missing hash for ${name}`)
    assert.ok(
      html.includes(`/mobile/assets/${name}?v=${hash}`),
      `${name} should be served with ?v=${hash}`,
    )
  }
  assert.ok(!html.includes('/mobile/assets/admin.js?v=64'), 'hard-coded version should be replaced')

  const served = await fetch(`${instance.gateway.origin}/mobile/assets/build.json`)
  assert.equal(served.status, 200)
  const servedManifest = await served.json()
  assert.equal(servedManifest.version, manifest.version)
  assert.equal(served.headers.get('cache-control'), 'no-cache')
})

test('other pages are rewritten with the same manifest', async (t) => {
  const manifest = readManifest()
  if (!manifest) {
    t.skip('web/assets/build.json is absent; run npm run build:web')
    return
  }
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })

  const page = await fetch(`${instance.gateway.origin}/mobile/pair`)
  assert.equal(page.status, 200)
  const html = await page.text()
  const hash = manifest.assets['pair.js']
  assert.ok(html.includes(`/mobile/assets/pair.js?v=${hash}`))
})
