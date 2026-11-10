/**
 * DSH Web UI workbench bridge (Phase 1).
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
 * reaching the same UI through the tunnel).
 *
 * Local vs remote: DSH cannot distinguish a desktop browser from a phone
 * proxied through the tunnel (the gateway rewrites Host/Origin and injects the
 * owner cookie). The gateway therefore adds `x-dsh-gateway-proxied: 1` to every
 * request it forwards upstream. Every local-only route below refuses requests
 * that carry that header; the gateway also refuses the admin prefix itself
 * before proxying (defense in depth). Paired phones keep the read-only
 * `read/ping` overview, which contains no pairing code, device identifiers,
 * logs or settings.
 *
 * @module dsh-gateway-mobile/lib/workbench/bridge
 */

import type { Gateway } from '../gateway.js'
import type { PublicDevice } from '../devices.js'
import type { LogEntry } from '../logger.js'
import { GatewayError } from '../errors.js'
import { validOAuthAllowlist } from '../settings.js'

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

/** Injected by the gateway on every request it forwards to DSH. */
export const PROXIED_HEADER = 'x-dsh-gateway-proxied'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
} as const

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
}

function errorResponse(message: string, status: number, code: number): Response {
  return json({ code, message, data: {} }, status)
}

/** True when the request reached DSH through the phone gateway proxy. */
export function isProxiedRequest(request: Request): boolean {
  return request.headers.get(PROXIED_HEADER) === '1'
}

/** Reject remote (tunnel-proxied) callers for a local-only route. */
function localOnly(request: Request): Response | undefined {
  return isProxiedRequest(request)
    ? errorResponse('仅限本机访问', 403, 3003)
    : undefined
}

function parseLimit(request: Request, fallback: number, max = 500): number {
  const raw = new URL(request.url).searchParams.get('limit')
  const value = raw === null ? NaN : Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(1, Math.floor(value)))
}

