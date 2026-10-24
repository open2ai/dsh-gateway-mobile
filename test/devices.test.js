import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CODES } from '../lib/errors.js'
import { DeviceManager } from '../lib/devices.js'
import { Logger } from '../lib/logger.js'

function manager(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-dev-'))
  const logger = new Logger({ level: 'error' })
  return {
    dir,
    logger,
    devices: new DeviceManager({
      dataDir: dir,
      maxDevices: options.maxDevices ?? 3,
      inactiveExpiryDays: 30,
      logger,
    }),
  }
}

test('register/list/revoke a device', () => {
  const { devices } = manager()
  const device = devices.register({ deviceName: 'Phone A', userAgent: 'UA', ip: '127.0.0.1' })
  assert.match(device.deviceId, /^dev_[a-f0-9]{16}$/)
  assert.equal(devices.listActive().length, 1)
  assert.equal(devices.get(device.deviceId).deviceName, 'Phone A')
  devices.revoke(device.deviceId)
  assert.equal(devices.listActive().length, 0)
  assert.throws(() => devices.requireActive(device.deviceId), (error) => error.code === CODES.DEVICE_REVOKED)
})

test('generates a friendly display name from the user agent', () => {
  const { devices } = manager()
  const generated = devices.register({
    userAgent: 'Mozilla/5.0 (Linux; Android 16; BVL-AN16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  })
  assert.equal(generated.deviceName, 'Android · Chrome')
  assert.equal(devices.toPublic(generated).displayName, 'Android · Chrome')

  const named = devices.register({ deviceName: 'My Phone', userAgent: generated.userAgent })
  assert.equal(named.deviceName, 'My Phone')
  assert.equal(devices.toPublic(named).displayName, 'My Phone')
})

test('enforces the device limit', () => {
  const { devices } = manager({ maxDevices: 1 })
  devices.register({ deviceName: 'one' })
  assert.throws(() => devices.register({ deviceName: 'two' }), (error) => error.code === CODES.DEVICE_LIMIT_REACHED)
})

test('oauth bindings are replaced per provider and removable', () => {
  const { devices } = manager()
  const device = devices.register({})
  devices.bindOAuth(device.deviceId, { provider: 'github', providerUserId: '1', username: 'alice', boundAt: Date.now() })
  devices.bindOAuth(device.deviceId, { provider: 'github', providerUserId: '2', username: 'bob', boundAt: Date.now() })
  assert.equal(device.oauthBindings.length, 1)
  assert.equal(device.oauthBindings[0].username, 'bob')
  devices.unbindOAuth(device.deviceId, 'github')
  assert.equal(device.oauthBindings.length, 0)
})

test('revokeAll revokes active devices', () => {
  const { devices } = manager({ maxDevices: 5 })
  const a = devices.register({})
  const b = devices.register({})
  assert.equal(devices.revokeAll(), 2)
  assert.equal(devices.listActive().length, 0)
  assert.equal(devices.get(a.deviceId).revoked, true)
  assert.equal(devices.get(b.deviceId).revoked, true)
})

test('permanently removes only revoked or expired devices', () => {
  const { devices } = manager({ maxDevices: 5 })
  const active = devices.register({ deviceName: 'active' })
  const revoked = devices.register({ deviceName: 'revoked' })
  const expired = devices.register({ deviceName: 'expired' })
  devices.revoke(revoked.deviceId)
  expired.expired = true

  assert.throws(() => devices.remove(active.deviceId), (error) => error.code === CODES.DEVICE_NOT_DELETABLE)
  assert.equal(devices.remove(revoked.deviceId).deviceId, revoked.deviceId)
  assert.equal(devices.get(revoked.deviceId), null)
  assert.equal(devices.purgeInactive(), 1)
  assert.equal(devices.get(expired.deviceId), null)
  assert.ok(devices.get(active.deviceId))
  assert.equal(devices.purgeInactive(), 0)
  assert.throws(() => devices.remove('dev_0000000000000000'), (error) => error.code === CODES.INVALID_DEVICE_ID)
})

test('persists devices across manager instances', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-dev-'))
  const logger = new Logger({ level: 'error' })
  const first = new DeviceManager({ dataDir: dir, maxDevices: 3, inactiveExpiryDays: 30, logger })
  const device = first.register({ deviceName: 'persisted' })
  await first.file.save()
  const second = new DeviceManager({ dataDir: dir, maxDevices: 3, inactiveExpiryDays: 30, logger })
  assert.equal(second.get(device.deviceId).deviceName, 'persisted')
})
