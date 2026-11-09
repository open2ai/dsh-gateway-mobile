/**
 * Cloudflare Tunnel process manager.
 *
 * Quick mode runs `cloudflared tunnel --url http://127.0.0.1:<gatewayPort>` as
 * an outbound-only child and parses the printed trycloudflare.com URL.
 * Named mode runs `cloudflared tunnel run --token ... --metrics
 * 127.0.0.1:<metricsPort>` and uses cloudflared's local readiness endpoint
 * (`GET /ready`) instead of parsing stdout.
 *
 * Both modes reconnect with capped exponential backoff and expose a small
 * status object for the admin UI and the deep-health API.
 *
 * @module dsh-gateway-mobile/lib/tunnel
 */

import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import type { Readable } from 'node:stream'
import { CODES, GatewayError } from './errors.js'
import { resolveCloudflared } from './cloudflared.js'
import type { GatewayConfig } from './config.js'
import type { Logger } from './logger.js'
import { errorMessage, sleep, stripAnsi } from './util.js'

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi

/** Readiness probe budget for a freshly spawned Named Tunnel. */
const DEFAULT_READY_TIMEOUT_MS = 20_000
const DEFAULT_READY_POLL_INTERVAL_MS = 500
const READY_REQUEST_TIMEOUT_MS = 1_000

export type TunnelState = 'disabled' | 'starting' | 'connected' | 'reconnecting' | 'stopped' | 'error' | 'degraded'

export type TunnelHealth = 'ok' | 'degraded' | 'unknown' | 'disabled'

export interface TunnelStatus {
  enabled: boolean
  mode: string
  state: TunnelState
  connected: boolean
  url: string
  publicBase: string
  attempts: number
  startedAt: number
  uptime: number
  lastError: string
  binary: string
  protocol: string
  /** Live health, derived from the state in Quick mode and probed in Named mode. */
  health: TunnelHealth
  /** Epoch ms of the last successful readiness check; 0 = never. */
  lastHealthyAt: number
  /** Loopback metrics/readiness port used by Named mode. */
  metricsPort: number
  /** Ready connector count reported by cloudflared (Named mode). */
  connectors?: number
  /** Number of explicit restart() calls since the manager was created. */
  restarts: number
  /** Epoch ms when a new public URL replaced a previously known one; 0 = never changed. */
  lastUrlChangedAt: number
}

interface TunnelChild extends EventEmitter {
  stdout: Readable
  stderr: Readable
  exitCode: number | null
  kill(signal?: NodeJS.Signals): boolean
}

type TunnelSpawn = (command: string, args: string[], options: SpawnOptions) => TunnelChild

/** Minimal HTTP response shape the readiness probe needs (injectable for tests). */
export interface TunnelFetchResponse {
  ok: boolean
  status?: number
  json?(): Promise<unknown>
}

/** Injectable fetch used for the cloudflared `/ready` probe. */
export type TunnelFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<TunnelFetchResponse>

export interface TunnelManagerOptions {
  config: GatewayConfig
  logger: Logger
  gatewayPort: () => number
  spawnImpl?: TunnelSpawn
  /** Override the readiness probe (defaults to global fetch). */
  fetchImpl?: TunnelFetch
  /** Overall readiness budget for Named mode (default 20000 ms). */
  readyTimeoutMs?: number
  /** Delay between readiness probes (default 500 ms). */
  readyPollIntervalMs?: number
}

/** Extract the Quick Tunnel URL from one cloudflared output line. */
export function parseQuickTunnelUrl(line: unknown): string {
  URL_PATTERN.lastIndex = 0
  const match = URL_PATTERN.exec(String(line ?? ''))
  return match ? match[0] : ''
}

export class TunnelManager extends EventEmitter {
  attempts: number
  binary: string
  child: TunnelChild | null
  children: Set<TunnelChild>
  config: GatewayConfig
  connectors: number | undefined
  fetchImpl: TunnelFetch
  gatewayPort: () => number
  lastError: string
  lastHealthyAt: number
  lastUrlChangedAt: number
  logger: Logger
  readyPollIntervalMs: number
  readyTimeoutMs: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  restarts: number
  spawnImpl: TunnelSpawn
  startPromise: Promise<TunnelStatus> | null
  startedAt: number
  state: TunnelState
  stopping: boolean
  url: string
  #health: TunnelHealth
  #healthTimer: ReturnType<typeof setInterval> | null

