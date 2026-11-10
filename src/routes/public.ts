/**
 * Pre-authentication routes: health, the pairing page endpoints, the admin
 * redirect and the OAuth callback. None of them require a device session; the
 * gateway still applies Host/trust checks before dispatching here.
 *
 * @module dsh-gateway-mobile/lib/routes/public
 */

import { CODES } from '../errors.js'
import { Router } from './router.js'
import type { RouteRequest } from './router.js'

export function createPublicRouter(): Router {
  const router = new Router()

  const health = async ({ req, res, url, gateway }: RouteRequest): Promise<void> => {
    const requested = String(url.searchParams.get('deep') ?? '')
    const deep = requested === '1' || requested === 'true'
    if (!deep) {
      gateway.sendJson(req, res, CODES.SUCCESS, { ok: true, version: gateway.version, time: new Date().toISOString() })
      return
    }
    const payload = await gateway.buildHealth()
    gateway.sendJson(req, res, CODES.SUCCESS, payload, payload.ok ? 200 : 503)
  }

  router.add({ path: '/health', handler: health })
  router.add({ path: '/mobile/api/v1/health', handler: health })

  router.add({
    path: '/admin',
    handler: async ({ res, gateway }) => {
      if (!gateway.adminConsoleEnabled()) {
        res.statusCode = 404
        res.end()
        return
      }
      res.statusCode = 302
      res.setHeader('location', '/mobile/admin')
      res.end()
    },
  })
  router.add({
    path: '/admin/',
    handler: async ({ res, gateway }) => {
      if (!gateway.adminConsoleEnabled()) {
        res.statusCode = 404
        res.end()
        return
      }
      res.statusCode = 302
      res.setHeader('location', '/mobile/admin')
      res.end()
    },
  })

  router.add({
    method: 'GET',
    path: '/mobile/api/v1/pairing/status',
    handler: async ({ req, res, gateway }) => {
      gateway.sendJson(req, res, CODES.SUCCESS, gateway.pairing.status())
    },
  })

  router.add({
    method: 'POST',
    path: '/mobile/api/v1/pairing/verify',
    handler: async ({ req, res, info, gateway }) => {
      await gateway.handlePairVerify(req, res, info)
    },
  })

  router.add({
    method: 'GET',
    path: /^\/auth\/(github|gitee)\/callback$/,
    handler: async ({ req, res, url, gateway }) => {
      await gateway.handleOAuthCallback(req, res, url)
    },
  })

  return router
}
