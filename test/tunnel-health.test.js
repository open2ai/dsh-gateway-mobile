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

const env = { DSH_HOME: process.cwd() }

function quickConfig() {
  return normalizeConfig(
    {
      tunnel: { enabled: true, binaryPath: process.execPath, autoDownload: false },
      gateway: { port: 39999 },
      log: { level: 'error' },
    },
    { env, home: process.cwd() },
  )
}

function namedConfig() {
  return normalizeConfig(
    {
      tunnel: {
        enabled: true,
        mode: 'named',
        domain: 'gw.example.com',
        token: 'fake-token',
        binaryPath: process.execPath,
        autoDownload: false,
      },
      gateway: { port: 39999 },
      log: { level: 'error' },
    },
    { env, home: process.cwd() },
  )
}

test('named tunnel: /ready success reports connected and healthy', async (t) => {
  const child = new FakeChild()
  const spawnCalls = []
  const probes = []
  const manager = new TunnelManager({
    config: namedConfig(),
    logger: new Logger({ level: 'error' }),
    gatewayPort: () => 3081,
    spawnImpl: (command, args) => {
      spawnCalls.push({ command, args })
      return child
    },
    fetchImpl: async (url) => {
      probes.push(url)
      return { ok: true, status: 200, json: async () => ({ readyConnections: 2 }) }
    },
    readyTimeoutMs: 500,
    readyPollIntervalMs: 10,
  })
  t.after(async () => {
    await manager.stop()
  })

  const status = await manager.start()

  assert.equal(status.state, 'connected')
  assert.equal(status.connected, true)
  assert.equal(status.health, 'ok')
  assert.ok(status.lastHealthyAt > 0)
  assert.equal(status.metricsPort, 4081)
  assert.equal(status.connectors, 2)
  assert.equal(status.restarts, 0)

  assert.equal(spawnCalls.length, 1)
  const args = spawnCalls[0].args
  assert.ok(args.includes('--metrics'))
  assert.deepEqual(args.slice(-2), ['--metrics', '127.0.0.1:4081'])
  assert.equal(probes.some((url) => url.endsWith('/ready')), true)

  const health = await manager.health()
  assert.deepEqual(health, { ok: true, detail: 'ready' })
})

test('named tunnel: /ready timeout degrades without throwing', async (t) => {
  const child = new FakeChild()
  const manager = new TunnelManager({
    config: namedConfig(),
    logger: new Logger({ level: 'error' }),
    gatewayPort: () => 3081,
    spawnImpl: () => child,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
    readyTimeoutMs: 60,
    readyPollIntervalMs: 10,
  })
  t.after(async () => {
    await manager.stop()
  })

  const status = await manager.start()
  assert.equal(status.state, 'degraded')
  assert.equal(status.health, 'degraded')
  assert.equal(status.connected, false)
  assert.match(status.lastError, /ready/i)

  const health = await manager.health()
  assert.equal(health.ok, false)
  assert.ok(health.detail.length > 0)
})

test('tunnel: health() reports disabled when the tunnel is configured off', async () => {
  const config = normalizeConfig(
    { tunnel: { enabled: false } },
    { env, home: process.cwd() },
  )
  const manager = new TunnelManager({
    config,
    logger: new Logger({ level: 'error' }),
    gatewayPort: () => 3081,
  })

  assert.deepEqual(await manager.health(), { ok: true, detail: 'disabled' })
  assert.equal(manager.status().health, 'disabled')
})

test('quick tunnel: a changed public URL records lastUrlChangedAt', async (t) => {
  const child = new FakeChild()
  const manager = new TunnelManager({
    config: quickConfig(),
    logger: new Logger({ level: 'error' }),
    gatewayPort: () => 3081,
    spawnImpl: () => child,
  })
  t.after(async () => {
    await manager.stop()
  })

  setTimeout(() => child.stderr.write('INF | https://first-123.trycloudflare.com |\n'), 10)
  await manager.start()
  assert.equal(manager.url, 'https://first-123.trycloudflare.com')
  assert.equal(manager.status().lastUrlChangedAt, 0)

  child.stderr.write('INF | https://second-456.trycloudflare.com |\n')
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(manager.url, 'https://second-456.trycloudflare.com')
  assert.ok(manager.status().lastUrlChangedAt > 0)
  assert.equal(manager.status().health, 'ok')
})
