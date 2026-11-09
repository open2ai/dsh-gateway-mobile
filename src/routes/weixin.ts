/**
 * Loopback-only WeChat channel administration: QR login, owner approval,
 * notification policy and approval history.
 *
 * @module dsh-gateway-mobile/lib/routes/weixin
 */

import { CODES, GatewayError } from '../errors.js'
import { assertLocal } from './router.js'
import type { RouteEntry } from './router.js'

export function weixinRoutes(): RouteEntry[] {
  return [
    {
      method: 'GET',
      path: '/mobile/api/v1/admin/weixin',
      handler: async ({ req, res, gateway, peer }) => {
        assertLocal(peer)
        if (!gateway.weixin) throw new GatewayError(CODES.NOT_SUPPORTED)
        const status = gateway.weixin.status()
        gateway.sendJson(req, res, CODES.SUCCESS, {
          ...status,
          notify: gateway.weixinNotifier?.status() ?? null,
        })
      },
    },
    {
      method: 'POST',
      path: '/mobile/api/v1/admin/weixin/login',
      handler: async ({ req, res, gateway, peer }) => {
        assertLocal(peer)
        if (!gateway.weixin) throw new GatewayError(CODES.NOT_SUPPORTED)
        gateway.sendJson(req, res, CODES.SUCCESS, await gateway.weixin.beginLogin())
      },
    },
    {
      method: 'GET',
      path: '/mobile/api/v1/admin/weixin/login',
      handler: async ({ req, res, gateway, peer }) => {
        assertLocal(peer)
        if (!gateway.weixin) throw new GatewayError(CODES.NOT_SUPPORTED)
        gateway.sendJson(req, res, CODES.SUCCESS, await gateway.weixin.pollLogin())
      },
    },
    {
      method: 'POST',
      path: '/mobile/api/v1/admin/weixin/approve',
      handler: async ({ req, res, gateway, peer }) => {
        assertLocal(peer)
        if (!gateway.weixin) throw new GatewayError(CODES.NOT_SUPPORTED)
        const body = await gateway.readJson(req)
        if (typeof body.approve !== 'boolean') throw new GatewayError(CODES.INVALID_PARAMS)
        gateway.sendJson(req, res, CODES.SUCCESS, await gateway.weixin.approveLogin(body.approve))
      },
    },
    {
      method: 'GET',
      path: '/mobile/api/v1/admin/weixin/notify',
      handler: async ({ req, res, gateway, peer }) => {
        assertLocal(peer)
        if (!gateway.weixinNotifier) throw new GatewayError(CODES.NOT_SUPPORTED)
        gateway.sendJson(req, res, CODES.SUCCESS, gateway.weixinNotifier.status())
      },
    },
    {
      method: 'POST',
      path: '/mobile/api/v1/admin/weixin/notify',
      handler: async ({ req, res, gateway, peer }) => {
        assertLocal(peer)
        if (!gateway.weixinNotifier) throw new GatewayError(CODES.NOT_SUPPORTED)
        const body = await gateway.readJson(req)
        const patch: {
          debounceMs?: number
          perSessionIntervalMs?: number
          globalIntervalMs?: number
          maxPerHour?: number
        } = {}
        const fields = ['debounceMs', 'perSessionIntervalMs', 'globalIntervalMs', 'maxPerHour'] as const
        for (const field of fields) {
          const value = body[field]
          if (value === undefined) continue
          if (typeof value !== 'number' || !Number.isInteger(value)) throw new GatewayError(CODES.INVALID_PARAMS)
          patch[field] = value
        }
        const hasPolicy = fields.some((field) => body[field] !== undefined)
        if (typeof body.enabled !== 'boolean' && !hasPolicy) throw new GatewayError(CODES.INVALID_PARAMS)
        if (typeof body.enabled === 'boolean') await gateway.weixinNotifier.setEnabled(body.enabled)
        if (hasPolicy) {
          try {
            await gateway.weixinNotifier.setPolicy(patch)
          } catch {
            throw new GatewayError(CODES.INVALID_PARAMS)
          }
        }
        gateway.sendJson(req, res, CODES.SUCCESS, gateway.weixinNotifier.status())
      },
    },
    {
      method: 'GET',
      path: '/mobile/api/v1/admin/weixin/approvals',
      handler: async ({ req, res, gateway, peer }) => {
        assertLocal(peer)
        if (!gateway.weixinApprovalHistory) throw new GatewayError(CODES.NOT_SUPPORTED)
        gateway.sendJson(req, res, CODES.SUCCESS, { items: gateway.weixinApprovalHistory() })
      },
    },
    {
      method: 'POST',
      path: '/mobile/api/v1/admin/weixin/logout',
      handler: async ({ req, res, gateway, peer }) => {
        assertLocal(peer)
        if (!gateway.weixin) throw new GatewayError(CODES.NOT_SUPPORTED)
        gateway.sendJson(req, res, CODES.SUCCESS, await gateway.weixin.logout())
      },
    },
  ]
}
