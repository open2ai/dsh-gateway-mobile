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
import type { CapabilityMatrix } from './gateway.js'
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
/**
 * The gateway needs `webServer`/`connection`; the WeChat bridge and workspace
 * resolver need `sessionController`/`workspaceRegistry`. Cordis has no optional
 * dependency form, and `ctx.get()` cannot see a sibling-provided service without
 * the inject declaration, so these stay required. `userQuestions` remains an
 * optional, probed capability (it only affects late answers).
 */
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
  /** Cordis reflection accessor; used to probe optional services without requiring them. */
  get?<T = unknown>(name: string, strict?: boolean): T | undefined
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
  userQuestions?: {
    answer(agent: unknown, callId: string, answer: unknown): unknown
  }
  on(
    event: string,
    listener: (...args: any[]) => unknown,
    options?: { prepend?: boolean },
  ): unknown
  off(event: string, listener: (...args: any[]) => unknown): unknown
  effect(callback: () => () => void | Promise<void>, label?: string): unknown
}

function optionalService<T>(ctx: CordisContext, name: string): T | undefined {
  // `ctx.get` is the only failure-safe accessor: reading an undeclared property
  // off the Cordis proxy throws "cannot get property ... without inject".
  if (typeof ctx.get === 'function') {
    try {
      const value = ctx.get<T>(name)
      if (value !== undefined && value !== null) return value
    } catch {
      // A missing service must degrade, not abort plugin startup.
    }
  }
  try {
    return (ctx as unknown as Record<string, unknown>)[name] as T | undefined
  } catch {
    return undefined
  }
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
    maxBytes: config.log.maxBytes,
    maxFiles: config.log.maxFiles,
    file: `${config.dataDir}/gateway.log`,
  })
  logger.info(`Starting dsh-gateway-mobile ${version}`)

  const settingsStore = new SettingsStore({ dataDir: config.dataDir, logger })
  settingsStore.load()
  settingsStore.applyToConfig(config)
  // The logger was built before stored overrides were applied; align its level.
  logger.setLevel(config.log.level)

  const box = new SecretBox(config.dataDir).load()
  const sessionControllerCandidate: unknown = optionalService(ctx, 'sessionController')
  const sessionController = isSessionController(sessionControllerCandidate) ? sessionControllerCandidate : undefined
  const workspaceRegistryCandidate: unknown = optionalService(ctx, 'workspaceRegistry')
  const workspaceRegistry = isWorkspaceRegistry(workspaceRegistryCandidate) ? workspaceRegistryCandidate : undefined
  const userQuestionsCandidate: unknown = optionalService(ctx, 'userQuestions')
  const userQuestions = isUserQuestions(userQuestionsCandidate) ? userQuestionsCandidate : undefined
  const capabilities: CapabilityMatrix = {
    controller: Boolean(sessionController),
    workspaceRegistry: Boolean(workspaceRegistry),
    userQuestions: Boolean(userQuestions),
    weixin: true,
    tunnel: { enabled: config.tunnel.enabled, mode: config.tunnel.mode },
  }
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
    const workspaces = workspaceRegistry?.list() ?? []
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
    controller: sessionController,
    events: ctx,
    logger,
    dataDir: config.dataDir,
    resolveCwd: () => latestWorkspace()?.path,
    resolveWorkspaceId: () => latestWorkspace()?.id,
    ensureWorkspace: workspaceSession,
    approvalMaxPerHour: config.weixin.approval.maxPerHour,
    lateAnswer: (agent, callId, answer) => {
      const service = userQuestions
      if (!service) return false
      try {
        const result = service.answer(agent, callId, answer)
        return result instanceof Promise ? result.then((value) => value === true) : result === true
      } catch {
        return false
      }
    },
  })
  const weixinNotifier = new WeixinNotifier({
    channel: weixin,
    controller: sessionController,
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
    secretBox: box,
    upstreamOrigin: () => ctx.webServer.getOrigin(),
    capabilities,
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
  logger.info(`Pairing code: ${maskPairingCode(pairing.describe().formatted)} (valid ${config.auth.pairingTokenExpiry}s)`)
  if (config.weixin.enabled) {
    void weixinBridge
      .start()
      .then(async () => {
        await weixin.start()
        await weixinNotifier.start()
      })
      .catch((error: unknown) => logger.warn(`WeChat channel start failed: ${errorMessage(error)}`))
  } else {
    logger.info('WeChat channel disabled by configuration')
  }

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
          logger.info(`Pairing code: ${maskPairingCode(next.formatted)}`)
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
      // Every stop step is isolated so one failure cannot skip the HTTP
      // listener release (a leaked listener causes EADDRINUSE on reload).
      const safe = (label: string, fn: () => void): void => {
        try {
          fn()
        } catch (error) {
          logger.warn(`Dispose step "${label}" failed: ${errorMessage(error)}`)
        }
      }
      safe('weixin-notifier', () => weixinNotifier.stop())
      safe('weixin-bridge', () => weixinBridge.stop())
      safe('weixin', () => weixin.stop())
      safe('device-cleanup', () => devices.stopCleanup())
      safe('proxy', () => proxy.close())
      await Promise.allSettled([
        gateway.close(),
        tunnel.stop(),
        devices.flush(),
        stats.flush(),
      ])
      await logger.flush()
    },
    'dsh-gateway-mobile lifecycle',
  )
}

type WorkspaceRegistryLike = NonNullable<CordisContext['workspaceRegistry']>
type UserQuestionsLike = NonNullable<CordisContext['userQuestions']>

function isWorkspaceRegistry(value: unknown): value is WorkspaceRegistryLike {
  if (!value || typeof value !== 'object') return false
  return typeof (value as { list?: unknown }).list === 'function'
}

function isUserQuestions(value: unknown): value is UserQuestionsLike {
  if (!value || typeof value !== 'object') return false
  return typeof (value as { answer?: unknown }).answer === 'function'
}

/** Never print a complete pairing code to the console or the log file. */
function maskPairingCode(formatted: string): string {
  const compact = formatted.replace(/[^A-Za-z0-9]/g, '')
  return `****-${compact.slice(-2)}`
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
