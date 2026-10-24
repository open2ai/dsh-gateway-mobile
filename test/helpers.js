/**
 * Shared test fixtures: a fake DSH upstream (HTTP + WebSocket) and a gateway
 * wired with an in-memory context that mimics the two DSH services we use.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { normalizeConfig } from '../lib/config.js'
import { DeviceManager } from '../lib/devices.js'
import { Gateway } from '../lib/gateway.js'
import { Logger } from '../lib/logger.js'
import { OAuthManager } from '../lib/oauth.js'
import { PairingManager } from '../lib/pairing.js'
import { DshCookieProvider, ProxyEngine } from '../lib/proxy.js'
import { SessionManager } from '../lib/sessions.js'
import { SecretBox } from '../lib/store.js'
import { StatsStore } from '../lib/stats.js'
import { TunnelManager } from '../lib/tunnel.js'

export const COOKIE = 'dsh=fake-cookie'

/** A minimal DSH-like upstream. */
export async function startFakeUpstream() {
  const state = {
    requests: [],
    lastHeaders: null,
  }
  const server = http.createServer((req, res) => {
    state.requests.push({ method: req.method, url: req.url, headers: req.headers })
    state.lastHeaders = req.headers
    const url = new URL(req.url ?? '/', 'http://upstream.local')
    if (url.pathname === '/' && url.searchParams.get('token') === 'fake-token') {
      res.statusCode = 303
      res.setHeader('set-cookie', `${COOKIE}; Path=/; HttpOnly; SameSite=Strict`)
      res.setHeader('location', './')
      res.end()
      return
    }
    if (!String(req.headers.cookie ?? '').includes('dsh=fake-cookie')) {
      res.statusCode = 401
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ code: 2001 }))
      return
    }
    if (url.pathname === '/') {
      res.statusCode = 200
      res.setHeader('content-type', 'text/html')
      res.end('<!doctype html><title>fake dsh</title><main>dsh upstream</main>')
      return
    }
    if (url.pathname === '/api') {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, body: Buffer.concat(chunks).toString('utf8'), host: req.headers.host }))
      })
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', 'text/plain')
    res.end(`echo:${url.pathname}`)
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://upstream.local')
    if (url.pathname !== '/api/remote.mux') {
      socket.destroy()
      return
    }
    if (!String(req.headers.cookie ?? '').includes('dsh=fake-cookie')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => ws.send(`echo:${data.toString()}`))
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    state,
    async close() {
      wss.close()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** Build a fake Cordis context exposing the two services the gateway uses. */
export function fakeContext(upstreamOrigin) {
  return {
    webServer: {
      getOrigin: () => upstreamOrigin,
    },
    connection: {
      authenticatedUrl: (baseUrl) => `${baseUrl}?token=fake-token`,
    },
  }
}

/**
 * Create and listen a gateway instance.
 * @param {{ upstreamOrigin: string, overrides?: Record<string, unknown>, env?: Record<string, string | undefined> }} input
 */
export async function createGateway(input) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-gw-'))
  const raw = deepMerge(
    {
      gateway: { host: '127.0.0.1', port: 0 },
      tunnel: { enabled: false },
      proxy: { upstream: input.upstreamOrigin },
      auth: { pairingTokenExpiry: 120, sessionMaxAge: 3600 },
      security: { pairingMaxAttempts: 3, pairingLockoutDuration: 60, rateLimitMax: 1000 },
      log: { level: 'error' },
      dataDir,
    },
    input.overrides ?? {},
  )
  const config = normalizeConfig(raw, { env: input.env ?? {}, home: dataDir })
  const logger = new Logger({ level: config.log.level, maxEntries: 200, file: `${dataDir}/gateway.log` })
  const box = new SecretBox(dataDir).load()
  const devices = new DeviceManager({
    dataDir,
    maxDevices: config.device.maxDevicesPerUser,
    inactiveExpiryDays: config.device.inactiveExpiryDays,
    logger,
  })
  devices.startCleanup()
  const pairing = new PairingManager({ ttlSeconds: config.auth.pairingTokenExpiry, logger })
  const sessions = new SessionManager({ box, maxAgeSeconds: config.auth.sessionMaxAge })
  const stats = new StatsStore({ dataDir })
  const tunnel = new TunnelManager({ config, logger, gatewayPort: () => gateway.port })
  const cookieProvider = new DshCookieProvider({ ctx: fakeContext(input.upstreamOrigin), logger })
  const proxy = new ProxyEngine({
    ctx: fakeContext(input.upstreamOrigin),
    config,
    logger,
    cookieProvider,
    publicBase: () => gateway.publicBase(),
    deviceManager: devices,
  })
  const oauth = new OAuthManager({
    config,
    logger,
    devices,
    box,
    publicBase: () => gateway.publicBase(),
  })
  const gateway = new Gateway({
    config,
    logger,
    tunnel,
    pairing,
    sessions,
    devices,
    cookieProvider,
    proxy,
    oauth,
    stats,
    version: 'test',
  })
  await gateway.listen()
  return {
    gateway,
    config,
    logger,
    devices,
    pairing,
    sessions,
    tunnel,
    cookieProvider,
    proxy,
    oauth,
    dataDir,
    async close() {
      devices.stopCleanup()
      await gateway.close()
      proxy.close()
      await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

export function deepMerge(base, override) {
  if (Array.isArray(base)) return Array.isArray(override) ? override.slice() : base
  if (base === null || typeof base !== 'object') return override ?? base
  if (!override || typeof override !== 'object') return base
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? deepMerge(base[key], value) : value
  }
  return out
}

/** Extract the `dsh_session=...` pair from a response. */
export function sessionCookie(response) {
  const getSetCookie = response.headers.getSetCookie?.()
  const raw = getSetCookie?.[0] ?? response.headers.get('set-cookie') ?? ''
  const match = /dsh_session=[^;]+/.exec(raw)
  return match ? match[0] : ''
}

/** Pair a fresh device and return its cookie/device id. */
export async function pairDevice(gateway, name = 'Test Phone') {
  const code = gateway.pairing.describe().code
  const response = await fetch(`${gateway.origin}/mobile/api/v1/pairing/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingToken: code, deviceName: name }),
  })
  const body = await response.json()
  if (body.code !== 0) throw new Error(`pair failed: ${JSON.stringify(body)}`)
  return { cookie: sessionCookie(response), deviceId: body.data.deviceId, response }
}

export function exists(file) {
  return fs.existsSync(file)
}
