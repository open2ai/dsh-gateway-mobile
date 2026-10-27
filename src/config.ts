/**
 * Configuration defaults and validation for dsh-gateway-mobile.
 *
 * The plugin receives the row config from Cordis. We validate manually (no
 * schemastery dependency) so the package installs without extra peers.
 *
 * @module dsh-gateway-mobile/lib/config
 */

import os from 'node:os'
import path from 'node:path'

export interface GatewayConfig {
  enabled: boolean
  dataDir: string
  gateway: {
    host: string
    port: number
    publicUrl: string
  }
  tunnel: {
    enabled: boolean
    mode: string
    domain: string
    binaryPath: string
    autoDownload: boolean
    version: string
    sha256: string
    protocol: string
    maxRetries: number
    token: string
  }
  auth: {
    pairingTokenExpiry: number
    sessionMaxAge: number
    requireOAuth: boolean
    oauthProviders: string[]
    githubClientId: string
    githubClientSecret: string
    giteeClientId: string
    giteeClientSecret: string
  }
  proxy: {
    upstream: string
    wsHeartbeatInterval: number
    maxRequestSize: number
    requestTimeoutMs: number
  }
  security: {
    rateLimitWindow: number
    rateLimitMax: number
    pairingMaxAttempts: number
    pairingLockoutDuration: number
    corsOrigins: string[]
    trustProxy: boolean
    secureCookies: string
  }
  device: {
    inactiveExpiryDays: number
    maxDevicesPerUser: number
  }
  weixin: WeixinConfig
  log: {
    level: string
    maxEntries: number
  }
}

export interface WeixinConfig {
  enabled: boolean
  baseUrl: string
  cdnBase: string
  routeTag: string
  channelVersion: string
  requireApproval: boolean
  notify: WeixinNotifyConfig
  approval: WeixinApprovalConfig
}

export interface WeixinApprovalConfig {
  maxPerHour: number
}

export interface WeixinNotifyConfig {
  enabled: boolean
  debounceMs: number
  perSessionIntervalMs: number
  globalIntervalMs: number
  maxPerHour: number
}

export interface RuntimeEnv {
  env?: Record<string, string | undefined>
  home?: string
}

const DEFAULTS = {
  enabled: true,
  dataDir: '',
  gateway: {
    host: '127.0.0.1',
    port: 3081,
    /** Optional external base URL used for cookies/QR/OAuth (Named Tunnel). */
    publicUrl: '',
  },
  tunnel: {
    enabled: true,
    mode: 'quick',
    domain: '',
    binaryPath: '',
    autoDownload: true,
    version: '2026.10.3',
    sha256: '',
    protocol: 'http2',
    maxRetries: 10,
    /** Used only when mode === 'named'. Prefer the env var to avoid writing it to disk. */
    token: '',
  },
  auth: {
    pairingTokenExpiry: 900,
    sessionMaxAge: 86400,
    requireOAuth: false,
    oauthProviders: ['github'],
    githubClientId: '',
    githubClientSecret: '',
    giteeClientId: '',
    giteeClientSecret: '',
  },
  proxy: {
    /** Empty means: use ctx.webServer.getOrigin(). */
    upstream: '',
    wsHeartbeatInterval: 30000,
    maxRequestSize: 10 * 1024 * 1024,
    requestTimeoutMs: 0,
  },
  security: {
    rateLimitWindow: 300,
    rateLimitMax: 300,
    pairingMaxAttempts: 5,
    pairingLockoutDuration: 300,
    corsOrigins: [],
    trustProxy: true,
    secureCookies: 'auto',
  },
  device: {
    inactiveExpiryDays: 30,
    maxDevicesPerUser: 10,
  },
  weixin: {
    enabled: true,
    baseUrl: 'https://ilinkai.weixin.qq.com',
    cdnBase: 'https://novac2c.cdn.weixin.qq.com/c2c',
    routeTag: '',
    channelVersion: '1.0.0',
    requireApproval: true,
    notify: {
      enabled: true,
      debounceMs: 5000,
      perSessionIntervalMs: 30000,
      globalIntervalMs: 10000,
      maxPerHour: 20,
    },
    approval: {
      maxPerHour: 60,
    },
  },
  log: {
    level: 'info',
    maxEntries: 100,
  },
} satisfies GatewayConfig

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function merge<T>(base: T, override: unknown): T {
  if (override === undefined) return base
  if (Array.isArray(base)) return (Array.isArray(override) ? override.slice() : base) as T
  if (!isPlainObject(base)) return override as T
  if (!isPlainObject(override)) return base
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    out[key] = key in base ? merge((base as Record<string, unknown>)[key], value) : value
  }
  return out as T
}

function fail(name: string, message: string, value: unknown): never {
  throw new TypeError(`dsh-gateway-mobile: config "${name}" ${message} (got ${JSON.stringify(value)})`)
}

