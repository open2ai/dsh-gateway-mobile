/**
 * Device management routes (list, rename, revoke, delete, purge).
 *
 * @module dsh-gateway-mobile/lib/routes/devices
 */

import { CODES, GatewayError } from '../errors.js'
import type { RouteEntry } from './router.js'

const DEVICE_PATH = /^\/mobile\/api\/v1\/devices\/(dev_[a-f0-9]{16})$/

export function deviceRoutes(): RouteEntry[] {
  return [
    {
      method: 'GET',
      path: '/mobile/api/v1/devices',
      handler: async ({ req, res, url, gateway, peer }) => {
        const all = peer.local && url.searchParams.get('all') === '1'
        const devices = (all || peer.local)
          ? [...gateway.devices.devices.values()].map((device) =>
              gateway.devices.toPublic(device, { currentDeviceId: peer.deviceId }),
            )
          : gateway.devices
              .listActive()
              .filter((device) => device.deviceId === peer.deviceId)
              .map((device) => gateway.devices.toPublic(device, { currentDeviceId: peer.deviceId }))
        gateway.sendJson(req, res, CODES.SUCCESS, { devices })
      },
    },
    {
      method: 'PATCH',
      path: DEVICE_PATH,
      handler: async ({ req, res, gateway, peer, params }) => {
        const target = params[0] ?? ''
        if (!peer.local && target !== peer.deviceId) throw new GatewayError(CODES.PERMISSION_DENIED)
        const body = await gateway.readJson(req)
        const device = gateway.devices.rename(target, String(body.deviceName ?? ''))
        gateway.sendJson(req, res, CODES.SUCCESS, {
          device: gateway.devices.toPublic(device, { currentDeviceId: peer.deviceId }),
        })
      },
    },
    {
      method: 'POST',
      path: /^\/mobile\/api\/v1\/devices\/(dev_[a-f0-9]{16})\/revoke$/,
      handler: async ({ req, res, info, gateway, peer, params }) => {
        const target = params[0] ?? ''
        if (!peer.local && target !== peer.deviceId) throw new GatewayError(CODES.PERMISSION_DENIED)
        gateway.devices.revoke(target)
        if (target === peer.deviceId) gateway.clearSessionCookie(req, res, info)
        gateway.sendJson(req, res, CODES.SUCCESS, {})
      },
    },
    {
      method: 'POST',
      path: '/mobile/api/v1/devices/revoke-all',
      handler: async ({ req, res, info, gateway, peer }) => {
        if (!peer.local) throw new GatewayError(CODES.PERMISSION_DENIED)
        const body = await gateway.readJson(req)
        if (body.confirmText !== 'REVOKE ALL') throw new GatewayError(CODES.INVALID_CONFIRM_TEXT)
        const count = gateway.devices.revokeAll()
        gateway.clearSessionCookie(req, res, info)
        gateway.sendJson(req, res, CODES.SUCCESS, { revoked: count })
      },
    },
    {
      method: 'DELETE',
      path: DEVICE_PATH,
      handler: async ({ req, res, gateway, peer, params }) => {
        if (!peer.local) throw new GatewayError(CODES.PERMISSION_DENIED)
        gateway.devices.remove(params[0] ?? '')
        gateway.sendJson(req, res, CODES.SUCCESS, {})
      },
    },
    {
      method: 'POST',
      path: '/mobile/api/v1/devices/purge',
      handler: async ({ req, res, gateway, peer }) => {
        if (!peer.local) throw new GatewayError(CODES.PERMISSION_DENIED)
        const body = await gateway.readJson(req)
        if (body.confirmText !== 'DELETE REVOKED') throw new GatewayError(CODES.INVALID_CONFIRM_TEXT)
        const deleted = gateway.devices.purgeInactive()
        gateway.sendJson(req, res, CODES.SUCCESS, { deleted })
      },
    },
  ]
}