  constructor(options: TunnelManagerOptions) {
    super()
    this.config = options.config
    this.logger = options.logger
    this.gatewayPort = options.gatewayPort
    this.state = this.config.tunnel.enabled ? 'stopped' : 'disabled'
    this.#health = this.config.tunnel.enabled ? 'unknown' : 'disabled'
    this.url = ''
    this.binary = ''
    this.child = null
    this.attempts = 0
    this.startedAt = 0
    this.lastError = ''
    this.lastHealthyAt = 0
    this.lastUrlChangedAt = 0
    this.restarts = 0
    this.stopping = false
    this.children = new Set()
    this.reconnectTimer = null
    this.startPromise = null
    this.connectors = undefined
    this.readyTimeoutMs = Math.max(0, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
    this.readyPollIntervalMs = Math.max(1, options.readyPollIntervalMs ?? DEFAULT_READY_POLL_INTERVAL_MS)
    this.spawnImpl = options.spawnImpl ?? (spawn as unknown as TunnelSpawn)
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.#healthTimer = null
  }

  get connected(): boolean {
    return this.state === 'connected'
  }

  /** Loopback metrics/readiness port for Named mode. */
  metricsPort(): number {
    return this.config.tunnel.metricsPort || this.gatewayPort() + 1000
  }

  /** Host names accepted from the tunnel side, for Host validation. */
  tunnelHosts(): Set<string> {
    const hosts = new Set<string>()
    if (this.url) {
      try {
        hosts.add(new URL(this.url).host.toLowerCase())
      } catch {
        // ignore
      }
    }
    if (this.config.tunnel.domain) hosts.add(this.config.tunnel.domain.toLowerCase())
    if (this.config.gateway.publicUrl) {
      try {
        hosts.add(new URL(this.config.gateway.publicUrl).host.toLowerCase())
      } catch {
        // ignore
      }
    }
    return hosts
  }

  /** Last known public base URL (tunnel or configured public URL). */
  publicBase(fallback: string): string {
    if (this.config.gateway.publicUrl) return this.config.gateway.publicUrl.replace(/\/+$/, '')
    if (this.url) return this.url.replace(/\/+$/, '')
    if (this.config.tunnel.domain) return `https://${this.config.tunnel.domain}`.replace(/\/+$/, '')
    return fallback
  }

  status(): TunnelStatus {
    const status: TunnelStatus = {
      enabled: this.config.tunnel.enabled,
      mode: this.config.tunnel.mode,
      state: this.state,
      connected: this.connected,
      url: this.url || '',
      publicBase: this.publicBase(''),
      attempts: this.attempts,
      startedAt: this.startedAt,
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      lastError: this.lastError,
      binary: this.binary,
      protocol: this.config.tunnel.protocol,
      health: this.#effectiveHealth(),
      lastHealthyAt: this.lastHealthyAt,
      metricsPort: this.metricsPort(),
      restarts: this.restarts,
      lastUrlChangedAt: this.lastUrlChangedAt,
    }
    if (this.connectors !== undefined) status.connectors = this.connectors
    return status
  }

  /**
   * Live health probe.
   *
   * Quick mode: `connected` is healthy. Named mode: probe `/ready` on the
   * loopback metrics port. Disabled: healthy by definition.
   */
  async health(): Promise<{ ok: boolean; detail: string }> {
    if (!this.config.tunnel.enabled || this.state === 'disabled') return { ok: true, detail: 'disabled' }
    if (this.config.tunnel.mode === 'named') return this.#checkNamedHealth()
    if (this.state === 'connected') return { ok: true, detail: 'state=connected' }
    return { ok: false, detail: this.lastError || `state=${this.state}` }
  }

  /** Derive the status health for Quick mode / disabled; Named uses the last probe. */
  #effectiveHealth(): TunnelHealth {
    if (!this.config.tunnel.enabled) return 'disabled'
    if (this.config.tunnel.mode === 'named') return this.#health
    switch (this.state) {
      case 'connected':
        return 'ok'
      case 'reconnecting':
      case 'error':
      case 'degraded':
        return 'degraded'
      case 'disabled':
        return 'disabled'
      default:
        return 'unknown'
    }
  }