function requireString(
  name: string,
  value: unknown,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string') fail(name, 'must be a string', value)
  if (!allowEmpty && value.trim() === '') fail(name, 'must not be empty', value)
  return value
}

function requireBoolean(name: string, value: unknown): boolean {
  if (typeof value !== 'boolean') fail(name, 'must be a boolean', value)
  return value
}

function requireInt(name: string, value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    fail(name, `must be an integer from ${min} through ${max}`, value)
  }
  return value as number
}

function requireStringArray(name: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(name, 'must be an array of strings', value)
  }
  return value.slice() as string[]
}

/**
 * Normalize and validate the user configuration.
 *
 * @param raw - Row config from cordis.patch.yml.
 * @param runtime - Environment/home overrides.
 */
export function normalizeConfig(raw?: unknown, runtime: RuntimeEnv = {}): GatewayConfig {
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    throw new TypeError('dsh-gateway-mobile: config must be a mapping')
  }
  const env = runtime.env ?? process.env
  const home = runtime.home ?? env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const merged = merge(structuredClone(DEFAULTS), raw ?? {})
  if (env.DSH_GATEWAY_SESSION_MAX_AGE !== undefined) {
    merged.auth.sessionMaxAge = Number(env.DSH_GATEWAY_SESSION_MAX_AGE)
  }
  if (env.DSH_GATEWAY_PAIRING_TOKEN_EXPIRY !== undefined) {
    merged.auth.pairingTokenExpiry = Number(env.DSH_GATEWAY_PAIRING_TOKEN_EXPIRY)
  }

  const cfg: GatewayConfig = {
    enabled: requireBoolean('enabled', merged.enabled),
    dataDir: '',
    gateway: {
      host: requireString('gateway.host', merged.gateway.host),
      port: requireInt('gateway.port', merged.gateway.port, 0, 65535),
      publicUrl: requireString('gateway.publicUrl', merged.gateway.publicUrl, { allowEmpty: true }),
    },
    tunnel: {
      enabled: requireBoolean('tunnel.enabled', merged.tunnel.enabled),
      mode: requireString('tunnel.mode', merged.tunnel.mode),
      domain: requireString('tunnel.domain', merged.tunnel.domain, { allowEmpty: true }),
      binaryPath: requireString('tunnel.binaryPath', merged.tunnel.binaryPath, { allowEmpty: true }),
      autoDownload: requireBoolean('tunnel.autoDownload', merged.tunnel.autoDownload),
      version: requireString('tunnel.version', merged.tunnel.version),
      sha256: requireString('tunnel.sha256', merged.tunnel.sha256, { allowEmpty: true }),
      protocol: requireString('tunnel.protocol', merged.tunnel.protocol),
      maxRetries: requireInt('tunnel.maxRetries', merged.tunnel.maxRetries, 0, 100),
      token: requireString('tunnel.token', merged.tunnel.token, { allowEmpty: true }),
    },
    auth: {
      pairingTokenExpiry: requireInt('auth.pairingTokenExpiry', merged.auth.pairingTokenExpiry, 30, 86400),
      sessionMaxAge: requireInt('auth.sessionMaxAge', merged.auth.sessionMaxAge, 300, 90 * 86400),
      requireOAuth: requireBoolean('auth.requireOAuth', merged.auth.requireOAuth),
      oauthProviders: requireStringArray('auth.oauthProviders', merged.auth.oauthProviders),
      githubClientId: requireString('auth.githubClientId', merged.auth.githubClientId, { allowEmpty: true }),
      githubClientSecret: requireString('auth.githubClientSecret', merged.auth.githubClientSecret, { allowEmpty: true }),
      giteeClientId: requireString('auth.giteeClientId', merged.auth.giteeClientId, { allowEmpty: true }),
      giteeClientSecret: requireString('auth.giteeClientSecret', merged.auth.giteeClientSecret, { allowEmpty: true }),
    },
    proxy: {
      upstream: requireString('proxy.upstream', merged.proxy.upstream, { allowEmpty: true }),
      wsHeartbeatInterval: requireInt('proxy.wsHeartbeatInterval', merged.proxy.wsHeartbeatInterval, 5000, 300000),
      maxRequestSize: requireInt('proxy.maxRequestSize', merged.proxy.maxRequestSize, 1024, 1024 * 1024 * 1024),
      requestTimeoutMs: requireInt('proxy.requestTimeoutMs', merged.proxy.requestTimeoutMs, 0, 3600000),
    },
    security: {
      rateLimitWindow: requireInt('security.rateLimitWindow', merged.security.rateLimitWindow, 1, 86400),
      rateLimitMax: requireInt('security.rateLimitMax', merged.security.rateLimitMax, 1, 1e9),
      pairingMaxAttempts: requireInt('security.pairingMaxAttempts', merged.security.pairingMaxAttempts, 1, 1000),
      pairingLockoutDuration: requireInt('security.pairingLockoutDuration', merged.security.pairingLockoutDuration, 1, 86400),
      corsOrigins: requireStringArray('security.corsOrigins', merged.security.corsOrigins),
      trustProxy: requireBoolean('security.trustProxy', merged.security.trustProxy),
      secureCookies: requireString('security.secureCookies', merged.security.secureCookies),
    },
    device: {
      inactiveExpiryDays: requireInt('device.inactiveExpiryDays', merged.device.inactiveExpiryDays, 1, 3650),
      maxDevicesPerUser: requireInt('device.maxDevicesPerUser', merged.device.maxDevicesPerUser, 1, 100),
    },
    weixin: {
      enabled: requireBoolean('weixin.enabled', merged.weixin.enabled),
      baseUrl: requireString('weixin.baseUrl', merged.weixin.baseUrl),
      cdnBase: requireString('weixin.cdnBase', merged.weixin.cdnBase),
      routeTag: requireString('weixin.routeTag', merged.weixin.routeTag, { allowEmpty: true }),
      channelVersion: requireString('weixin.channelVersion', merged.weixin.channelVersion),
      requireApproval: requireBoolean('weixin.requireApproval', merged.weixin.requireApproval),
      notify: {
        enabled: requireBoolean('weixin.notify.enabled', merged.weixin.notify.enabled),
        debounceMs: requireInt('weixin.notify.debounceMs', merged.weixin.notify.debounceMs, 1000, 60000),
        perSessionIntervalMs: requireInt('weixin.notify.perSessionIntervalMs', merged.weixin.notify.perSessionIntervalMs, 1000, 3600000),
        globalIntervalMs: requireInt('weixin.notify.globalIntervalMs', merged.weixin.notify.globalIntervalMs, 1000, 3600000),
        maxPerHour: requireInt('weixin.notify.maxPerHour', merged.weixin.notify.maxPerHour, 1, 1000),
      },
      approval: {
        maxPerHour: requireInt('weixin.approval.maxPerHour', merged.weixin.approval.maxPerHour, 1, 1000),
      },
    },
    log: {
      level: requireString('log.level', merged.log.level),
      maxEntries: requireInt('log.maxEntries', merged.log.maxEntries, 10, 10000),
    },
  }

  if (!['quick', 'named'].includes(cfg.tunnel.mode)) fail('tunnel.mode', 'must be "quick" or "named"', cfg.tunnel.mode)
  if (!['http2', 'quic'].includes(cfg.tunnel.protocol)) fail('tunnel.protocol', 'must be "http2" or "quic"', cfg.tunnel.protocol)
  if (!['auto', 'always', 'never'].includes(cfg.security.secureCookies)) {
    fail('security.secureCookies', 'must be "auto", "always" or "never"', cfg.security.secureCookies)
  }
  if (cfg.gateway.host !== '127.0.0.1' && cfg.gateway.host !== '::1' && cfg.gateway.host !== 'localhost') {
    fail('gateway.host', 'must be a loopback address (127.0.0.1, ::1 or localhost)', cfg.gateway.host)
  }
  if (cfg.tunnel.mode === 'named' && !cfg.tunnel.domain && !cfg.gateway.publicUrl) {
    fail('tunnel.domain', 'is required in named mode (or set gateway.publicUrl)', cfg.tunnel.domain)
  }
  if (cfg.tunnel.enabled && cfg.tunnel.mode === 'named' && !cfg.tunnel.token && !env.CLOUDFLARED_TUNNEL_TOKEN) {
    fail('tunnel.token', 'is required in named mode (or set CLOUDFLARED_TUNNEL_TOKEN)', '')
  }
  if (cfg.auth.requireOAuth) {
    const enabled = cfg.auth.oauthProviders.filter((provider) => {
      if (provider === 'github') return Boolean(cfg.auth.githubClientId && cfg.auth.githubClientSecret)
      if (provider === 'gitee') return Boolean(cfg.auth.giteeClientId && cfg.auth.giteeClientSecret)
      return false
    })
    if (enabled.length === 0) {
      throw new TypeError('dsh-gateway-mobile: auth.requireOAuth is true but no OAuth provider is configured')
    }
  }
  for (const provider of cfg.auth.oauthProviders) {
    if (!['github', 'gitee'].includes(provider)) fail('auth.oauthProviders', 'only "github" and "gitee" are supported', provider)
  }

  cfg.dataDir = merged.dataDir
    ? path.resolve(String(merged.dataDir))
    : path.join(home, 'gateway-mobile')

  return cfg
}

export { DEFAULTS }
