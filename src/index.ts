/**
 * dsh-gateway-mobile — a DSH Host plugin that exposes the local Web UI to
 * paired mobile devices through an outbound Cloudflare Quick Tunnel.
 *
 * DSH itself stays on 127.0.0.1:3080. The gateway listens on loopback only,
 * terminates the public tunnel at its own authenticated proxy, and keeps the
 * DSH browser cookie inside this process.
 *
 * @module dsh-gateway-mobile
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalizeConfig } from './config.js'
import { DeviceManager } from './devices.js'
import { Gateway } from './gateway.js'
import { Logger } from './logger.js'
import { OAuthManager } from './oauth.js'
import { PairingManager } from './pairing.js'
import { DshCookieProvider, ProxyEngine } from './proxy.js'
import { SessionManager } from './sessions.js'
import { SettingsStore } from './settings.js'
import { StatsStore } from './stats.js'
import { SecretBox, ensureDir } from './store.js'
import { TunnelManager } from './tunnel.js'
import { errorMessage } from './util.js'

export const name = 'dsh-gateway-mobile'
export const inject = ['webServer', 'connection']

const packageJson = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }
export const version: string = packageJson.version

export interface CordisContext {
  webServer: {
    getOrigin(): string
  }
  connection: {
    authenticatedUrl(origin: string): Promise<string> | string
  }
  effect(callback: () => () => void, label?: string): unknown
}

/**
 * Cordis entry. The profile row supplies the config from cordis.patch.yml.
 */
export async function apply(ctx: CordisContext, rawConfig?: unknown): Promise<void> {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return

  await ensureDir(config.dataDir)
  const logger = new Logger({
    level: config.log.level,
    maxEntries: config.log.maxEntries,
    file: `${config.dataDir}/gateway.log`,
  })
  logger.info(`Starting dsh-gateway-mobile ${version}`)

  const settingsStore = new SettingsStore({ dataDir: config.dataDir, logger })
  settingsStore.load()
  settingsStore.applyToConfig(config)

  const box = new SecretBox(config.dataDir).load()
  const devices = new DeviceManager({
    dataDir: config.dataDir,
    maxDevices: config.device.maxDevicesPerUser,
    inactiveExpiryDays: config.device.inactiveExpiryDays,
    logger,
  })
  devices.startCleanup()

  const stats = new StatsStore({ dataDir: config.dataDir })
  const pairing = new PairingManager({ ttlSeconds: config.auth.pairingTokenExpiry, logger })
  const sessions = new SessionManager({ box, maxAgeSeconds: config.auth.sessionMaxAge })
  let gateway: Gateway
  const tunnel = new TunnelManager({
    config,
    logger,
    gatewayPort: () => gateway?.port ?? config.gateway.port,
  })
  const cookieProvider = new DshCookieProvider({ ctx, logger })
  const proxy = new ProxyEngine({
    ctx,
    config,
    logger,
    cookieProvider,
    publicBase: () => gateway?.publicBase() ?? '',
    deviceManager: devices,
  })
  const oauth = new OAuthManager({
    config,
    logger,
    devices,
    box,
    publicBase: () => gateway?.publicBase() ?? `http://127.0.0.1:${config.gateway.port}`,
  })
  gateway = new Gateway({
    config,
    logger,
    tunnel,
    pairing,
    sessions,
    devices,
    cookieProvider,
    proxy,
    oauth,
    stats,
    settingsStore,
    version,
  })

  try {
    await gateway.listen()
  } catch (error) {
    devices.stopCleanup()
    proxy.close()
    throw error
  }

  logger.info(`Admin console: ${gateway.origin}/admin`)
  logger.info(`Pairing code: ${pairing.describe().formatted} (valid ${config.auth.pairingTokenExpiry}s)`)

  if (config.tunnel.enabled) {
    void tunnel
      .start()
      .then(() => {
        const status = tunnel.status()
        if (status.url) {
          logger.info(`Public URL: ${status.url}`)
          logger.info(`Pair on your phone: ${status.url}/mobile/pair`)
          logger.info(`Admin (local): ${gateway.origin}/admin`)
          const next = pairing.describe()
          logger.info(`Pairing code: ${next.formatted}`)
        }
      })
      .catch((error: unknown) => {
        logger.error(`Tunnel unavailable; gateway still reachable on loopback: ${errorMessage(error)}`)
        logger.error('Install cloudflared or set tunnel.binaryPath, then restart the tunnel from /admin.')
      })
  } else {
    logger.info('Tunnel disabled; use your own reverse proxy or access the gateway on loopback')
  }

  ctx.effect(
    () => () => {
      logger.info('Disposing dsh-gateway-mobile')
      devices.stopCleanup()
      void devices.flush().catch(() => {})
      void stats.flush().catch(() => {})
      void gateway.close().catch((error: unknown) => logger.warn(`Gateway close failed: ${errorMessage(error)}`))
      void tunnel.stop().catch((error: unknown) => logger.warn(`Tunnel stop failed: ${errorMessage(error)}`))
      proxy.close()
    },
    'dsh-gateway-mobile lifecycle',
  )
}
