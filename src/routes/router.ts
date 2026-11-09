/**
 * Minimal declarative router used by the gateway's HTTP surface.
 *
 * Handlers live in `src/routes/*.ts`; the gateway keeps request admission
 * (Host/trust checks, authentication, CSRF, static files, WebSocket upgrades)
 * and dispatches to a router once a request is admitted.
 *
 * @module dsh-gateway-mobile/lib/routes/router
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { CODES, GatewayError } from '../errors.js'
import type { Gateway, HostInfo, Peer } from '../gateway.js'

export interface RouteRequest {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  info: HostInfo
  peer: Peer
  /** Regex capture groups of the matched path, or an empty array. */
  params: string[]
  gateway: Gateway
}

export interface RouteEntry {
  /** All methods when omitted. */
  method?: string | string[]
  path: string | RegExp
  handler(request: RouteRequest): Promise<void>
}

export class Router {
  readonly entries: RouteEntry[]

  constructor(entries: RouteEntry[] = []) {
    this.entries = entries
  }

  add(entry: RouteEntry): this {
    this.entries.push(entry)
    return this
  }

  /** Run the first matching route; returns false when nothing matched. */
  async handle(request: RouteRequest): Promise<boolean> {
    const method = String(request.req.method ?? 'GET').toUpperCase()
    for (const entry of this.entries) {
      if (entry.method !== undefined) {
        const methods = Array.isArray(entry.method) ? entry.method : [entry.method]
        if (!methods.includes(method)) continue
      }
      let params: string[] = []
      if (typeof entry.path === 'string') {
        if (entry.path !== request.url.pathname) continue
      } else {
        const match = entry.path.exec(request.url.pathname)
        if (!match) continue
        params = match.slice(1).map((value) => value ?? '')
      }
      await entry.handler({ ...request, params })
      return true
    }
    return false
  }
}

/** Reject a request that reaches a loopback-only admin route. */
export function assertLocal(peer: Peer): void {
  if (!peer.local) throw new GatewayError(CODES.PERMISSION_DENIED)
}
