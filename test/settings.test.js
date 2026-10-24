import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SettingsStore } from '../lib/settings.js'

test('settings: admin settings persist and apply to a normalized config', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-gw-settings-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  const store = new SettingsStore({ dataDir: dir })
  assert.deepEqual(store.load(), {})
  await store.save({ sessionMaxAge: 604800, pairingTokenExpiry: 600 })

  const reloaded = new SettingsStore({ dataDir: dir })
  assert.deepEqual(reloaded.load(), { sessionMaxAge: 604800, pairingTokenExpiry: 600 })
  const config = { auth: { sessionMaxAge: 86400, pairingTokenExpiry: 900 } }
  reloaded.applyToConfig(config)
  assert.equal(config.auth.sessionMaxAge, 604800)
  assert.equal(config.auth.pairingTokenExpiry, 600)
})

test('settings: invalid stored values are ignored', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-gw-settings-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  await fsp.writeFile(path.join(dir, 'admin-settings.json'), JSON.stringify({ sessionMaxAge: -1, pairingTokenExpiry: 'x' }))
  const store = new SettingsStore({ dataDir: dir })
  assert.deepEqual(store.load(), {})
})
