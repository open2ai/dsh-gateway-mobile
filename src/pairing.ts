/**
 * One-time pairing codes.
 *
 * Codes live only in memory: a restart invalidates them. The code is shown to
 * the local operator (admin page/console) and is deliberately never returned
 * by a public endpoint. The pairing URL keeps the code in the fragment so it
 * does not reach server access logs.
 *
 * @module dsh-gateway-mobile/lib/pairing
 */

import { CODES, GatewayError } from './errors.js'
import { formatPairingCode, normalizePairingCode, randomCode, timingSafeEqualString } from './util.js'

export interface PairingRecord {
  code: string
  createdAt: number
  expiresAt: number
  usedAt: number | null
  usedBy: string | null
}

export interface PairingDescription {
  code: string
  formatted: string
  createdAt: number
  expiresAt: number
  expiresIn: number
  used: boolean
}

export interface PairingStatus {
  valid: boolean
  expiresIn: number
  used: boolean
}

interface PairingLogger {
  info(message: string): void
  audit(entry: Record<string, unknown>): void
}

export class PairingManager {
  current: PairingRecord | null
  logger: PairingLogger
  ttlSeconds: number
  usedCodes: Map<string, number>

  constructor(options: { ttlSeconds: number; logger: PairingLogger }) {
    this.ttlSeconds = options.ttlSeconds
    this.logger = options.logger
    this.current = null
    this.usedCodes = new Map()
    this.issue()
  }

  /** Generate (and replace) the active pairing code. */
  issue(): PairingDescription {
    const code = randomCode(8)
    const now = Date.now()
    this.current = {
      code,
      createdAt: now,
      expiresAt: now + this.ttlSeconds * 1000,
      usedAt: null,
      usedBy: null,
    }
    this.logger.info(`Pairing code issued (valid ${this.ttlSeconds}s): ${formatPairingCode(code)}`)
    return this.describe()
  }

  describe(): PairingDescription {
    const current = this.#require()
    return {
      code: current.code,
      formatted: formatPairingCode(current.code),
      createdAt: current.createdAt,
      expiresAt: current.expiresAt,
      expiresIn: Math.max(0, Math.ceil((current.expiresAt - Date.now()) / 1000)),
      used: current.usedAt !== null,
    }
  }

  /** Public status without exposing the code. */
  status(): PairingStatus {
    const current = this.current
    if (!current) return { valid: false, expiresIn: 0, used: false }
    const expiresIn = Math.max(0, Math.ceil((current.expiresAt - Date.now()) / 1000))
    return { valid: expiresIn > 0 && current.usedAt === null, expiresIn, used: current.usedAt !== null }
  }

  /**
   * Validate a submitted code and consume it on success.
   */
  consume(submitted: string, deviceName: string): { code: string; next: PairingDescription } {
    const current = this.#require()
    const code = normalizePairingCode(submitted)
    if (!/^[A-Z0-9]{8}$/.test(code)) throw new GatewayError(CODES.INVALID_PAIRING_CODE)
    if (this.usedCodes.has(code)) throw new GatewayError(CODES.PAIRING_TOKEN_USED)
    if (current.usedAt !== null) throw new GatewayError(CODES.PAIRING_TOKEN_USED)
    if (Date.now() > current.expiresAt) throw new GatewayError(CODES.PAIRING_TOKEN_EXPIRED)
    if (!timingSafeEqualString(code, current.code)) throw new GatewayError(CODES.PAIRING_FAILED)
    current.usedAt = Date.now()
    current.usedBy = deviceName
    this.usedCodes.set(current.code, current.expiresAt)
    if (this.usedCodes.size > 50) {
      const now = Date.now()
      for (const [used, expiry] of this.usedCodes) if (expiry < now) this.usedCodes.delete(used)
    }
    this.logger.audit({ action: 'pairing.consumed', deviceName })
    // A used code is useless; issue the next one immediately for the next device.
    const next = this.issue()
    return { code: current.code, next }
  }

  #require(): PairingRecord {
    if (!this.current) this.issue()
    return this.current as PairingRecord
  }
}