  #setState(state: TunnelState, extra: { startedAt?: number; lastError?: string } = {}): void {
    this.state = state
    Object.assign(this, extra)
    const status = this.status()
    this.logger.info(`Tunnel state: ${state}${status.url ? ` (${status.url})` : ''}`)
    this.emit('status', status)
  }

  /** Start the tunnel (idempotent). */
  async start(): Promise<TunnelStatus> {
    if (!this.config.tunnel.enabled) {
      this.#setState('disabled')
      return this.status()
    }
    if (this.startPromise) return this.startPromise
    if (this.child && (this.state === 'starting' || this.state === 'connected' || this.state === 'degraded')) {
      // Idempotent: never spawn a second cloudflared for the same manager.
      return this.status()
    }
    if (this.child) {
      await this.stop()
    }
    this.stopping = false
    this.attempts = 0
    this.startPromise = this.#start()
      .catch((error: unknown) => {
        const message = errorMessage(error)
        this.lastError = message
        this.#setState('error', { lastError: message })
        this.logger.error(`Tunnel start failed: ${message}`)
        throw error instanceof GatewayError ? error : new GatewayError(CODES.TUNNEL_START_FAILED, {}, 500, message)
      })
      .finally(() => {
        this.startPromise = null
      })
    return this.startPromise
  }

  async #start(): Promise<TunnelStatus> {
    this.#setState('starting')
    this.binary = await resolveCloudflared(this.config, this.logger)
    await this.#spawn()
    return this.status()
  }

  #args(): string[] {
    const port = this.gatewayPort()
    if (this.config.tunnel.mode === 'named') {
      const token = this.config.tunnel.token || process.env.CLOUDFLARED_TUNNEL_TOKEN || ''
      // Needs verification: cloudflared's `--metrics` address also serves the
      // local `/ready` endpoint used below. Confirm the flag position/behavior
      // against the pinned cloudflared release before relying on it in prod.
      return ['tunnel', '--no-autoupdate', 'run', '--token', token, '--metrics', `127.0.0.1:${this.metricsPort()}`]
    }
    return [
      'tunnel',
      '--no-autoupdate',
      '--protocol',
      this.config.tunnel.protocol,
      '--url',
      `http://127.0.0.1:${port}`,
    ]
  }

  async #spawn(): Promise<void> {
    const args = this.#args()
    const secretToken = this.config.tunnel.token || process.env.CLOUDFLARED_TUNNEL_TOKEN || ''
    const redacted = args.map((arg, index) =>
      arg === secretToken || args[index - 1] === '--token' ? '[redacted]' : arg,
    )
    this.logger.info(`Starting cloudflared ${redacted.join(' ')}`)
    const child = this.spawnImpl(this.binary, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.children.add(child)
    const onLine = (line: string): void => this.#consumeLine(line)
    child.stdout.on('data', (chunk: Buffer) => this.#consumeChunk(chunk, onLine))
    child.stderr.on('data', (chunk: Buffer) => this.#consumeChunk(chunk, onLine))
    child.on('error', (error: unknown) => {
      this.lastError = errorMessage(error)
      this.logger.error(`cloudflared process error: ${this.lastError}`)
    })
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.children.delete(child)
      if (this.child === child) this.child = null
      this.#stopHealthTimer()
      if (this.stopping) {
        this.#setState('stopped')
        return
      }
      this.lastError = `cloudflared exited (${signal ?? code ?? 'unknown'})`
      this.url = ''
      this.startedAt = 0
      if (this.config.tunnel.mode === 'named') this.#health = 'degraded'
      this.logger.warn(this.lastError)
      this.#scheduleReconnect()
    })

    if (this.config.tunnel.mode === 'named') {
      // Named tunnels have a stable hostname; there is no URL to parse.
      if (this.config.tunnel.domain) this.url = `https://${this.config.tunnel.domain}`
      const ready = await this.#waitForReady()
      if (!this.child || this.stopping) {
        this.#health = 'degraded'
        this.#setState('degraded', { lastError: this.lastError || 'cloudflared exited before becoming ready' })
        return
      }
      if (ready) {
        this.#health = 'ok'
        this.lastHealthyAt = Date.now()
        this.lastError = ''
        this.#setState('connected', { startedAt: Date.now() })
      } else {
        // Degraded is a reportable state, not a startup failure: the gateway
        // stays reachable on loopback and a later probe may still recover.
        this.#health = 'degraded'
        this.lastError = `cloudflared tunnel is not ready on 127.0.0.1:${this.metricsPort()}/ready after ${Math.round(this.readyTimeoutMs / 1000)}s`
        this.#setState('degraded', { lastError: this.lastError })
        this.logger.warn(this.lastError)
      }
      this.#startHealthTimer()
      return
    }
    // Quick Tunnel: wait for the URL line (or fail after ~25s).
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      if (this.url) return
      if (!this.child) throw new GatewayError(CODES.TUNNEL_START_FAILED, {}, 500, this.lastError || 'cloudflared exited before printing a URL')
      await sleep(200)
    }
    throw new GatewayError(CODES.TUNNEL_START_FAILED, {}, 500, 'timed out waiting for the Quick Tunnel URL')
  }

  #consumeChunk(chunk: Buffer, onLine: (line: string) => void): void {
    const text = stripAnsi(chunk.toString())
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) onLine(line.trim())
    }
  }

  #consumeLine(line: string): void {
    this.logger.debug(`cloudflared: ${line}`)
    const url = parseQuickTunnelUrl(line)
    if (!url || (url === this.url && this.state === 'connected')) return
    const previous = this.url
    this.url = url
    this.attempts = 0
    this.lastError = ''
    this.lastHealthyAt = Date.now()
    if (previous && previous !== url) this.lastUrlChangedAt = Date.now()
    this.#setState('connected', { startedAt: Date.now() })
  }

  /** Probe `http://127.0.0.1:<metricsPort>/ready` (1s per request). */
  async #probeReady(): Promise<boolean> {
    const url = `http://127.0.0.1:${this.metricsPort()}/ready`
    try {
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(READY_REQUEST_TIMEOUT_MS) })
      if (!response.ok) return false
      if (typeof response.json === 'function') {
        try {
          const body = await response.json()
          if (body && typeof body === 'object') {
            // Needs verification: cloudflared's /ready payload is expected to
            // expose the number of ready connections as `readyConnections`.
            const readyConnections = (body as Record<string, unknown>).readyConnections
            if (typeof readyConnections === 'number') this.connectors = readyConnections
          }
        } catch {
          // The readiness body is informational only.
        }
      }
      return true
    } catch {
      return false
    }
  }

  /** Poll `/ready` until the budget expires. Resolves false on timeout/exit. */
  async #waitForReady(): Promise<boolean> {
    const deadline = Date.now() + this.readyTimeoutMs
    while (Date.now() < deadline) {
      if (!this.child || this.stopping) return false
      if (await this.#probeReady()) return true
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      await sleep(Math.min(this.readyPollIntervalMs, remaining))
    }
    return false
  }

  /** Live Named-mode probe used by health() and the periodic timer. */
  async #checkNamedHealth(): Promise<{ ok: boolean; detail: string }> {
    const ready = await this.#probeReady()
    if (ready) {
      this.#health = 'ok'
      this.lastHealthyAt = Date.now()
      if (this.state !== 'connected' && this.child && !this.stopping) {
        this.#setState('connected', { startedAt: this.startedAt || Date.now() })
      } else {
        this.emit('status', this.status())
      }
      return { ok: true, detail: 'ready' }
    }
    if (this.#health !== 'degraded') {
      this.#health = 'degraded'
      this.emit('status', this.status())
    }
    return { ok: false, detail: this.lastError || `not ready on 127.0.0.1:${this.metricsPort()}/ready` }
  }

  #startHealthTimer(): void {
    if (!this.config.tunnel.enabled || this.config.tunnel.mode !== 'named') return
    if (this.#healthTimer) return
    const interval = Math.max(1_000, this.config.tunnel.healthIntervalMs)
    this.#healthTimer = setInterval(() => {
      void this.#checkNamedHealth()
    }, interval)
    this.#healthTimer.unref?.()
  }

  #stopHealthTimer(): void {
    if (!this.#healthTimer) return
    clearInterval(this.#healthTimer)
    this.#healthTimer = null
  }

  #scheduleReconnect(): void {
    if (this.stopping) return
    this.attempts += 1
    if (this.attempts > this.config.tunnel.maxRetries) {
      this.#setState('error', { lastError: `gave up after ${this.config.tunnel.maxRetries} reconnect attempts` })
      return
    }
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.attempts - 1, 6))
    this.#setState('reconnecting', { lastError: this.lastError })
    this.logger.warn(`Tunnel reconnect attempt ${this.attempts}/${this.config.tunnel.maxRetries} in ${delay}ms`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.#reconnect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  async #reconnect(): Promise<void> {
    try {
      this.binary = await resolveCloudflared(this.config, this.logger)
      await this.#spawn()
    } catch (error) {
      this.lastError = errorMessage(error)
      this.#scheduleReconnect()
    }
  }

  /** Restart the tunnel and reset the retry counter. */
  async restart(): Promise<TunnelStatus> {
    this.restarts += 1
    await this.stop()
    this.attempts = 0
    return this.start()
  }

  /** Stop the child and cancel reconnects. */
  async stop(): Promise<void> {
    this.stopping = true
    this.#stopHealthTimer()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const children = [...this.children]
    this.children.clear()
    this.child = null
    for (const child of children) {
      try {
        child.kill()
      } catch {
        // ignore
      }
    }
    if (children.length > 0) {
      await Promise.race([
        Promise.all(children.map((child) => new Promise<void>((resolve) => {
          if (child.exitCode !== null && child.exitCode !== undefined) resolve()
          else child.once('exit', resolve)
        }))),
        sleep(3000),
      ])
      for (const child of children) {
        try {
          if (child.exitCode === null || child.exitCode === undefined) child.kill('SIGKILL')
        } catch {
          // ignore
        }
      }
    }
    this.url = ''
    this.startedAt = 0
    this.connectors = undefined
    this.#health = this.config.tunnel.enabled ? 'unknown' : 'disabled'
    if (this.config.tunnel.enabled) this.#setState('stopped')
    else this.#setState('disabled')
  }
}
