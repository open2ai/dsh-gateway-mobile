/**
 * Cloudflare Quick Tunnel process manager.
 *
 * `cloudflared tunnel --url http://127.0.0.1:<gatewayPort>` is started as an
 * outbound-only child. The gateway parses the printed trycloudflare.com URL,
 * reconnects with capped exponential backoff, and exposes a small status
 * object for the admin UI and API.
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

export type TunnelState = 'disabled' | 'starting' | 'connected' | 'reconnecting' | 'stopped' | 'error'

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
}

interface TunnelChild extends EventEmitter {
  stdout: Readable
  stderr: Readable
  exitCode: number | null
  kill(signal?: NodeJS.Signals): boolean
}

type TunnelSpawn = (command: string, args: string[], options: SpawnOptions) => TunnelChild

export interface TunnelManagerOptions {
  config: GatewayConfig
  logger: Logger
  gatewayPort: () => number
  spawnImpl?: TunnelSpawn
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
  gatewayPort: () => number
  lastError: string
  logger: Logger
  reconnectTimer: ReturnType<typeof setTimeout> | null
  spawnImpl: TunnelSpawn
  startPromise: Promise<TunnelStatus> | null
  startedAt: number
  state: TunnelState
  stopping: boolean
  url: string

  constructor(options: TunnelManagerOptions) {
    super()
    this.config = options.config
    this.logger = options.logger
    this.gatewayPort = options.gatewayPort
    this.state = this.config.tunnel.enabled ? 'stopped' : 'disabled'
    this.url = ''
    this.binary = ''
    this.child = null
    this.attempts = 0
    this.startedAt = 0
    this.lastError = ''
    this.stopping = false
    this.children = new Set()
    this.reconnectTimer = null
    this.startPromise = null
    this.spawnImpl = options.spawnImpl ?? (spawn as unknown as TunnelSpawn)
  }

  get connected(): boolean {
    return this.state === 'connected'
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
    return {
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
    if (this.child && (this.state === 'starting' || this.state === 'connected')) {
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
      return ['tunnel', '--no-autoupdate', 'run', '--token', token]
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
    const redacted = args.map((arg) => (this.config.tunnel.token && arg === this.config.tunnel.token ? '[redacted]' : arg))
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
      if (this.stopping) {
        this.#setState('stopped')
        return
      }
      this.lastError = `cloudflared exited (${signal ?? code ?? 'unknown'})`
      this.url = ''
      this.startedAt = 0
      this.logger.warn(this.lastError)
      this.#scheduleReconnect()
    })

    if (this.config.tunnel.mode === 'named') {
      // Named tunnels have a stable hostname; there is no URL to parse.
      await sleep(1200)
      if (this.child && !this.url && this.config.tunnel.domain) this.url = `https://${this.config.tunnel.domain}`
      if (this.child && this.state !== 'connected') {
        this.#setState('connected', { startedAt: Date.now() })
      }
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
    if (url && (!this.url || this.state !== 'connected')) {
      this.url = url
      this.attempts = 0
      this.lastError = ''
      this.#setState('connected', { startedAt: Date.now() })
    }
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
    await this.stop()
    this.attempts = 0
    return this.start()
  }

  /** Stop the child and cancel reconnects. */
  async stop(): Promise<void> {
    this.stopping = true
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
    if (this.config.tunnel.enabled) this.#setState('stopped')
    else this.#setState('disabled')
  }
}
