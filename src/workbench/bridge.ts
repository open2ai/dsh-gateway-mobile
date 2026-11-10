/**
 * DSH Web UI workbench bridge (Phase 0).
 *
 * The DSH browser half talks to the host through exact `/api` Fetch routes
 * registered on the DSH Connection service. Those routes are same-origin,
 * inherit DSH's Host/Origin trust fence and browser-session authentication,
 * and are dispatched by DSH itself, so no CORS, cookies, CSRF token or second
 * HTTP hop is involved.
 *
 * The bridge deliberately calls the live `Gateway` instance already owned by
 * this plugin process instead of re-entering the loopback gateway over HTTP:
 * a loopback HTTP hop would look like a local administrator to the gateway and
 * would hand admin authority to every DSH UI visitor (including paired phones
 * reaching the same UI through the tunnel). Phase 0 only exposes read-only
 * status; the local/remote split for admin routes arrives with Phase 1/2.
 *
 * @module dsh-gateway-mobile/lib/workbench/bridge
 */

import type { Gateway } from '../gateway.js'

/** One exact Fetch route below the DSH `/api` channel (DSH connection contract). */
export interface WorkbenchFetchRoute {
  readonly path: string
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  readonly requestBody: 'buffered' | 'streaming'
  readonly fetch: (request: Request) => Promise<Response>
}

/** The subset of the Cordis context this module needs. */
export interface WorkbenchHostContext {
  effect(callback: () => () => void | Promise<void>, label?: string): unknown
  connection: {
    fetch?: {
      register(route: WorkbenchFetchRoute): () => Promise<void>
    }
  }
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
} as const

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
}

/** Trimmed, phone-safe view of the gateway/tunnel state. */
function pingPayload(gateway: Gateway, version: string): Record<string, unknown> {
  const status = gateway.statusPayload()
  const tunnel = status.tunnel
  return {
    ok: true,
    plugin: 'dsh-gateway-mobile',
    version,
    serverTime: new Date().toISOString(),
    gateway: {
      origin: gateway.origin,
      port: status.gateway.port,
      publicBase: status.gateway.publicBase,
      uptime: status.gateway.uptime,
      adminUrl: `${gateway.origin}/mobile/admin`,
    },
    tunnel: {
      enabled: tunnel.enabled,
      mode: tunnel.mode,
      state: tunnel.state,
      connected: tunnel.connected,
      url: tunnel.url,
      publicBase: tunnel.publicBase,
      protocol: tunnel.protocol,
      lastError: tunnel.lastError,
    },
    devices: {
      active: status.activeDevices,
      online: status.onlineDevices,
    },
    capabilities: status.capabilities,
  }
}

/**
 * Register the workbench bridge routes on the DSH Connection service.
 *
 * Must be called after the plugin has produced its `Gateway` instance (the
 * routes read live status from it). Registration is disposed with the plugin
 * fiber through `ctx.effect`.
 *
 * @returns `true` when the routes were registered; `false` when this DSH host
 * does not expose the exact-Fetch connection surface (the gateway and the
 * standalone console keep working either way).
 */
export function registerWorkbenchBridge(ctx: WorkbenchHostContext, gateway: Gateway, version: string): boolean {
  const exactFetch = ctx.connection?.fetch
  if (exactFetch === undefined || typeof exactFetch.register !== 'function') {
    return false
  }

  const routes: WorkbenchFetchRoute[] = [
    {
      path: '/api/gateway-mobile/read/ping',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => Promise.resolve(json(pingPayload(gateway, version))),
    },
  ]

  for (const route of routes) {
    ctx.effect(
      () => exactFetch.register(route),
      `dsh-gateway-mobile: workbench route ${route.path}`,
    )
  }
  return true
}
