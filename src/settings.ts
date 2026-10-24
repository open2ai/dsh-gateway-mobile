/**
 * Persistent, loopback-only admin settings.
 *
 * Values are stored in `<dataDir>/admin-settings.json` and applied on top of the
 * profile config at startup. Only auth lifetimes are mutable at runtime; they
 * are validated again by the gateway before being written.
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

export interface AuthSettings {
  sessionMaxAge?: number
  pairingTokenExpiry?: number
}

export interface AuthLifetimeConfig {
  auth: {
    sessionMaxAge: number
    pairingTokenExpiry: number
  }
}

interface LoggerLike {
  audit?(entry: Record<string, unknown>): void
}

export function validLifetime(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max
}

export class SettingsStore {
  file: string
  logger: LoggerLike | undefined
  values: AuthSettings

  constructor(options: { dataDir: string; logger?: LoggerLike }) {
    this.file = path.join(options.dataDir, 'admin-settings.json')
    this.logger = options.logger
    this.values = {}
  }

  load(): AuthSettings {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AuthSettings>
      this.values = {}
      if (validLifetime(parsed.sessionMaxAge, SESSION_MIN, SESSION_MAX)) {
        this.values.sessionMaxAge = parsed.sessionMaxAge
      }
      if (validLifetime(parsed.pairingTokenExpiry, PAIRING_MIN, PAIRING_MAX)) {
        this.values.pairingTokenExpiry = parsed.pairingTokenExpiry
      }
      return { ...this.values }
    } catch {
      return {}
    }
  }

  /** Apply stored overrides to a normalized config object. */
  applyToConfig(config: AuthLifetimeConfig): void {
    if (this.values.sessionMaxAge !== undefined) config.auth.sessionMaxAge = this.values.sessionMaxAge
    if (this.values.pairingTokenExpiry !== undefined) config.auth.pairingTokenExpiry = this.values.pairingTokenExpiry
  }

  async save(patch: AuthSettings): Promise<void> {
    this.values = { ...this.values, ...patch }
    await fsp.mkdir(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await fsp.writeFile(temp, `${JSON.stringify(this.values, null, 2)}\n`, 'utf8')
    await fsp.rename(temp, this.file)
    this.logger?.audit?.({ action: 'admin.settings.saved', ...patch })
  }
}
