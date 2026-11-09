/**
 * Loopback-only administration routes: logs, statistics, pairing state,
 * authentication settings, tunnel control, capability matrix, deep health,
 * audit export and secret-key rotation.
 *
 * @module dsh-gateway-mobile/lib/routes/admin
 */

import { CODES, GatewayError } from '../errors.js'
import { errorMessage } from '../util.js'
import { assertLocal } from './router.js'
import type { RouteEntry } from './router.js'

export function adminRoutes(): RouteEntry[] {
  return [
    {
      method: 'GET',
      path: '/mobile/api/v1/logs',
      handler: async ({ req, res, url, gateway, peer }) => {
        assertLocal(peer)
        const limit = Number(url.searchParams.get('limit') ?? 50)
        gateway.sendJson(req, res, CODES.SUCCESS, { logs: gateway.logger.recent(limit) })
      },
    },
    {
      method: 'GET',
      path: '/mobile/api/v1/admin/stats',
      handler: async ({ req, res, url, gateway, peer }) => {
        assertLocal(peer)
        const days = Number(url.searchParams.get('days') ?? 30)
        gateway.sendJson(req, res, CODES.SUCCESS, gateway.stats?.summary(days) ?? {})
      },
    },
    {
      method: 'GET',
      path: '/mobile/api/v1/admin/pairing',
      handler: async ({ req, res, gateway, peer }) => {
        assertLocal(peer)
        gateway.sendJson(req, res, CODES.SUCCESS, await gateway.pairingPayload())
      },
    },
    {
      method: 'POST',
      path: '/mobile/api/v1/admin/pairing/regenerate',
      handler: async ({ req, res, gateway, peer }) => {
        assertLocal(peer)
        gateway.pairing.issue()
        gateway.sendJson(req, res, CODES.SUCCESS, await gateway.pairingPayload())
      },
    },
    {
      method: 'GET',
      path: '/mobile/api/v1/admin/settings',
      handler: async ({ req, res, gateway, peer }) => {
        assertLocal(peer)
        gateway.sendJson(req, res, CODES.SUCCESS, {
          ...gateway.authSettings(),
          runtime: gateway.runtimeSettings(),
          restartRequired: [],
        })
      },
    },
    {
      method: 'POST',
      path: '/mobile/api/v1/admin/settings',
      handler: async ({ req, res, gateway, peer }) => {
        assertLocal(peer)
        const body = await gateway.readJson(req)
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
        if (!hasAuth && !hasRuntime) throw new GatewayError(CODES.INVALID_PARAMS, { field: 'settings' })
        if (hasAuth) await gateway.updateAuthSettings(authPatch)
        if (hasRuntime) await gateway.updateRuntimeSettings(runtimePatch)
        gateway.sendJson(req, res, CODES.SUCCESS, {
          ...gateway.authSettings(),
          runtime: gateway.runtimeSettings(),
          restartRequired: [],
        })
      },
    },
    {
      method: 'POST',
      path: /^\/mobile\/api\/v1\/admin\/tunnel\/(start|stop|restart)$/,
      handler: async ({ req, res, gateway, peer, params }) => {
        assertLocal(peer)
        const action = params[0] ?? ''
        try {
          if (action === 'stop') await gateway.tunnel.stop()
          else if (action === 'start') await gateway.tunnel.start()
          else await gateway.tunnel.restart()
        } catch (error) {
          throw new GatewayError(CODES.TUNNEL_START_FAILED, { state: gateway.tunnel.status() }, 500, errorMessage(error))
        }
        gateway.sendJson(req, res, CODES.SUCCESS, gateway.tunnel.status())
      },
    },
    {
      method: 'GET',
      path: '/mobile/api/v1/admin/capabilities',
      handler: async ({ req, res, gateway, peer }) => {
        assertLocal(peer)
        gateway.sendJson(req, res, CODES.SUCCESS, gateway.capabilities())
      },
    },
    {
      method: 'GET',
      path: '/mobile/api/v1/admin/health',
      handler: async ({ req, res, url, gateway, peer }) => {
        assertLocal(peer)
        const requested = String(url.searchParams.get('deep') ?? '1')
        if (requested === '0' || requested === 'false') {
          gateway.sendJson(req, res, CODES.SUCCESS, { ok: true, version: gateway.version, time: new Date().toISOString() })
          return
        }
        const payload = await gateway.buildHealth()
        gateway.sendJson(req, res, CODES.SUCCESS, payload, payload.ok ? 200 : 503)
      },
    },
    {
      method: 'GET',
      path: '/mobile/api/v1/admin/audit',
      handler: async ({ req, res, url, gateway, peer }) => {
        assertLocal(peer)
        const action = url.searchParams.get('action') ?? undefined
        const sinceRaw = url.searchParams.get('since')
        const since = sinceRaw === null ? undefined : /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : Date.parse(sinceRaw)
        const limitRaw = Number(url.searchParams.get('limit') ?? 100)
        const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, Math.floor(limitRaw))) : 100
        gateway.sendJson(req, res, CODES.SUCCESS, await gateway.queryAudit({ action, since, limit }))
      },
    },
    {
      method: 'POST',
      path: '/mobile/api/v1/admin/key/rotate',
      handler: async ({ req, res, gateway, peer }) => {
        assertLocal(peer)
        gateway.sendJson(req, res, CODES.SUCCESS, gateway.rotateSecretKey())
      },
    },
  ]
}
