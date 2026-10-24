/**
 * Reverse proxy for HTTP and WebSocket traffic from the gateway to DSH.
 *
 * DSH keeps its own browser trust model: Host/Origin are checked before auth,
 * and its session cookie is bound to the DSH listener authority. The gateway
 * therefore rewrites upstream Host/Origin to DSH's loopback origin, keeps the
 * DSH cookie server-side, and only ever exposes this gateway's own session.
 *
 * @module dsh-gateway-mobile/lib/proxy
 */

import http from 'node:http'
import https from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { CODES, GatewayError } from './errors.js'
import type { GatewayConfig } from './config.js'
import type { DeviceManager } from './devices.js'
import type { Logger } from './logger.js'
import { errorMessage, requestIp, requestProtocol, trimTrailingSlash } from './util.js'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

interface WebServerLike {
  getOrigin(): string
}

interface ConnectionLike {
  authenticatedUrl(origin: string): string | Promise<string>
}

export interface ProxyContext {
  webServer?: WebServerLike
  connection?: ConnectionLike
}

interface Upstream {
  url: URL
  origin: string
  host: string
}

type ProxyHeaders = Record<string, string | string[] | number | undefined>

export interface ProxyPeer {
  deviceId?: string
}

interface ProxyResult {
  retry: boolean
}

/**
 * Maintains the DSH-side browser cookie, obtained by exchanging the process
 * launch token through the in-process Connection service.
 */
export class DshCookieProvider {
  ctx: ProxyContext
  logger: Logger
  cookie: string
  pending: Promise<string> | null
  obtainedAt: number

  constructor(options: { ctx: ProxyContext; logger: Logger }) {
    this.ctx = options.ctx
    this.logger = options.logger
    this.cookie = ''
    this.pending = null
    this.obtainedAt = 0
  }

  get isReady(): boolean {
    return Boolean(this.cookie)
  }

  invalidate(): void {
    this.cookie = ''
  }

  async get(): Promise<string> {
    if (this.cookie) return this.cookie
    return this.refresh()
  }

  async refresh(): Promise<string> {
    if (this.pending) return this.pending
    this.pending = this.#exchange().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  async #exchange(): Promise<string> {
    if (!this.ctx?.webServer?.getOrigin || !this.ctx?.connection?.authenticatedUrl) {
      throw new GatewayError(CODES.PROXY_ERROR, {}, 502, 'gateway requires dsh webServer + connection services')
    }
    const origin = this.ctx.webServer.getOrigin()
    const tokenUrl = await this.ctx.connection.authenticatedUrl(`${origin}/`)
    let response: Response
    try {
      response = await fetch(tokenUrl, {
        redirect: 'manual',
        headers: { accept: 'text/html' },
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      throw new GatewayError(CODES.PROXY_ERROR, {}, 502, `DSH token exchange failed: ${errorMessage(error)}`)
    }
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    if (setCookies.length === 0) {
      throw new GatewayError(CODES.PROXY_ERROR, {}, 502, `DSH token exchange returned no cookie (HTTP ${response.status})`)
    }
    this.cookie = setCookies.map((entry) => entry.split(';')[0]).join('; ')
    this.obtainedAt = Date.now()
    this.logger.debug('DSH session cookie acquired')
    return this.cookie
  }
}

export interface ProxyEngineOptions {
  ctx: ProxyContext
  config: GatewayConfig
  logger: Logger
  cookieProvider: DshCookieProvider
  publicBase: () => string
  deviceManager?: DeviceManager
}

export class ProxyEngine {
  agent: http.Agent
  config: GatewayConfig
  cookieProvider: DshCookieProvider
  ctx: ProxyContext
  deviceManager: DeviceManager | undefined
  logger: Logger
  publicBase: () => string
  upstream: Upstream

  constructor(options: ProxyEngineOptions) {
    this.ctx = options.ctx
    this.config = options.config
    this.logger = options.logger
    this.cookieProvider = options.cookieProvider
    this.publicBase = options.publicBase
    this.deviceManager = options.deviceManager
    this.upstream = this.#resolveUpstream()
    // DSH closes idle keep-alive sockets; reusing a stale one produced
    // "socket hang up" on the next POST. A fresh connection per request is
    // reliable for a single-user gateway.
    this.agent = new http.Agent({ keepAlive: false })
  }

  #resolveUpstream(): Upstream {
    const configured = this.config.proxy.upstream
    const raw = configured || this.ctx?.webServer?.getOrigin?.() || 'http://127.0.0.1:3080'
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError(`invalid proxy.upstream: ${raw}`)
    return { url, origin: url.origin, host: url.host }
  }

  close(): void {
    this.agent.destroy()
  }

  #clientIp(req: IncomingMessage): string {
    return requestIp(req, this.config.security.trustProxy)
  }

