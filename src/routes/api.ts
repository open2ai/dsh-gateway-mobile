/**
 * The authenticated `/mobile/api/v1` surface, composed from the route modules.
 *
 * @module dsh-gateway-mobile/lib/routes/api
 */

import { adminRoutes } from './admin.js'
import { deviceRoutes } from './devices.js'
import { oauthRoutes } from './oauth.js'
import { sessionRoutes } from './session.js'
import { weixinRoutes } from './weixin.js'
import { Router } from './router.js'

export function createApiRouter(): Router {
  return new Router([
    ...sessionRoutes(),
    ...deviceRoutes(),
    ...adminRoutes(),
    ...weixinRoutes(),
    ...oauthRoutes(),
  ])
}
