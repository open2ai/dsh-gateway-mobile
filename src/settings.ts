/**
 * Persistent, loopback-only admin settings.
 *
 * Values are stored in `<dataDir>/admin-settings.json` and applied on top of the
 * profile config at startup. Auth lifetimes and a small set of runtime switches
 * (tunnel/WeChat enabled, log level, proxy timeout) are mutable from the admin
 * console; the gateway validates them again before writing.
 *
 * @module dsh-gateway-mobile/lib/settings
 */

import { readFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const SESSION_MIN = 300
export const SESSION_MAX = 90 * 86400
export const PAIRING_MIN = 30
export const PAIRING_MAX = 86400
export const PROXY_TIMEOUT_MIN = 0
export const PROXY_TIMEOUT_MAX = 3_600_000

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevelName = (typeof LOG_LEVELS)[number]

export interface AuthSettings {
  sessionMaxAge?: number
  pairingTokenExpiry?: number
}

/** Runtime switches that can be changed without restarting the host. */
export interface RuntimeSettings {
  tunnelEnabled?: boolean
  weixinEnabled?: boolean
  logLevel?: LogLevelName
  proxyRequestTimeoutMs?: number
}

export type StoredSettings = AuthSettings & RuntimeSettings

export interface SettingsConfig {
  auth: {
    sessionMaxAge: number
    pairingTokenExpiry: number
  }
  tunnel: {
    enabled: boolean
  }
  weixin: {
    enabled: boolean
  }
  log: {
    level: string
  }
  proxy: {
    requestTimeoutMs: number
  }
}

interface LoggerLike {
  audit?(entry: Record<string, unknown>): void
}

export function validLifetime(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max
}

export function validLogLevel(value: unknown): value is LogLevelName {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

export function validProxyTimeout(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= PROXY_TIMEOUT_MIN && Number(value) <= PROXY_TIMEOUT_MAX
}

export class SettingsStore {
  file: string
  logger: LoggerLike | undefined
  values: StoredSettings

  constructor(options: { dataDir: string; logger?: LoggerLike }) {
    this.file = path.join(options.dataDir, 'admin-settings.json')
    this.logger = options.logger
    this.values = {}
  }

  load(): StoredSettings {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoredSettings>
      this.values = {}
      if (validLifetime(parsed.sessionMaxAge, SESSION_MIN, SESSION_MAX)) {
        this.values.sessionMaxAge = parsed.sessionMaxAge
      }
      if (validLifetime(parsed.pairingTokenExpiry, PAIRING_MIN, PAIRING_MAX)) {
        this.values.pairingTokenExpiry = parsed.pairingTokenExpiry
      }
      if (typeof parsed.tunnelEnabled === 'boolean') this.values.tunnelEnabled = parsed.tunnelEnabled
      if (typeof parsed.weixinEnabled === 'boolean') this.values.weixinEnabled = parsed.weixinEnabled
      if (validLogLevel(parsed.logLevel)) this.values.logLevel = parsed.logLevel
      if (validProxyTimeout(parsed.proxyRequestTimeoutMs)) {
        this.values.proxyRequestTimeoutMs = parsed.proxyRequestTimeoutMs
      }
      return { ...this.values }
    } catch {
      return {}
    }
  }

  /** Apply stored overrides to a normalized config object. */
  applyToConfig(config: SettingsConfig): void {
    if (this.values.sessionMaxAge !== undefined) config.auth.sessionMaxAge = this.values.sessionMaxAge
    if (this.values.pairingTokenExpiry !== undefined) config.auth.pairingTokenExpiry = this.values.pairingTokenExpiry
    if (this.values.tunnelEnabled !== undefined) config.tunnel.enabled = this.values.tunnelEnabled
    if (this.values.weixinEnabled !== undefined) config.weixin.enabled = this.values.weixinEnabled
    if (this.values.logLevel !== undefined) config.log.level = this.values.logLevel
    if (this.values.proxyRequestTimeoutMs !== undefined) {
      config.proxy.requestTimeoutMs = this.values.proxyRequestTimeoutMs
    }
  }

  async save(patch: StoredSettings): Promise<void> {
    this.values = { ...this.values, ...patch }
    await fsp.mkdir(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await fsp.writeFile(temp, `${JSON.stringify(this.values, null, 2)}\n`, 'utf8')
    await fsp.rename(temp, this.file)
    this.logger?.audit?.({ action: 'admin.settings.saved', ...patch })
  }
}