  /**
   * Build upstream headers. Client cookies are always dropped: the browser
   * only holds the gateway session, never DSH's cookie.
   */
  #upstreamHeaders(req: IncomingMessage, options: { upgrade?: boolean } = {}): ProxyHeaders {
    const headers: ProxyHeaders = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = key.toLowerCase()
      if (lower === 'host' || lower === 'origin' || lower === 'cookie') continue
      if (lower.startsWith('x-forwarded-') || lower === 'x-real-ip') continue
      if (HOP_BY_HOP.has(lower) && !(options.upgrade && (lower === 'connection' || lower === 'upgrade'))) continue
      headers[key] = value
    }
    headers.host = this.upstream.host
    if (req.headers.origin) headers.origin = this.upstream.origin
    if (this.cookieProvider.isReady) headers.cookie = this.cookieProvider.cookie
    const ip = this.#clientIp(req)
    headers['x-forwarded-for'] = ip
    headers['x-real-ip'] = ip
    headers['x-forwarded-proto'] = requestProtocol(req, this.config.security.trustProxy)
    headers['x-forwarded-host'] = String(req.headers.host ?? '')
    if (options.upgrade) {
      headers.connection = 'Upgrade'
      headers.upgrade = 'websocket'
    }
    return headers
  }

  /** Rewrite upstream absolute redirects to the public gateway origin. */
  #rewriteLocation(location: string | string[]): string | string[] {
    if (!location) return location
    const value = Array.isArray(location) ? location[0] ?? '' : location
    try {
      const url = new URL(value, this.upstream.origin)
      if (url.origin === this.upstream.origin) {
        return `${trimTrailingSlash(this.publicBase())}${url.pathname}${url.search}${url.hash}`
      }
    } catch {
      // keep as-is
    }
    return location
  }

  /** Proxy one HTTP request. The caller has already authenticated the device. */
  async handleHttp(req: IncomingMessage, res: ServerResponse, _peer: ProxyPeer = {}): Promise<void> {
    try {
      await this.cookieProvider.get()
    } catch {
      // Let the caller surface the upstream failure with the standard 5xx shape.
    }
    const method = String(req.method ?? 'GET').toUpperCase()
    const canRetry = method === 'GET' || method === 'HEAD'
    let attempt = 0
    while (attempt < 2) {
      attempt += 1
      try {
        const result = await this.#forward(req, res, canRetry && attempt === 1)
        if (result.retry) {
          this.cookieProvider.invalidate()
          await this.cookieProvider.refresh().catch(() => {})
          continue
        }
        return
      } catch (error) {
        if (res.headersSent) {
          res.destroy()
          return
        }
        const code = (error as NodeJS.ErrnoException)?.code
        const transient = code === 'ECONNRESET' || code === 'EPIPE' || /socket hang up/i.test(String(errorMessage(error)))
        if (attempt === 1 && canRetry && transient) {
          await new Promise<void>((resolve) => setTimeout(resolve, 50))
          continue
        }
        const gatewayError = error instanceof GatewayError ? error : new GatewayError(CODES.PROXY_ERROR, {}, 502, errorMessage(error))
        this.logger.warn(`Proxy error for ${req.method} ${req.url}: ${gatewayError.detail || gatewayError.message}`)
        res.statusCode = gatewayError.httpStatus
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ code: gatewayError.code, message: 'proxy error', data: {} }))
        return
      }
    }
  }

  #forward(req: IncomingMessage, res: ServerResponse, retryable: boolean): Promise<ProxyResult> {
    return new Promise<ProxyResult>((resolve, reject) => {
      let settled = false
      const finish = (value: ProxyResult): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const cookie = this.cookieProvider.isReady ? this.cookieProvider.cookie : ''
      const headers = this.#upstreamHeaders(req)
      if (!cookie) delete headers.cookie
      const options: http.RequestOptions = {
        protocol: this.upstream.url.protocol,
        hostname: this.upstream.url.hostname,
        port: this.upstream.url.port,
        path: req.url,
        method: req.method,
        headers,
        agent: this.agent,
      }
      const transport = this.upstream.url.protocol === 'https:' ? https : http
      const proxyReq = transport.request(options, (proxyRes) => {
        if (retryable && proxyRes.statusCode === 401) {
          proxyRes.resume()
          finish({ retry: true })
          return
        }
        res.statusCode = proxyRes.statusCode ?? 502
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (value === undefined) continue
          const lower = key.toLowerCase()
          if (lower === 'set-cookie' || HOP_BY_HOP.has(lower)) continue
          res.setHeader(key, lower === 'location' ? this.#rewriteLocation(value) : value)
        }
        proxyRes.on('error', (error: Error) => {
          if (!res.headersSent) reject(error)
          else res.destroy()
        })
        proxyRes.pipe(res)
        proxyRes.on('end', () => finish({ retry: false }))
      })
      proxyReq.on('error', (error: Error) => {
        if (!res.headersSent) reject(error)
        else res.destroy()
      })
      if (this.config.proxy.requestTimeoutMs > 0) {
        proxyReq.setTimeout(this.config.proxy.requestTimeoutMs, () => {
          proxyReq.destroy(new GatewayError(CODES.PROXY_ERROR, {}, 504, 'upstream request timeout'))
        })
      }
      let received = 0
      req.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > this.config.proxy.maxRequestSize) {
          proxyReq.destroy(new GatewayError(CODES.PROXY_ERROR, {}, 413, 'request body too large'))
          req.destroy()
        }
      })
      req.on('error', (error: Error) => proxyReq.destroy(error))
      req.pipe(proxyReq)
      req.on('aborted', () => proxyReq.destroy())
    })
  }

  /**
   * Proxy an HTTP upgrade (the DSH Remote mux lives at /api/remote.mux).
   * The gateway does not parse DSH's frames; it authenticates the device once
   * and then pipes the sockets.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, peer: ProxyPeer = {}): void {
    const headers = this.#upstreamHeaders(req, { upgrade: true })
    const options: http.RequestOptions = {
      protocol: this.upstream.url.protocol,
      hostname: this.upstream.url.hostname,
      port: this.upstream.url.port,
      path: req.url,
      method: 'GET',
      headers,
      agent: false,
    }
    const transport = this.upstream.url.protocol === 'https:' ? https : http
    const proxyReq = transport.request(options)
    let upstreamSocket: Duplex | null = null
    let closed = false
    const cleanup = (): void => {
      if (closed) return
      closed = true
      try {
        upstreamSocket?.destroy()
      } catch {
        // ignore
      }
      try {
        socket.destroy()
      } catch {
        // ignore
      }
    }
    if (peer.deviceId && this.deviceManager) this.deviceManager.attachSocket(peer.deviceId, socket)
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      upstreamSocket = proxySocket
      const lines = [`HTTP/1.1 ${proxyRes.statusCode ?? 101} Switching Protocols`]
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (value === undefined) continue
        const lower = key.toLowerCase()
        if (lower === 'set-cookie' || lower === 'connection' || lower === 'upgrade') continue
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`)
      }
      lines.push('Connection: Upgrade', 'Upgrade: websocket')
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (proxyHead?.length) socket.write(proxyHead)
      if (head?.length) proxySocket.write(head)
      proxySocket.on('error', cleanup)
      socket.on('error', cleanup)
      proxySocket.on('close', cleanup)
      socket.on('close', cleanup)
      proxySocket.pipe(socket)
      socket.pipe(proxySocket)
    })
    proxyReq.on('response', (proxyRes) => {
      // Upstream refused the upgrade. Forward the status and body, then close.
      const body: Buffer[] = []
      proxyRes.on('data', (chunk: Buffer) => body.push(chunk))
      proxyRes.on('end', () => {
        const payload = Buffer.concat(body)
        const lines = [`HTTP/1.1 ${proxyRes.statusCode ?? 400} ${proxyRes.statusMessage ?? 'Bad Request'}`]
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (value === undefined) continue
          const lower = key.toLowerCase()
          if (lower === 'set-cookie' || lower === 'connection' || lower === 'transfer-encoding') continue
          for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`)
        }
        lines.push(`Content-Length: ${payload.length}`, 'Connection: close')
        socket.write(`${lines.join('\r\n')}\r\n\r\n`)
        socket.write(payload)
        socket.end()
        cleanup()
      })
    })
    proxyReq.on('error', (error: Error) => {
      this.logger.warn(`WebSocket proxy error: ${errorMessage(error)}`)
      try {
        socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      } catch {
        // ignore
      }
      cleanup()
    })
    socket.on('error', cleanup)
    proxyReq.end()
  }
}
