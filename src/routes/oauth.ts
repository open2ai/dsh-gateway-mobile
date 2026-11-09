/**
 * Optional OAuth binding routes (providers, authorize URL, client callback,
 * unbind). The browser redirect callback is public and lives in
 * `routes/public.ts`.
 *
 * @module dsh-gateway-mobile/lib/routes/oauth
 */

import { CODES, GatewayError } from '../errors.js'
import type { RouteEntry } from './router.js'

function isProvider(value: unknown): value is 'github' | 'gitee' {
  return value === 'github' || value === 'gitee'
}

export function oauthRoutes(): RouteEntry[] {
  return [
    {
      method: 'GET',
      path: '/mobile/api/v1/oauth/providers',
      handler: async ({ req, res, gateway }) => {
        gateway.sendJson(req, res, CODES.SUCCESS, { providers: gateway.oauth.enabledProviders() })
      },
    },
    {
      method: 'GET',
      path: '/mobile/api/v1/oauth/authorize',
      handler: async ({ req, res, url, gateway, peer }) => {
        const provider = url.searchParams.get('provider')
        const deviceId = url.searchParams.get('deviceId') ?? peer.deviceId
        if (!provider) throw new GatewayError(CODES.INVALID_PARAMS)
        if (provider !== 'github' && provider !== 'gitee') throw new GatewayError(CODES.INVALID_PARAMS)
        if (!peer.local && deviceId !== peer.deviceId) throw new GatewayError(CODES.PERMISSION_DENIED)
        const authorizeUrl = gateway.oauth.authorizeUrl(provider, deviceId)
        gateway.sendJson(req, res, CODES.SUCCESS, { authorizeUrl })
      },
    },
    {
      method: 'POST',
      path: '/mobile/api/v1/oauth/callback',
      handler: async ({ req, res, gateway }) => {
        const body = await gateway.readJson(req)
        if (typeof body.provider !== 'string' || typeof body.code !== 'string' || typeof body.state !== 'string') {
          throw new GatewayError(CODES.INVALID_PARAMS)
        }
        const result = await gateway.oauth.callbackFromClient({
          provider: body.provider,
          code: body.code,
          state: body.state,
        })
        gateway.sendJson(req, res, CODES.SUCCESS, {
          binding: {
            provider: result.binding.provider,
            username: result.binding.username,
            avatarUrl: result.binding.avatarUrl,
          },
        })
      },
    },
    {
      method: 'POST',
      path: '/mobile/api/v1/oauth/unbind',
      handler: async ({ req, res, gateway, peer }) => {
        const body = await gateway.readJson(req)
        if (!isProvider(body.provider)) throw new GatewayError(CODES.INVALID_PARAMS)
        gateway.oauth.unbind(peer.deviceId, body.provider)
        gateway.sendJson(req, res, CODES.SUCCESS, {})
      },
    },
  ]
}
