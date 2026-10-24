import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { normalizeConfig } from '../lib/config.js'
import { Logger } from '../lib/logger.js'
import { TunnelManager } from '../lib/tunnel.js'

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.killed = false
  }

  kill() {
    this.killed = true
    this.emit('exit', 0, null)
  }
}

function config() {
  return normalizeConfig(
    {
      tunnel: { enabled: true, binaryPath: process.execPath, autoDownload: false },
      gateway: { port: 39999 },
      log: { level: 'error' },
    },
    { env: { DSH_HOME: process.cwd() }, home: process.cwd() },
  )
}

test('tunnel: parses the Quick Tunnel URL and reports connected', async () => {
  const child = new FakeChild()
  setTimeout(() => child.stderr.write('INF | https://fake-tunnel.trycloudflare.com |\n'), 20)
  const manager = new TunnelManager({
    config: config(),
    logger: new Logger({ level: 'error' }),
    gatewayPort: () => 3081,
    spawnImpl: () => child,
  })
  await manager.start()
  assert.equal(manager.connected, true)
  assert.equal(manager.url, 'https://fake-tunnel.trycloudflare.com')
  assert.deepEqual([...manager.tunnelHosts()], ['fake-tunnel.trycloudflare.com'])
  await manager.stop()
  assert.equal(manager.state, 'stopped')
  assert.equal(child.killed, true)
})

test('tunnel: disabled configuration is inert', async () => {
  const configValue = normalizeConfig({ tunnel: { enabled: false } }, { env: { DSH_HOME: process.cwd() }, home: process.cwd() })
  const manager = new TunnelManager({
    config: configValue,
    logger: new Logger({ level: 'error' }),
    gatewayPort: () => 3081,
  })
  const status = await manager.start()
  assert.equal(status.state, 'disabled')
  assert.equal(manager.connected, false)
})

test('tunnel: start is idempotent and stop kills every child', async () => {
  let spawns = 0
  const children = []
  const manager = new TunnelManager({
    config: config(),
    logger: new Logger({ level: 'error' }),
    gatewayPort: () => 3081,
    spawnImpl: () => {
      spawns += 1
      const child = new FakeChild()
      children.push(child)
      setTimeout(() => child.stderr.write('INF | https://idempotent-1792771079017.trycloudflare.com |\n'), 20)
      return child
    },
  })
  await manager.start()
  await manager.start()
  assert.equal(spawns, 1)
  await manager.stop()
  assert.equal(children.every((child) => child.killed), true)
})
