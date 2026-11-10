/**
 * The gateway HTTP server: host/trust checks, session authentication, the
 * mobile JSON API, static PWA pages, and the HTTP/WebSocket proxy to DSH.
 *
 * @module dsh-gateway-mobile/lib/gateway
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { CODES, GatewayError, errorBody, httpStatusFor, languageOf, messageFor } from './errors.js'
import { PairingLockout, RateLimiter } from './ratelimit.js'
import { SESSION_COOKIE } from './sessions.js'
import type { SessionPayload } from './sessions.js'
import {
  LOG_LEVELS,
  PAIRING_MAX,
  PAIRING_MIN,
  PROXY_TIMEOUT_MAX,
  PROXY_TIMEOUT_MIN,
  SESSION_MAX,
  SESSION_MIN,
  validLifetime,
  validLogLevel,
  validProxyTimeout,
} from './settings.js'
import type { AuthSettings, RuntimeSettings } from './settings.js'
import type { Device, PublicDevice } from './devices.js'
import type { GatewayConfig } from './config.js'
import type { Logger, LogEntry } from './logger.js'
import type { OAuthManager, OAuthProvider } from './oauth.js'
import type { PairingManager } from './pairing.js'
import type { DshCookieProvider, ProxyEngine } from './proxy.js'
import type { SessionManager } from './sessions.js'
import type { SettingsStore } from './settings.js'
import type { StatsStore, StatsSummary } from './stats.js'
import type { TunnelManager, TunnelStatus } from './tunnel.js'
import type { DeviceManager } from './devices.js'
import type { SecretBox } from './store.js'
import type { WeixinChannel } from './weixin.js'
import type { WeixinNotifier } from './weixin-notifier.js'
import { createApiRouter } from './routes/api.js'
import { createPublicRouter } from './routes/public.js'
import type { Router } from './routes/router.js'
import { acceptWebSocket, WsConnection } from './ws.js'
import {
  describeDevice,
  escapeHtml,
  errorMessage,
  isLoopbackAddress,
  isProxiedRequest,
  mimeType,
  parseCookies,
  requestIp,
  requestProtocol,
  serializeCookie,
  trimTrailingSlash,
  userAgent,
  userAgentHash,
} from './util.js'

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
const JSON_BODY_LIMIT = 64 * 1024

/**
 * DSH workbench paths that must never be reached through the tunnel proxy.
 * Management actions and local-only reads (pairing code/QR, full device list,
 * logs, settings) are reserved for the machine's own DSH UI session.
 */
function isWorkbenchLocalOnlyPath(pathname: string): boolean {
  if (pathname.startsWith('/api/gateway-mobile/admin/')) return true
  return (
    pathname === '/api/gateway-mobile/read/pairing' ||
    pathname === '/api/gateway-mobile/read/devices' ||
    pathname === '/api/gateway-mobile/read/logs' ||
    pathname === '/api/gateway-mobile/read/settings'
  )
}

const PAGE_ROUTES = new Map([
  ['/mobile/pair', 'pair.html'],
  ['/mobile/pair/', 'pair.html'],
  ['/mobile/oauth', 'oauth.html'],
  ['/mobile/oauth/', 'oauth.html'],
  ['/mobile/devices', 'devices.html'],
  ['/mobile/shell', 'shell.html'],
  ['/mobile/diag', 'diag.html'],
  ['/mobile/diag/', 'diag.html'],
  ['/mobile/shell/', 'shell.html'],
  ['/mobile/devices/', 'devices.html'],
  ['/mobile/admin', 'admin.html'],
  ['/mobile/admin/', 'admin.html'],
  ['/mobile/', 'app.html'],
])

export interface HostInfo {
  hostHeader: string
  hostname: string
  port: string
  loopback: boolean
  tunnel: boolean
  local: boolean
  proxied: boolean
}

export interface LocalPeer {
  device: null
  deviceId: 'local'
  local: true
}

export interface DevicePeer {
  device: Device
  deviceId: string
  local: boolean
}

export type Peer = LocalPeer | DevicePeer

/** Services the plugin can probe at startup; absent ones are reported, not fatal. */
export interface CapabilityMatrix {
  controller: boolean
  workspaceRegistry: boolean
  userQuestions: boolean
  weixin: boolean
  tunnel: { enabled: boolean; mode: string }
}

export interface HealthCheck {
  name: string
  ok: boolean
  /** Optional checks do not flip the overall status. */
  optional?: boolean
  detail?: string
  data?: Record<string, unknown>
}

export interface HealthPayload {
  ok: boolean
  version: string
  startedAt: string
  uptime: number
  serverTime: string
  checks: HealthCheck[]
}

export interface PairingPayload {
  code: string
  codeRaw: string
  expiresIn: number
  expiresAt: string
  pairingUrl: string
  qrSvg: string
  tunnel: TunnelStatus
  /** Public pairing status without the code. */
  status: { valid: boolean; expiresIn: number; used: boolean }
  /** Public base URL that was replaced by a tunnel reconnect, when tracked. */
  previousUrl: string
  /** Epoch ms of the last observed public-base change. */
  urlChangedAt: number
  /** True when a device paired after the last public-base change. */
  repairedSinceChange: boolean
}

export interface GatewayStatusPayload {
  gateway: {
    running: boolean
    port: number
    publicBase: string
    startedAt: string
    uptime: number
    version: string
  }
  tunnel: TunnelStatus
  proxy: { running: boolean }
  activeDevices: number
  onlineDevices: number
  stats: StatsSummary | null
  serverTime: string
  device?: PublicDevice
  weixin?: ReturnType<WeixinChannel['status']>
  notifier?: ReturnType<WeixinNotifier['status']>
  capabilities: CapabilityMatrix
}

export interface GatewayOptions {
  config: GatewayConfig
  logger: Logger
  tunnel: TunnelManager
  pairing: PairingManager
  sessions: SessionManager
  devices: DeviceManager
  cookieProvider: DshCookieProvider
  proxy: ProxyEngine
  oauth: OAuthManager
  weixin?: WeixinChannel
  weixinNotifier?: WeixinNotifier
  weixinApprovalHistory?: () => unknown
  stats?: StatsStore
  settingsStore?: SettingsStore
  /** Same SecretBox the sessions use; enables key rotation from the admin console. */
  secretBox?: SecretBox
  /** DSH loopback origin to probe in the deep health check. */
  upstreamOrigin?: () => string
  capabilities?: CapabilityMatrix
  version: string
}