/** Trimmed, phone-safe view of the gateway/tunnel state. */
function pingPayload(gateway: Gateway, version: string, local: boolean): Record<string, unknown> {
  const status = gateway.statusPayload()
  const tunnel = status.tunnel
  return {
    ok: true,
    plugin: 'dsh-gateway-mobile',
    version,
    local,
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

function deviceList(gateway: Gateway): PublicDevice[] {
  return [...gateway.devices.devices.values()].map((device) => gateway.devices.toPublic(device))
}

function settingsPayload(gateway: Gateway): Record<string, unknown> {
  return {
    version: gateway.version,
    ...gateway.authSettings(),
    runtime: gateway.runtimeSettings(),
    restartRequired: [],
  }
}

/** WeChat channel + completion-notification state (local-only). */
function weixinPayload(gateway: Gateway): Record<string, unknown> {
  return {
    weixin: gateway.weixin?.status() ?? null,
    notify: gateway.weixinNotifier?.status() ?? null,
  }
}

/** Secret-key status (active kid + retained kids). */
function keyStatus(gateway: Gateway): Record<string, unknown> {
  const box = gateway.secretBox
  if (!box) return { available: false, activeKid: '', keyIds: [] }
  return { available: true, activeKid: box.activeKid, keyIds: box.keyIds() }
}

/** OAuth providers and the identity allowlist. */
function oauthPayload(gateway: Gateway): Record<string, unknown> {
  return {
    providers: gateway.oauth.enabledProviders(),
    requireOAuth: gateway.config.auth.requireOAuth,
    allowedUsers: [...(gateway.config.auth.oauthAllowedUsers ?? [])],
  }
}

function wrap(handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    try {
      return await handler(request)
    } catch (error) {
      if (error instanceof GatewayError) {
        return json({ code: error.code, message: error.message, data: error.data }, error.httpStatus)
      }
      const message = error instanceof Error ? error.message : String(error)
      return errorResponse(message, 500, 5000)
    }
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
      fetch: wrap((request) =>
        Promise.resolve(json(pingPayload(gateway, version, !isProxiedRequest(request)))),
      ),
    },
    {
      path: '/api/gateway-mobile/read/pairing',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: wrap(async (request) => {
        const denied = localOnly(request)
        if (denied) return denied
        return json(await gateway.pairingPayload())
      }),
    },
    {
      path: '/api/gateway-mobile/read/devices',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: wrap((request) => {
        const denied = localOnly(request)
        if (denied) return Promise.resolve(denied)
        return Promise.resolve(json({ devices: deviceList(gateway) }))
      }),
    },
    {
      path: '/api/gateway-mobile/read/logs',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: wrap((request) => {
        const denied = localOnly(request)
        if (denied) return Promise.resolve(denied)
        const logs: LogEntry[] = gateway.logger.recent(parseLimit(request, 100))
        return Promise.resolve(json({ logs }))
      }),
    },
    {
      path: '/api/gateway-mobile/read/settings',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: wrap((request) => {
        const denied = localOnly(request)
        if (denied) return Promise.resolve(denied)
        return Promise.resolve(json(settingsPayload(gateway)))
      }),
    },
    {
      path: '/api/gateway-mobile/admin/pairing/regenerate',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: wrap(async (request) => {
        const denied = localOnly(request)
        if (denied) return denied
        gateway.pairing.issue()
        return json(await gateway.pairingPayload())
      }),
    },
    {
      path: '/api/gateway-mobile/admin/settings',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: wrap(async (request) => {
        const denied = localOnly(request)
        if (denied) return denied
        const body = (await request.json()) as Record<string, unknown>
        const authPatch: { sessionMaxAge?: unknown; pairingTokenExpiry?: unknown } = {}
        if ('sessionMaxAge' in body) authPatch.sessionMaxAge = body.sessionMaxAge
        if ('pairingTokenExpiry' in body) authPatch.pairingTokenExpiry = body.pairingTokenExpiry
        const runtimePatch: {
          tunnelEnabled?: unknown
          weixinEnabled?: unknown
          logLevel?: unknown
          proxyRequestTimeoutMs?: unknown
        } = {}
        for (const field of ['tunnelEnabled', 'weixinEnabled', 'logLevel', 'proxyRequestTimeoutMs'] as const) {
          if (field in body) runtimePatch[field] = body[field]
        }
        const hasAuth = Object.keys(authPatch).length > 0
        const hasRuntime = Object.keys(runtimePatch).length > 0
        if (!hasAuth && !hasRuntime) return errorResponse('没有可更新的设置', 400, 1002)
        if (hasAuth) await gateway.updateAuthSettings(authPatch)
        if (hasRuntime) await gateway.updateRuntimeSettings(runtimePatch)
        return json(settingsPayload(gateway))
      }),
    },
    {
      path: '/api/gateway-mobile/admin/tunnel',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: wrap(async (request) => {
        const denied = localOnly(request)
        if (denied) return denied
        const body = (await request.json()) as { action?: unknown }
        const action = typeof body.action === 'string' ? body.action : ''
        if (action === 'stop') await gateway.tunnel.stop()
        else if (action === 'start') await gateway.tunnel.start()
        else if (action === 'restart') await gateway.tunnel.restart()
        else return errorResponse('未知的隧道操作', 400, 1002)
        return json(gateway.tunnel.status())
      }),
    },
    {
      path: '/api/gateway-mobile/read/weixin',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: wrap((request) => {
        const denied = localOnly(request)
        if (denied) return Promise.resolve(denied)
        return Promise.resolve(json(weixinPayload(gateway)))
      }),
    },
    {
      path: '/api/gateway-mobile/admin/weixin',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: wrap(async (request) => {
        const denied = localOnly(request)
        if (denied) return denied
        const body = (await request.json()) as Record<string, unknown>
        let touched = false
        if (typeof body.enabled === 'boolean') {
          await gateway.updateRuntimeSettings({ weixinEnabled: body.enabled })
          touched = true
        }
        const notifier = gateway.weixinNotifier
        if (typeof body.notifyEnabled === 'boolean') {
          if (!notifier) return errorResponse('微信通知不可用', 409, 1008)
          await notifier.setEnabled(body.notifyEnabled)
          touched = true
        }
        const policy: {
          debounceMs?: number
          perSessionIntervalMs?: number
          globalIntervalMs?: number
          maxPerHour?: number
        } = {}
        for (const field of ['debounceMs', 'perSessionIntervalMs', 'globalIntervalMs', 'maxPerHour'] as const) {
          const value = body[field]
          if (value === undefined) continue
          if (typeof value !== 'number' || !Number.isInteger(value)) {
            return errorResponse(`通知参数 ${field} 无效`, 400, 1002)
          }
          policy[field] = value
        }
        if (Object.keys(policy).length > 0) {
          if (!notifier) return errorResponse('微信通知不可用', 409, 1008)
          try {
            await notifier.setPolicy(policy)
          } catch {
            return errorResponse('通知参数超出允许范围', 400, 1002)
          }
          touched = true
        }
        if (!touched) return errorResponse('没有可更新的微信设置', 400, 1002)
        return json(weixinPayload(gateway))
      }),
    },
    {
      path: '/api/gateway-mobile/read/keys',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: wrap((request) => {
        const denied = localOnly(request)
        if (denied) return Promise.resolve(denied)
        return Promise.resolve(json(keyStatus(gateway)))
      }),
    },
    {
      path: '/api/gateway-mobile/admin/key/rotate',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: wrap((request) => {
        const denied = localOnly(request)
        if (denied) return Promise.resolve(denied)
        gateway.rotateSecretKey()
        return Promise.resolve(json(keyStatus(gateway)))
      }),
    },
    {
      path: '/api/gateway-mobile/read/audit',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: wrap((request) => {
        const denied = localOnly(request)
        if (denied) return Promise.resolve(denied)
        const params = new URL(request.url).searchParams
        const action = params.get('action')?.trim() || undefined
        const sinceRaw = params.get('since')
        const sinceValue = sinceRaw === null ? NaN : /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : Date.parse(sinceRaw)
        const since = Number.isFinite(sinceValue) ? sinceValue : undefined
        const limitRaw = Number(params.get('limit') ?? 200)
        const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, Math.floor(limitRaw))) : 200
        return gateway.queryAudit({ action, since, limit }).then((payload) => json(payload))
      }),
    },
    {
      path: '/api/gateway-mobile/read/oauth',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: wrap((request) => {
        const denied = localOnly(request)
        if (denied) return Promise.resolve(denied)
        return Promise.resolve(json(oauthPayload(gateway)))
      }),
    },
    {
      path: '/api/gateway-mobile/admin/oauth',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: wrap(async (request) => {
        const denied = localOnly(request)
        if (denied) return denied
        const body = (await request.json()) as { allowedUsers?: unknown }
        if (!validOAuthAllowlist(body.allowedUsers)) {
          return errorResponse('白名单条目需形如 github:login 或 gitee:login', 400, 1002)
        }
        const allowedUsers = body.allowedUsers.map((entry) => entry.trim())
        gateway.config.auth.oauthAllowedUsers = allowedUsers
        await gateway.settingsStore?.save({ oauthAllowedUsers: allowedUsers })
        return json(oauthPayload(gateway))
      }),
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
