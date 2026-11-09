/**
 * Session, identity and status routes for paired devices.
 *
 * @module dsh-gateway-mobile/lib/routes/session
 */

import { CODES, GatewayError } from '../errors.js'
import type { RouteEntry } from './router.js'

export function sessionRoutes(): RouteEntry[] {
  return [
    {
      method: 'GET',
      path: '/mobile/api/v1/me',
      handler: async ({ req, res, gateway, peer }) => {
        gateway.sendJson(req, res, CODES.SUCCESS, {
          device: peer.device ? gateway.devices.toPublic(peer.device, { currentDeviceId: peer.deviceId }) : null,
          requireOAuth: gateway.config.auth.requireOAuth,
          oauthProviders: gateway.oauth.enabledProviders(),
          publicBase: gateway.publicBase(),
        })
      },
    },
    {
      method: 'GET',
      path: '/mobile/api/v1/status',
      handler: async ({ req, res, gateway, peer }) => {
        const payload = gateway.statusPayload()
        if (peer.device) payload.device = gateway.devices.toPublic(peer.device, { currentDeviceId: peer.deviceId })
        gateway.sendJson(req, res, CODES.SUCCESS, payload)
      },
    },
    {
      method: 'POST',
      path: '/mobile/api/v1/session/refresh',
      handler: async ({ req, res, info, gateway, peer }) => {
        const session = gateway.sessions.issue(peer.deviceId)
        gateway.setSessionCookie(req, res, info, session.token, session.maxAge)
        gateway.sendJson(req, res, CODES.SUCCESS, { expiresAt: new Date(session.expiresAt).toISOString() })
      },
    },
    {
      method: 'POST',
      path: '/mobile/api/v1/logout',
      handler: async ({ req, res, info, gateway, peer }) => {
        gateway.clearSessionCookie(req, res, info)
        gateway.logger.audit({ action: 'device.logout', deviceId: peer.deviceId })
        gateway.sendJson(req, res, CODES.SUCCESS, {})
      },
    },
    {
      method: ['GET'],
      path: /^\/mobile\/api\/v1\/(sessions|models)$/,
      handler: async () => {
        throw new GatewayError(CODES.NOT_SUPPORTED, {
          hint: 'Use the embedded DSH Web UI for sessions and model selection.',
        })
      },
    },
  ]
}