export class Gateway {
  apiRouter: Router
  #assetManifest: Record<string, string> | null = null
  capabilitiesMatrix: CapabilityMatrix
  config: GatewayConfig
  cookieProvider: DshCookieProvider
  devices: DeviceManager
  lastPublicBase: string
  logger: Logger
  oauth: OAuthManager
  publicRouter: Router
  previousPublicBase: string
  secretBox: SecretBox | undefined
  upstreamOrigin: () => string
  urlChangedAt: number
  weixin: WeixinChannel | undefined
  weixinNotifier: WeixinNotifier | undefined
  weixinApprovalHistory: (() => unknown) | undefined
  oauthLimiter: RateLimiter
  onTunnelStatus: () => void
  pairing: PairingManager
  pairingLockout: PairingLockout
  port: number
  proxy: ProxyEngine
  rateLimiter: RateLimiter
  server: http.Server
  sessions: SessionManager
  settingsStore: SettingsStore | undefined
  startedAt: number
  stats: StatsStore | undefined
  tunnel: TunnelManager
  version: string
  wsClients: Set<WsConnection>

  constructor(options: GatewayOptions) {
    this.config = options.config
    this.logger = options.logger
    this.tunnel = options.tunnel
    this.pairing = options.pairing
    this.sessions = options.sessions
    this.devices = options.devices
    this.cookieProvider = options.cookieProvider
    this.proxy = options.proxy
    this.oauth = options.oauth
    this.weixin = options.weixin
    this.weixinNotifier = options.weixinNotifier
    this.weixinApprovalHistory = options.weixinApprovalHistory
    this.stats = options.stats
    this.settingsStore = options.settingsStore
    this.version = options.version
    this.secretBox = options.secretBox
    this.capabilitiesMatrix = options.capabilities ?? {
      controller: false,
      workspaceRegistry: false,
      userQuestions: false,
      weixin: Boolean(options.weixin),
      tunnel: { enabled: this.config.tunnel.enabled, mode: this.config.tunnel.mode },
    }
    this.upstreamOrigin = options.upstreamOrigin ?? (() => this.config.proxy.upstream)
    this.lastPublicBase = ''
    this.previousPublicBase = ''
    this.urlChangedAt = 0
    this.startedAt = Date.now()
    this.port = 0
    this.server = http.createServer((req, res) => {
      void this.#handleHttp(req, res)
    })
    this.server.on('upgrade', (req, socket, head) => {
      void this.#handleUpgrade(req, socket, head)
    })
    this.rateLimiter = new RateLimiter({
      windowSeconds: this.config.security.rateLimitWindow,
      max: this.config.security.rateLimitMax,
    })
    this.pairingLockout = new PairingLockout({
      maxAttempts: this.config.security.pairingMaxAttempts,
      lockoutSeconds: this.config.security.pairingLockoutDuration,
    })
    this.oauthLimiter = new RateLimiter({ windowSeconds: 60, max: 20 })
    this.wsClients = new Set()
    this.publicRouter = createPublicRouter()
    this.apiRouter = createApiRouter()
    this.lastPublicBase = this.config.gateway.publicUrl
      ? this.config.gateway.publicUrl.replace(/\/+$/, '')
      : this.tunnel.publicBase('')
    this.onTunnelStatus = () => this.handleTunnelStatusChange()
    this.tunnel.on('status', this.onTunnelStatus)
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /** Public base URL, used for cookies/QR/OAuth and redirects. */
  publicBase(): string {
    return trimTrailingSlash(
      this.config.gateway.publicUrl || this.tunnel.publicBase(this.origin) || this.origin,
    )
  }

  authSettings(): AuthSettings & { limits: { sessionMin: number; sessionMax: number; pairingMin: number; pairingMax: number } } {
    return {
      sessionMaxAge: this.config.auth.sessionMaxAge,
      pairingTokenExpiry: this.config.auth.pairingTokenExpiry,
      limits: {
        sessionMin: SESSION_MIN,
        sessionMax: SESSION_MAX,
        pairingMin: PAIRING_MIN,
        pairingMax: PAIRING_MAX,
      },
    }
  }

  /**
   * Apply and persist auth lifetime changes. New cookies use the new values;
   * existing cookies keep their remaining lifetime until they rotate.
   */
  async updateAuthSettings(patch: { sessionMaxAge?: unknown; pairingTokenExpiry?: unknown }): Promise<AuthSettings & { pairing: ReturnType<PairingManager['describe']> }> {
    const next: AuthSettings = {}
    if (patch.sessionMaxAge !== undefined) {
      const value = Number(patch.sessionMaxAge)
      if (!validLifetime(value, SESSION_MIN, SESSION_MAX)) {
        throw new GatewayError(CODES.INVALID_PARAMS, { field: 'sessionMaxAge' })
      }
      next.sessionMaxAge = value
    }
    if (patch.pairingTokenExpiry !== undefined) {
      const value = Number(patch.pairingTokenExpiry)
      if (!validLifetime(value, PAIRING_MIN, PAIRING_MAX)) {
        throw new GatewayError(CODES.INVALID_PARAMS, { field: 'pairingTokenExpiry' })
      }
      next.pairingTokenExpiry = value
    }
    if (Object.keys(next).length === 0) throw new GatewayError(CODES.INVALID_PARAMS, { field: 'settings' })

    await this.settingsStore?.save(next)
    if (next.sessionMaxAge !== undefined) {
      this.config.auth.sessionMaxAge = next.sessionMaxAge
      this.sessions.maxAgeSeconds = next.sessionMaxAge
    }
    if (next.pairingTokenExpiry !== undefined) {
      this.config.auth.pairingTokenExpiry = next.pairingTokenExpiry
      this.pairing.ttlSeconds = next.pairingTokenExpiry
      // Existing code keeps its old expiry; issue a fresh one with the new TTL.
      this.pairing.issue()
    }
    this.logger.audit({ action: 'admin.settings.updated', ...next })
    return { ...this.authSettings(), pairing: this.pairing.describe() }
  }

  async listen(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        this.server.off('error', onError)
        const address = this.server.address() as AddressInfo | null
        this.port = address && typeof address === 'object' ? address.port : this.config.gateway.port
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.config.gateway.port, this.config.gateway.host)
    })
    this.logger.info(`Gateway listening on ${this.origin}`)
    return this
  }

  async close(): Promise<void> {
    this.tunnel.off('status', this.onTunnelStatus)
    // Disposal must not throw before the HTTP listener is released: a leaked
    // listener blocks the next plugin load with EADDRINUSE.
    const safe = (fn: () => void): void => {
      try {
        fn()
      } catch (error) {
        this.logger.warn(`Gateway dispose step failed: ${errorMessage(error)}`)
      }
    }
    safe(() => this.weixin?.stop())
    safe(() => this.weixinNotifier?.stop())
    safe(() => this.rateLimiter.stop())
    safe(() => {
      for (const client of this.wsClients) client.close(1001, 'server shutdown')
      this.wsClients.clear()
    })
    safe(() => this.devices.closeAll())
    if (this.server.listening) {
      await new Promise<void>((resolve) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const done = (): void => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          resolve()
        }
        // Never hang the disposer on keep-alive sockets.
        timer = setTimeout(done, 3000)
        timer.unref?.()
        this.server.close(() => done())
        this.server.closeAllConnections?.()
        this.server.closeIdleConnections?.()
      })
    }
  }

  broadcastStatus(): void {
    const message = JSON.stringify({ type: 'gateway.status', payload: this.statusPayload() })
    for (const client of this.wsClients) client.sendText(message)
  }

  /** Track public-base changes so the admin console can prompt a re-pair. */
  handleTunnelStatusChange(): void {
    // Ignore the loopback fallback: only a real tunnel/public URL change matters.
    const next = this.config.gateway.publicUrl ? this.config.gateway.publicUrl.replace(/\/+$/, '') : this.tunnel.publicBase('')
    if (next) {
      if (this.lastPublicBase && next !== this.lastPublicBase) {
        this.previousPublicBase = this.lastPublicBase
        this.urlChangedAt = Date.now()
        this.logger.info(`Public base changed: ${this.previousPublicBase} -> ${next}`)
        this.logger.audit({ action: 'tunnel.url.changed', previous: this.previousPublicBase, current: next })
      }
      this.lastPublicBase = next
    }
    this.broadcastStatus()
  }

  capabilities(): CapabilityMatrix {
    return {
      ...this.capabilitiesMatrix,
      weixin: Boolean(this.weixin) && this.capabilitiesMatrix.weixin !== false,
      tunnel: { enabled: this.config.tunnel.enabled, mode: this.config.tunnel.mode },
    }
  }

  /** Read the audit trail through the logger's filtered query (file-backed). */
  async queryAudit(options: { action?: string | undefined; since?: number | undefined; until?: number | undefined; limit?: number | undefined } = {}): Promise<{
    entries: LogEntry[]
    total: number
  }> {
    const result = (await Promise.resolve(this.logger.queryAudit(options))) as unknown as
      | LogEntry[]
      | { entries: LogEntry[]; total: number }
    if (Array.isArray(result)) return { entries: result, total: result.length }
    return result
  }

  /** Current mutable runtime switches. */
  runtimeSettings(): Required<RuntimeSettings> {
    return {
      tunnelEnabled: this.config.tunnel.enabled,
      weixinEnabled: this.config.weixin.enabled,
      logLevel: this.config.log.level as Required<RuntimeSettings>['logLevel'],
      proxyRequestTimeoutMs: this.config.proxy.requestTimeoutMs,
    }
  }

  /** Whether the standalone loopback admin page is still exposed (compatibility mode). */
  adminConsoleEnabled(): boolean {
    return this.settingsStore?.values.adminConsoleEnabled !== false
  }

  /** Toggle the standalone admin page; persisted and applied immediately. */
  async updateAdminConsoleEnabled(value: unknown): Promise<boolean> {
    if (typeof value !== 'boolean') throw new GatewayError(CODES.INVALID_PARAMS, { field: 'adminConsoleEnabled' })
    await this.settingsStore?.save({ adminConsoleEnabled: value })
    this.logger.audit({ action: 'admin.console.toggle', enabled: value })
    return value
  }

  /**
   * Apply and persist runtime switches without restarting the host. Long-running
   * side effects (tunnel process, WeChat polling) are started or stopped here.
   */
  async updateRuntimeSettings(patch: {
    tunnelEnabled?: unknown
    weixinEnabled?: unknown
    logLevel?: unknown
    proxyRequestTimeoutMs?: unknown
  }): Promise<Required<RuntimeSettings>> {
    const next: RuntimeSettings = {}
    if (patch.tunnelEnabled !== undefined) {
      if (typeof patch.tunnelEnabled !== 'boolean') throw new GatewayError(CODES.INVALID_PARAMS, { field: 'tunnelEnabled' })
      next.tunnelEnabled = patch.tunnelEnabled
    }
    if (patch.weixinEnabled !== undefined) {
      if (typeof patch.weixinEnabled !== 'boolean') throw new GatewayError(CODES.INVALID_PARAMS, { field: 'weixinEnabled' })
      next.weixinEnabled = patch.weixinEnabled
    }
    if (patch.logLevel !== undefined) {
      if (!validLogLevel(patch.logLevel)) throw new GatewayError(CODES.INVALID_PARAMS, { field: 'logLevel' })
      next.logLevel = patch.logLevel
    }
    if (patch.proxyRequestTimeoutMs !== undefined) {
      if (!validProxyTimeout(patch.proxyRequestTimeoutMs)) {
        throw new GatewayError(CODES.INVALID_PARAMS, { field: 'proxyRequestTimeoutMs' })
      }
      next.proxyRequestTimeoutMs = patch.proxyRequestTimeoutMs
    }
    if (Object.keys(next).length === 0) throw new GatewayError(CODES.INVALID_PARAMS, { field: 'settings' })

    await this.settingsStore?.save(next)

    if (next.tunnelEnabled !== undefined) {
      this.config.tunnel.enabled = next.tunnelEnabled
      if (next.tunnelEnabled) {
        try {
          await this.tunnel.start()
        } catch (error) {
          throw new GatewayError(CODES.TUNNEL_START_FAILED, { state: this.tunnel.status() }, 500, errorMessage(error))
        }
      } else {
        await this.tunnel.stop()
      }
    }
    if (next.weixinEnabled !== undefined) {
      this.config.weixin.enabled = next.weixinEnabled
      if (next.weixinEnabled) {
        await this.weixin?.start()
        await this.weixinNotifier?.start()
      } else {
        this.weixin?.stop()
        this.weixinNotifier?.stop()
      }
    }
    if (next.logLevel !== undefined) {
      this.config.log.level = next.logLevel
      this.logger.setLevel(next.logLevel)
    }
    if (next.proxyRequestTimeoutMs !== undefined) {
      this.config.proxy.requestTimeoutMs = next.proxyRequestTimeoutMs
    }

    this.logger.audit({ action: 'admin.runtime.updated', ...next })
    return this.runtimeSettings()
  }

  /** Rotate the AES/HMAC key; existing session tokens remain valid. */
  rotateSecretKey(): { rotated: boolean; activeKid: string; keyIds: string[]; sessionsInvalidated: number } {
    if (!this.secretBox) throw new GatewayError(CODES.NOT_SUPPORTED, {}, 501)
    const result = this.secretBox.rotate()
    this.logger.audit({ action: 'admin.key.rotated', activeKid: result.activeKid })
    return { rotated: true, activeKid: result.activeKid, keyIds: result.keyIds, sessionsInvalidated: 0 }
  }

  async buildHealth(): Promise<HealthPayload> {
    const checks: HealthCheck[] = []
    checks.push({
      name: 'gateway',
      ok: this.server.listening,
      data: { port: this.port, uptime: Math.floor((Date.now() - this.startedAt) / 1000) },
    })
    checks.push(await this.#checkStorage())
    checks.push(await this.#checkUpstream())
    checks.push(await this.#checkTunnel())
    checks.push(this.#checkWeixin())
    checks.push({
      name: 'capabilities',
      ok: true,
      optional: true,
      data: { ...this.capabilities() },
    })
    const ok = checks.every((check) => check.optional === true || check.ok)
    return {
      ok,
      version: this.version,
      startedAt: new Date(this.startedAt).toISOString(),
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      serverTime: new Date().toISOString(),
      checks,
    }
  }

  async #checkStorage(): Promise<HealthCheck> {
    try {
      await fsp.access(this.config.dataDir, fs.constants.W_OK)
      return { name: 'storage', ok: true, data: { dataDir: this.config.dataDir } }
    } catch (error) {
      return { name: 'storage', ok: false, detail: errorMessage(error) }
    }
  }

  async #checkUpstream(): Promise<HealthCheck> {
    const target = this.upstreamOrigin()
    if (!target) return { name: 'dsh-upstream', ok: true, detail: 'not configured', optional: true }
    let origin: string
    try {
      origin = new URL(target).origin
    } catch {
      return { name: 'dsh-upstream', ok: false, detail: `invalid upstream: ${target}` }
    }
    const probe = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
      const request = http.get(`${origin}/`, { timeout: 3000 }, (response) => {
        response.resume()
        const status = response.statusCode ?? 0
        resolve({ ok: status > 0 && status < 500, detail: `HTTP ${status}` })
      })
      request.on('timeout', () => {
        request.destroy()
        resolve({ ok: false, detail: 'timeout' })
      })
      request.on('error', (error: Error) => {
        resolve({ ok: false, detail: errorMessage(error) })
      })
    })
    return { name: 'dsh-upstream', ok: probe.ok, detail: probe.detail, data: { origin } }
  }

  async #checkTunnel(): Promise<HealthCheck> {
    if (!this.config.tunnel.enabled) {
      return { name: 'tunnel', ok: true, detail: 'disabled', optional: true, data: { enabled: false, mode: this.config.tunnel.mode } }
    }
    try {
      const health = await this.tunnel.health()
      return { name: 'tunnel', ok: health.ok, detail: health.detail, data: this.tunnel.status() as unknown as Record<string, unknown> }
    } catch (error) {
      return { name: 'tunnel', ok: false, detail: errorMessage(error) }
    }
  }

  #checkWeixin(): HealthCheck {
    if (!this.weixin || !this.config.weixin.enabled) {
      return { name: 'weixin', ok: true, detail: 'disabled', optional: true }
    }
    const status = this.weixin.status()
    const healthy = status.state === 'connected' || status.state === 'connecting' || status.state === 'idle'
    return {
      name: 'weixin',
      ok: healthy,
      optional: true,
      detail: status.state,
      data: {
        state: status.state,
        connected: status.connected,
        failures: status.failures,
        lastOkAt: status.lastOkAt,
      },
    }
  }

  statusPayload(): GatewayStatusPayload {
    const payload: GatewayStatusPayload = {
      gateway: {
        running: true,
        port: this.port,
        publicBase: this.publicBase(),
        startedAt: new Date(this.startedAt).toISOString(),
        uptime: Math.floor((Date.now() - this.startedAt) / 1000),
        version: this.version,
      },
      tunnel: this.tunnel.status(),
      proxy: { running: true },
      activeDevices: this.devices.listActive().length,
      onlineDevices: [...this.devices.sockets.keys()].length,
      stats: this.stats?.summary(7) ?? null,
      serverTime: new Date().toISOString(),
      capabilities: this.capabilities(),
    }
    if (this.weixin) payload.weixin = this.weixin.status()
    if (this.weixinNotifier) payload.notifier = this.weixinNotifier.status()
    return payload
  }

  // ---------------------------------------------------------------------------
  // Request admission
  // ---------------------------------------------------------------------------

  /** @param {import('node:http').IncomingMessage} req */
  #hostInfo(req: IncomingMessage): HostInfo | null {
    const hostHeader = String(req.headers.host ?? '').toLowerCase()
    if (!hostHeader) return null
    let parsed: URL
    try {
      parsed = new URL(`http://${hostHeader}`)
    } catch {
      return null
    }
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const loopback = isLoopbackAddress(hostname)
    const proxied = isProxiedRequest(req)
    const tunnelHosts = this.tunnel.tunnelHosts()
    const tunnel = !loopback && (tunnelHosts.has(hostname) || tunnelHosts.has(hostHeader))
    const local = loopback && !proxied
    if (!loopback && !tunnel) return null
    return { hostHeader, hostname, port: parsed.port, loopback, tunnel, local, proxied }
  }

  #checkOrigin(req: IncomingMessage, info: HostInfo): boolean {
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin) {
      if (origin === 'null') return false
      try {
        const url = new URL(origin)
        if (url.host.toLowerCase() !== info.hostHeader) return false
      } catch {
        return false
      }
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    return true
  }

  #isSecure(req: IncomingMessage, info: HostInfo): boolean {
    const mode = this.config.security.secureCookies
    if (mode === 'always') return true
    if (mode === 'never') return false
    return info.tunnel || requestProtocol(req, this.config.security.trustProxy) === 'https'
  }

  #securityHeaders(res: ServerResponse, secure: boolean): void {
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    if (secure) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains')
  }

  setSessionCookie(req: IncomingMessage, res: ServerResponse, info: HostInfo, token: string, maxAge: number): void {
    res.setHeader(
      'set-cookie',
      serializeCookie(SESSION_COOKIE, token, {
        path: '/',
        maxAge,
        httpOnly: true,
        secure: this.#isSecure(req, info),
        sameSite: 'Strict',
      }),
    )
  }

  /**
   * Sliding session: once an active device is past half of its cookie lifetime,
   * rotate the cookie so daily use does not require re-pairing. Idle sessions
   * still expire normally.
   */
  #maybeRenewSession(req: IncomingMessage, res: ServerResponse, info: HostInfo, payload: SessionPayload): void {
    const lifetime = this.config.auth.sessionMaxAge * 1000
    if (payload.expiresAt - Date.now() > lifetime / 2) return
    const session = this.sessions.issue(payload.deviceId)
    this.setSessionCookie(req, res, info, session.token, session.maxAge)
    this.logger?.debug('Session cookie rotated (sliding expiry)')
  }

  clearSessionCookie(req: IncomingMessage, res: ServerResponse, info: HostInfo): void {
    res.setHeader(
      'set-cookie',
      serializeCookie(SESSION_COOKIE, '', {
        path: '/',
        maxAge: 0,
        httpOnly: true,
        secure: this.#isSecure(req, info),
        sameSite: 'Strict',
      }),
    )
  }

  async #handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://gateway.local')
    } catch {
      res.statusCode = 400
      res.end('Bad Request')
      return
    }
    const info = this.#hostInfo(req)
    if (!info) {
      this.logger.warn(`Rejected request with untrusted Host: ${req.headers.host}`)
      this.sendJson(req, res, CODES.PERMISSION_DENIED, {}, 403)
      return
    }
    if (!this.#checkOrigin(req, info)) {
      this.sendJson(req, res, CODES.PERMISSION_DENIED, {}, 403)
      return
    }
    const secure = this.#isSecure(req, info)
    this.#securityHeaders(res, secure)
    this.#applyCors(req, res)
    try {
      await this.#route(req, res, url, info)
    } catch (error) {
      this.#handleError(req, res, url, error)
    }
  }

  #applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin
    if (typeof origin === 'string' && this.config.security.corsOrigins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('access-control-allow-credentials', 'true')
      res.setHeader('access-control-allow-headers', 'content-type,x-requested-with')
      res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
      res.setHeader('vary', 'origin')
    }
  }

  async #route(req: IncomingMessage, res: ServerResponse, url: URL, info: HostInfo): Promise<void> {
    const pathname = url.pathname
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    // Public surface: health, /admin redirect, pairing status/verify, OAuth callback.
    const publicPeer: LocalPeer = { device: null, deviceId: 'local', local: true }
    if (await this.publicRouter.handle({ req, res, url, info, peer: publicPeer, params: [], gateway: this })) {
      return
    }

    // Public static assets and the pairing page.
    if (this.#isPublicStatic(pathname)) {
      await this.#serveStatic(req, res, pathname, info)
      return
    }

    // The standalone admin page is a compatibility surface; the DSH workbench
    // is the primary UI. Disabling it keeps the loopback APIs available.
    if ((pathname === '/mobile/admin' || pathname === '/mobile/admin/') && !this.adminConsoleEnabled()) {
      this.sendJson(req, res, CODES.NOT_SUPPORTED, {}, 404)
      return
    }

    // First-run local bootstrap: the admin page and its pairing endpoints are
    // reachable from loopback before a device is paired.
    if (info.local && (pathname === '/mobile/admin' || pathname === '/mobile/admin/')) {
      await this.#serveStatic(req, res, pathname, info)
      return
    }

    // Everything below requires a valid device session, except the local
    // bootstrap/admin surface handled by #authenticate (loopback + not proxied).
    const peer = await this.#authenticate(req, res, url, info)
    if (!peer) return
    if (peer.device) this.stats?.record(peer.deviceId)

    if (pathname.startsWith('/mobile/api/v1/')) {
      if (this.#isMutating(req.method)) this.assertCsrf(req)
      const limited = info.local
        ? { ok: true, remaining: this.config.security.rateLimitMax, retryAfter: 0 }
        : this.rateLimiter.hit(`${requestIp(req, this.config.security.trustProxy)}|${userAgentHash(req)}`)
      if (!limited.ok) {
        res.setHeader('retry-after', String(limited.retryAfter))
        res.setHeader('x-ratelimit-limit', String(this.config.security.rateLimitMax))
        res.setHeader('x-ratelimit-remaining', '0')
        this.sendJson(req, res, CODES.RATE_LIMITED, { retryAfter: limited.retryAfter }, 429)
        return
      }
      res.setHeader('x-ratelimit-limit', String(this.config.security.rateLimitMax))
      res.setHeader('x-ratelimit-remaining', String(limited.remaining))
      const handled = await this.apiRouter.handle({ req, res, url, info, peer, params: [], gateway: this })
      if (!handled) this.sendJson(req, res, CODES.NOT_SUPPORTED, {}, 404)
      return
    }

    if (pathname.startsWith('/mobile/')) {
      await this.#serveStatic(req, res, pathname, info)
      return
    }

    // Workbench management and local-only reads: a paired phone reaches DSH
    // through this proxy, so refuse the local-only prefixes before forwarding.
    // (The DSH-side bridge independently checks the classification header.)
    if (!info.local && isWorkbenchLocalOnlyPath(pathname)) {
      this.sendJson(req, res, CODES.PERMISSION_DENIED, {}, 403)
      return
    }

    // DSH reverse proxy.
    if (!peer.device) {
      this.sendJson(req, res, CODES.PERMISSION_DENIED, {}, 403)
      return
    }
    this.devices.touch(peer.device.deviceId, requestIp(req, this.config.security.trustProxy))
    try {
      await this.cookieProvider.get()
    } catch (error) {
      this.sendJson(req, res, CODES.TUNNEL_NOT_CONNECTED, {}, 503)
      return
    }
    await this.proxy.handleHttp(req, res, { deviceId: peer.device.deviceId })
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   * @param {NonNullable<ReturnType<Gateway['#hostInfo']>>} info
   */
  async #authenticate(req: IncomingMessage, res: ServerResponse, url: URL, info: HostInfo): Promise<Peer | null> {
    if (
      info.local &&
      (url.pathname.startsWith('/mobile/api/v1/admin/') ||
        url.pathname === '/mobile/api/v1/logs' ||
        url.pathname === '/mobile/api/v1/status' ||
        url.pathname === '/mobile/api/v1/devices' ||
        url.pathname.startsWith('/mobile/api/v1/devices/'))
    ) {
      return { device: null, deviceId: 'local', local: true }
    }
    const cookies = parseCookies(req.headers.cookie)
    const token = cookies[SESSION_COOKIE]
    const result = this.sessions.verify(token)
    if (!result.ok) {
      if (this.wantsJson(req, url.pathname)) {
        this.sendJson(req, res, result.code, {}, httpStatusFor(result.code))
      } else {
        this.#redirectToPair(req, res, url)
      }
      return null
    }
    let device: Device
    try {
      device = this.devices.requireActive(result.payload.deviceId)
    } catch (error) {
      if (this.wantsJson(req, url.pathname)) {
        const gatewayError = error instanceof GatewayError ? error : new GatewayError(CODES.DEVICE_REVOKED)
        this.sendJson(req, res, gatewayError.code, gatewayError.data, gatewayError.httpStatus)
      } else {
        this.#redirectToPair(req, res, url)
      }
      return null
    }
    this.devices.touch(device.deviceId, requestIp(req, this.config.security.trustProxy))
    this.#maybeRenewSession(req, res, info, result.payload)
    if (this.config.auth.requireOAuth && device.oauthBindings.length === 0) {
      const allowed =
        url.pathname === '/mobile/api/v1/me' ||
        url.pathname.startsWith('/mobile/api/v1/oauth/') ||
        url.pathname === '/mobile/api/v1/logout' ||
        url.pathname === '/mobile/api/v1/status' ||
        url.pathname === '/mobile/oauth' ||
        url.pathname === '/mobile/oauth/' ||
        url.pathname.startsWith('/mobile/assets/')
      if (!allowed) {
        if (this.wantsJson(req, url.pathname)) {
          this.sendJson(req, res, CODES.OAUTH_REQUIRED, { providers: this.oauth.enabledProviders() }, 403)
        } else {
          const next = encodeURIComponent(url.pathname + url.search)
          res.statusCode = 302
          res.setHeader('location', `/mobile/oauth?next=${next}`)
          res.end()
        }
        return null
      }
    }
    return { device, deviceId: device.deviceId, local: info.local }
  }

  wantsJson(req: IncomingMessage, pathname: string): boolean {
    if (pathname.startsWith('/mobile/api/')) return true
    if (pathname.startsWith('/api')) return true
    const accept = String(req.headers.accept ?? '').toLowerCase()
    return accept.includes('application/json') || req.headers['x-requested-with'] === 'XMLHttpRequest'
  }

  #redirectToPair(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const next = encodeURIComponent(url.pathname + url.search)
    res.statusCode = 302
    res.setHeader('location', `/mobile/pair?next=${next}`)
    res.end()
  }

  #isMutating(method?: string): boolean {
    return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method ?? '').toUpperCase())
  }

  assertCsrf(req: IncomingMessage): void {
    const header = req.headers['x-requested-with']
    if (typeof header !== 'string' || header.toLowerCase() !== 'xmlhttprequest') {
      throw new GatewayError(CODES.CSRF_FAILED)
    }
  }

  #isPublicStatic(pathname: string): boolean {
    return (
      pathname === '/mobile/pair' ||
      pathname === '/mobile/pair/' ||
      pathname.startsWith('/mobile/assets/') ||
      pathname === '/mobile/manifest.webmanifest' ||
      pathname === '/mobile/sw.js' ||
      pathname === '/mobile/icon.svg'
    )
  }

  // ---------------------------------------------------------------------------
  // Pairing + auth endpoints
  // ---------------------------------------------------------------------------

  async handlePairVerify(req: IncomingMessage, res: ServerResponse, info: HostInfo): Promise<void> {
    const key = `${requestIp(req, this.config.security.trustProxy)}|${userAgentHash(req)}`
    const locked = this.pairingLockout.check(key)
    if (locked.locked) {
      this.sendJson(req, res, CODES.RATE_LIMITED, { retryAfter: locked.retryAfter }, 429)
      return
    }
    let body: Record<string, unknown>
    try {
      body = await this.readJson(req, 8 * 1024)
    } catch (error) {
      const gatewayError = error instanceof GatewayError ? error : new GatewayError(CODES.INVALID_PARAMS)
      this.sendJson(req, res, gatewayError.code, gatewayError.data, gatewayError.httpStatus)
      return
    }
    const code = typeof body.pairingToken === 'string' ? body.pairingToken : String(body.code ?? '')
    const deviceName = typeof body.deviceName === 'string' ? body.deviceName : ''
    try {
      this.pairing.consume(code, deviceName)
      const device = this.devices.register({
        deviceName: deviceName || describeDevice(userAgent(req)) || 'Mobile device',
        userAgent: userAgent(req),
        ip: requestIp(req, this.config.security.trustProxy),
      })
      const session = this.sessions.issue(device.deviceId)
      this.setSessionCookie(req, res, info, session.token, session.maxAge)
      this.pairingLockout.success(key)
      this.logger.audit({ action: 'pairing.success', deviceId: device.deviceId, deviceName: device.deviceName })
      this.sendJson(req, res, CODES.SUCCESS, {
        deviceId: device.deviceId,
        expiresAt: new Date(session.expiresAt).toISOString(),
        requireOAuth: this.config.auth.requireOAuth,
        oauthProviders: this.config.auth.requireOAuth ? this.oauth.enabledProviders() : this.oauth.enabledProviders(),
      })
    } catch (error) {
      const gatewayError = error instanceof GatewayError ? error : new GatewayError(CODES.PAIRING_FAILED, {}, 400, errorMessage(error))
      if (([CODES.PAIRING_FAILED, CODES.INVALID_PAIRING_CODE] as number[]).includes(gatewayError.code)) {
        const failure = this.pairingLockout.fail(key)
        this.logger.audit({ action: 'pairing.failure', ip: requestIp(req, this.config.security.trustProxy), locked: failure.locked })
        this.sendJson(req, res, gatewayError.code, {
          ...gatewayError.data,
          remainingAttempts: failure.remaining,
          retryAfter: failure.locked ? failure.retryAfter : undefined,
        }, gatewayError.httpStatus)
      } else {
        this.sendJson(req, res, gatewayError.code, gatewayError.data, gatewayError.httpStatus)
      }
    }
  }

  async pairingPayload(): Promise<PairingPayload> {
    const current = this.pairing.describe()
    const base = this.publicBase()
    const pairingUrl = `${base}/mobile/pair#pairing=${current.code}`
    const changedAt = this.urlChangedAt
    return {
      code: current.formatted,
      codeRaw: current.code,
      expiresIn: current.expiresIn,
      expiresAt: new Date(current.expiresAt).toISOString(),
      pairingUrl,
      qrSvg: await this.qrSvg(pairingUrl),
      tunnel: this.tunnel.status(),
      status: this.pairing.status(),
      previousUrl: this.previousPublicBase,
      urlChangedAt: changedAt,
      repairedSinceChange:
        changedAt > 0 &&
        [...this.devices.devices.values()].some((device) => device.createdAt > changedAt),
    }
  }

  async qrSvg(text: string): Promise<string> {
    try {
      const module = await import('qrcode')
      const QRCode = module.default ?? module
      return await QRCode.toString(text, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M' })
    } catch (error) {
      this.logger.warn(`QR generation unavailable: ${errorMessage(error)}`)
      return ''
    }
  }

  async handleOAuthCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const limited = this.oauthLimiter.hit(requestIp(req, this.config.security.trustProxy))
    if (!limited.ok) {
      this.sendHtml(req, res, 429, '<!doctype html><meta charset="utf-8"><title>429</title><p>Too many OAuth attempts. Retry later.</p>')
      return
    }
    const match = /^\/auth\/(github|gitee)\/callback$/.exec(url.pathname)
    if (!match) {
      res.statusCode = 404
      res.end('Not Found')
      return
    }
    const provider = match[1] ?? ''
    if (provider !== 'github' && provider !== 'gitee') {
      this.sendHtml(req, res, 400, this.oauth.callbackPage({ ok: false, provider, message: '不支持的 OAuth 提供商' }))
      return
    }
    const error = url.searchParams.get('error')
    if (error) {
      const message = url.searchParams.get('error_description') ?? error
      this.logger.warn(`OAuth callback error: ${message}`)
      this.sendHtml(req, res, 400, this.oauth.callbackPage({ ok: false, provider, message }))
      return
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state) {
      this.sendHtml(req, res, 400, this.oauth.callbackPage({ ok: false, provider, message: '缺少 code 或 state' }))
      return
    }
    try {
      const result = await this.oauth.handleCallback(provider, code, state)
      this.logger.audit({ action: 'oauth.callback', provider, deviceId: result.deviceId, username: result.binding.username })
      this.sendHtml(req, res, 200, this.oauth.callbackPage({ ok: true, provider, username: result.binding.username }))
    } catch (errorObject) {
      const message = errorObject instanceof GatewayError ? messageFor(errorObject.code) : 'OAuth 处理失败'
      this.logger.warn(`OAuth callback failed: ${errorMessage(errorObject)}`)
      this.sendHtml(req, res, 400, this.oauth.callbackPage({ ok: false, provider, message }))
    }
  }

  // ---------------------------------------------------------------------------
  // Static files
  // ---------------------------------------------------------------------------

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} pathname
   * @param {NonNullable<ReturnType<Gateway['#hostInfo']>>} info
   */
  async #serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, info: HostInfo): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    if (pathname === '/mobile' || pathname === '/mobile/') {
      await this.#sendFile(req, res, path.join(WEB_ROOT, 'app.html'), { cache: false })
      return
    }
    if (PAGE_ROUTES.has(pathname)) {
      // The admin page is only served to loopback callers; remote devices get 404.
      if ((pathname.startsWith('/mobile/admin')) && !info.local) {
        res.statusCode = 404
        res.end('Not Found')
        return
      }
      await this.#sendFile(req, res, path.join(WEB_ROOT, PAGE_ROUTES.get(pathname)!), { cache: false })
      return
    }
    if (pathname === '/mobile/manifest.webmanifest') {
      await this.#sendFile(req, res, path.join(WEB_ROOT, 'manifest.webmanifest'), { cache: true })
      return
    }
    if (pathname === '/mobile/sw.js') {
      await this.#sendFile(req, res, path.join(WEB_ROOT, 'sw.js'), { cache: false })
      return
    }
    if (pathname === '/mobile/icon.svg') {
      await this.#sendFile(req, res, path.join(WEB_ROOT, 'icon.svg'), { cache: true })
      return
    }
    if (pathname.startsWith('/mobile/assets/')) {
      const relative = pathname.slice('/mobile/assets/'.length)
      const target = path.resolve(WEB_ROOT, 'assets', relative)
      if (!target.startsWith(path.resolve(WEB_ROOT, 'assets') + path.sep)) {
        res.statusCode = 403
        res.end('Forbidden')
        return
      }
      await this.#sendFile(req, res, target, { cache: false })
      return
    }
    res.statusCode = 404
    res.end('Not Found')
  }

  /**
   * Rewrite `/mobile/assets/<file>` references in served HTML to the content
   * hash recorded by `web/assets/build.json`, so a rebuilt bundle is fetched
   * even if a page's hard-coded `?v=` was not bumped. Missing manifest or
   * unknown files keep their original URL.
   */
  #injectAssetVersions(html: string): string {
    const versions = this.#assetVersions()
    if (Object.keys(versions).length === 0) return html
    return html.replace(
      /\/mobile\/assets\/([A-Za-z0-9._-]+\.(?:js|css))(?:\?v=[^"'\s>]*)?/g,
      (match, name: string) => {
        const hash = versions[name]
        return hash ? `/mobile/assets/${name}?v=${hash}` : match
      },
    )
  }

  #assetVersions(): Record<string, string> {
    if (this.#assetManifest !== null) return this.#assetManifest
    const assets: Record<string, string> = {}
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, 'assets', 'build.json'), 'utf8')) as {
        assets?: Record<string, unknown>
      }
      for (const [name, hash] of Object.entries(parsed.assets ?? {})) {
        if (typeof hash === 'string' && /^[0-9a-f]{4,64}$/i.test(hash)) assets[name] = hash
      }
    } catch {
      // No build manifest yet (source checkout before `npm run build`).
    }
    this.#assetManifest = assets
    return assets
  }

  async #sendFile(req: IncomingMessage, res: ServerResponse, file: string, options: { cache: boolean }): Promise<void> {
    let data: Buffer
    try {
      data = await fsp.readFile(file)
    } catch {
      res.statusCode = 404
      res.end('Not Found')
      return
    }
    const type = mimeType(file)
    const isHtml = type.startsWith('text/html')
    if (isHtml) {
      data = Buffer.from(this.#injectAssetVersions(data.toString('utf8')), 'utf8')
      res.setHeader(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      )
      res.setHeader('cache-control', 'no-store')
    } else {
      res.setHeader('cache-control', options.cache ? 'public, max-age=31536000, immutable' : 'no-cache')
    }
    res.setHeader('content-type', type)
    res.setHeader('content-length', String(data.length))
    if (options.cache) res.setHeader('etag', `"${data.length.toString(16)}"`)
    if (req.method === 'GET' && /text|javascript|json|svg/.test(type) && String(req.headers['accept-encoding'] ?? '').includes('gzip')) {
      data = zlib.gzipSync(data, { level: 6 })
      res.setHeader('content-encoding', 'gzip')
      res.setHeader('content-length', String(data.length))
    }
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    res.end(data)
  }

  // ---------------------------------------------------------------------------
  // WebSocket control endpoint + DSH proxy upgrade
  // ---------------------------------------------------------------------------

  async #handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://gateway.local')
    } catch {
      socket.destroy()
      return
    }
    const info = this.#hostInfo(req)
    if (!info || !this.#checkOrigin(req, info)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (url.pathname === '/mobile/ws') {
      await this.#handleMobileWs(req, socket, head, info)
      return
    }
    const peer = await this.#authenticateUpgrade(req, url, info)
    if (!peer) return
    if (this.config.auth.requireOAuth && peer.device.oauthBindings.length === 0) {
      req.socket?.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      req.socket?.destroy()
      return
    }
    this.devices.touch(peer.device.deviceId, requestIp(req, this.config.security.trustProxy))
    try {
      await this.cookieProvider.get()
    } catch {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    this.proxy.handleUpgrade(req, socket, head, { deviceId: peer.deviceId })
  }

  async #handleMobileWs(req: IncomingMessage, socket: Duplex, head: Buffer, info: HostInfo): Promise<void> {
    if (!this.#checkOrigin(req, info)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const cookies = parseCookies(req.headers.cookie)
    const result = this.sessions.verify(cookies[SESSION_COOKIE])
    if (!result.ok) {
      const connection = acceptWebSocket(req, socket, head, { logger: this.logger, heartbeatInterval: this.config.proxy.wsHeartbeatInterval })
      connection?.close(4001, 'unauthenticated')
      return
    }
    let device: Device
    try {
      device = this.devices.requireActive(result.payload.deviceId)
    } catch {
      const connection = acceptWebSocket(req, socket, head, { logger: this.logger, heartbeatInterval: this.config.proxy.wsHeartbeatInterval })
      connection?.close(4002, 'device revoked')
      return
    }
    if (this.config.auth.requireOAuth && device.oauthBindings.length === 0) {
      const connection = acceptWebSocket(req, socket, head, { logger: this.logger, heartbeatInterval: this.config.proxy.wsHeartbeatInterval })
      connection?.close(4003, 'oauth required')
      return
    }
    const connection = acceptWebSocket(req, socket, head, {
      logger: this.logger,
      heartbeatInterval: this.config.proxy.wsHeartbeatInterval,
    })
    if (!connection) return
    this.wsClients.add(connection)
    this.devices.attachSocket(device.deviceId, connection.socket)
    connection.on('message', (text: string) => this.#onMobileWsMessage(connection, device, text))
    connection.on('close', () => {
      this.wsClients.delete(connection)
    })
    connection.sendText(
      JSON.stringify({
        type: 'ready',
        id: 'ready',
        timestamp: Date.now(),
        payload: {
          protocolVersion: 1,
          deviceId: device.deviceId,
          gatewayVersion: this.version,
          publicBase: this.publicBase(),
          tunnel: this.tunnel.status(),
        },
      }),
    )
  }

  #onMobileWsMessage(connection: WsConnection, device: Device, text: string): void {
    let message: Record<string, unknown>
    try {
      const parsed = JSON.parse(text) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
      message = parsed as Record<string, unknown>
    } catch {
      connection.close(4003, 'invalid json')
      return
    }
    if (typeof message.type !== 'string') {
      connection.close(4003, 'invalid message')
      return
    }
    const now = Date.now()
    const window = connection._rateWindow ?? { start: now, count: 0 }
    if (now - window.start > 10_000) {
      window.start = now
      window.count = 0
    }
    window.count += 1
    connection._rateWindow = window
    if (window.count > 20) {
      connection.close(4004, 'rate limited')
      return
    }
    const id = typeof message.id === 'string' ? message.id : ''
    if (message.type === 'ping') {
      connection.sendText(JSON.stringify({ type: 'pong', id, timestamp: Date.now(), payload: {} }))
      return
    }
    if (message.type === 'status.get') {
      connection.sendText(JSON.stringify({ type: 'gateway.status', id, timestamp: Date.now(), payload: this.statusPayload() }))
      return
    }
    if (['chat.send', 'chat.stop', 'approval.respond', 'file.upload'].includes(message.type)) {
      connection.sendText(
        JSON.stringify({
          type: 'error',
          id,
          timestamp: Date.now(),
          payload: { code: CODES.NOT_SUPPORTED, message: messageFor(CODES.NOT_SUPPORTED) },
        }),
      )
      return
    }
    connection.close(4003, 'unknown message type')
  }

  async #authenticateUpgrade(req: IncomingMessage, url: URL, info: HostInfo): Promise<DevicePeer | null> {
    const cookies = parseCookies(req.headers.cookie)
    const result = this.sessions.verify(cookies[SESSION_COOKIE])
    if (!result.ok) {
      req.socket?.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      req.socket?.destroy()
      return null
    }
    try {
      const device = this.devices.requireActive(result.payload.deviceId)
      return { device, deviceId: device.deviceId, local: info.local }
    } catch {
      req.socket?.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      req.socket?.destroy()
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Small HTTP helpers
  // ---------------------------------------------------------------------------

  async readJson(req: IncomingMessage, maxBytes = JSON_BODY_LIMIT): Promise<Record<string, unknown>> {
    const type = String(req.headers['content-type'] ?? '')
    if (!type.toLowerCase().includes('application/json')) throw new GatewayError(CODES.INVALID_PARAMS, {}, 415)
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      size += buffer.length
      if (size > maxBytes) throw new GatewayError(CODES.INVALID_PARAMS, {}, 413)
      chunks.push(buffer)
    }
    if (size === 0) return {}
    let body: unknown
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new GatewayError(CODES.INVALID_PARAMS)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GatewayError(CODES.INVALID_PARAMS)
    return body as Record<string, unknown>
  }

  sendJson(req: IncomingMessage, res: ServerResponse, code: number, data: unknown = {}, status?: number): void {
    if (res.headersSent) return
    const language = languageOf(String(req.headers['accept-language'] ?? ''))
    const body = code === CODES.SUCCESS
      ? { code, message: messageFor(code, language), data }
      : errorBody(code, data as Record<string, unknown>, language)
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    res.statusCode = status ?? httpStatusFor(code)
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('content-length', String(payload.length))
    res.setHeader('cache-control', 'no-store')
    res.end(payload)
  }

  sendHtml(_req: IncomingMessage, res: ServerResponse, status: number, body: string): void {
    const payload = Buffer.from(body, 'utf8')
    res.statusCode = status
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('content-length', String(payload.length))
    res.setHeader('cache-control', 'no-store')
    res.end(payload)
  }

  #handleError(req: IncomingMessage, res: ServerResponse, url: URL, error: unknown): void {
    if (res.headersSent) {
      res.destroy()
      return
    }
    const language = languageOf(String(req.headers['accept-language'] ?? ''))
    if (error instanceof GatewayError) {
      if (error.httpStatus >= 500) this.logger.error(`API error: ${error.detail || error.message}`)
      if (this.wantsJson(req, url.pathname) || url.pathname.startsWith('/mobile/api/')) {
        this.sendJson(req, res, error.code, error.data, error.httpStatus)
      } else {
        this.sendHtml(
          req,
          res,
          error.httpStatus,
          `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(messageFor(error.code, language))}</title><body style="background:#0D0D0F;color:#E8E8EC;font-family:system-ui;padding:24px"><p>${escapeHtml(messageFor(error.code, language))}</p><p><a style="color:#4F8FFF" href="/mobile/">返回</a></p></body>`,
        )
      }
      return
    }
    this.logger.error(`Unhandled gateway error: ${errorMessage(error)}`)
    this.sendJson(req, res, CODES.INTERNAL_ERROR, {}, 500)
  }
}

export { PAGE_ROUTES, WEB_ROOT }
