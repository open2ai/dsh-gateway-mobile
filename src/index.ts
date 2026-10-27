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
import { WeixinChannel } from './weixin.js'
import { WeixinBridge } from './weixin-bridge.js'
import { WeixinNotifier } from './weixin-notifier.js'
import type { SessionControllerLike, WeixinApprovalOutcome } from './weixin-bridge.js'
import { errorMessage } from './util.js'

export const name = 'dsh-gateway-mobile'
export const inject = ['webServer', 'connection', 'sessionController', 'workspaceRegistry']

const packageJson = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }
export const version: string = packageJson.version

export interface CordisContext {
  webServer: {
    getOrigin(): string
  }
  connection: {
    authenticatedUrl(origin: string): Promise<string> | string
  }
  sessionController?: SessionControllerLike
  workspaceRegistry?: {
    list(): Array<{
      id: string
      path: string
      updatedAt?: string
      sessionIds?: readonly string[]
      attachSession?(sessionId: string): Promise<void>
    }>
  }
  on(event: string, listener: (request: unknown, next: () => Promise<WeixinApprovalOutcome>) => Promise<WeixinApprovalOutcome>): unknown
  off(event: string, listener: (request: unknown, next: () => Promise<WeixinApprovalOutcome>) => Promise<WeixinApprovalOutcome>): unknown
  effect(callback: () => () => void | Promise<void>, label?: string): unknown
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
  const weixin = new WeixinChannel({
    dataDir: config.dataDir,
    config: config.weixin,
    logger,
    box,
  })
  const latestWorkspace = () => {
    const workspaces = ctx.workspaceRegistry?.list() ?? []
    if (workspaces.length === 0) return undefined
    return [...workspaces]
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0]
  }
  const workspaceSession = (sessionId: string): Promise<void> => {
    const workspace = latestWorkspace()
    if (!workspace?.attachSession || workspace.sessionIds?.includes(sessionId)) return Promise.resolve()
    return workspace.attachSession(sessionId)
  }
  const weixinBridge = new WeixinBridge({
    channel: weixin,
    controller: isSessionController(ctx.sessionController) ? ctx.sessionController : undefined,
    events: ctx,
    logger,
    dataDir: config.dataDir,
    resolveCwd: () => latestWorkspace()?.path,
    resolveWorkspaceId: () => latestWorkspace()?.id,
    ensureWorkspace: workspaceSession,
    approvalMaxPerHour: config.weixin.approval.maxPerHour,
  })
  const weixinNotifier = new WeixinNotifier({
    channel: weixin,
    controller: isSessionController(ctx.sessionController) ? ctx.sessionController : undefined,
    config: config.weixin.notify,
    logger,
    dataDir: config.dataDir,
    excludeSessionId: () => weixinBridge.currentSessionId,
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
    weixin,
    weixinNotifier,
    weixinApprovalHistory: () => weixinBridge.approvalHistorySnapshot(),
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
  void weixinBridge
    .start()
    .then(async () => {
      await weixin.start()
      await weixinNotifier.start()
    })
    .catch((error: unknown) => logger.warn(`WeChat channel start failed: ${errorMessage(error)}`))

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
    () => async () => {
      logger.info('Disposing dsh-gateway-mobile')
      weixinNotifier.stop()
      weixinBridge.stop()
      weixin.stop()
      devices.stopCleanup()
      proxy.close()
      await Promise.allSettled([
        gateway.close(),
        tunnel.stop(),
        devices.flush(),
        stats.flush(),
      ])
    },
    'dsh-gateway-mobile lifecycle',
  )
}

function isSessionController(value: unknown): value is SessionControllerLike {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SessionControllerLike>
  return (
    typeof candidate.create === 'function' &&
    typeof candidate.prompt === 'function' &&
    typeof candidate.follow === 'function' &&
    typeof candidate.list === 'function'
  )
}
