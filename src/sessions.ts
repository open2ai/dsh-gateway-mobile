/**
 * Signed session cookies for paired devices.
 *
 * The payload is `<kid>:base64url(JSON)` + "." + HMAC-SHA256, validated in
 * constant time. The key id lets a rotated key set keep every previously
 * issued token valid: `verify` tries the embedded key first and falls back to
 * all retained keys (including legacy tokens without a kid prefix).
 * Sessions are stateless; revocation is enforced against the device record on
 * every request.
 *
 * @module dsh-gateway-mobile/lib/sessions
 */

import { CODES, GatewayError } from './errors.js'
import { base64urlDecode, base64urlEncode, timingSafeEqualString } from './util.js'

export const SESSION_COOKIE = 'dsh_session'

export interface SessionPayload {
  v: 1
  deviceId: string
  issuedAt: number
  expiresAt: number
}

export type SessionVerifyResult =
  | { ok: true; payload: SessionPayload }
  | { ok: false; code: number }

interface SecretBoxLike {
  hmac(data: string, kid?: string): string
  keyIds?(): string[]
  activeKid?: string
}

const KID_PATTERN = /^[A-Za-z0-9_-]+$/

export class SessionManager {
  box: SecretBoxLike
  maxAgeSeconds: number

  constructor(options: { box: SecretBoxLike; maxAgeSeconds: number }) {
    this.box = options.box
    this.maxAgeSeconds = options.maxAgeSeconds
  }

  issue(deviceId: string): { token: string; expiresAt: number; maxAge: number } {
    const now = Date.now()
    const payload: SessionPayload = {
      v: 1,
      deviceId,
      issuedAt: now,
      expiresAt: now + this.maxAgeSeconds * 1000,
    }
    const encoded = base64urlEncode(JSON.stringify(payload))
    const kid = this.#activeKid()
    const signature = this.#hmacFor(encoded, kid)
    return {
      token: `${kid}:${encoded}.${signature}`,
      expiresAt: payload.expiresAt,
      maxAge: this.maxAgeSeconds,
    }
  }

  verify(token: string | undefined): SessionVerifyResult {
    if (!token || typeof token !== 'string') return { ok: false, code: CODES.UNAUTHENTICATED }
    const parsedToken = this.#splitToken(token)
    if (!parsedToken) return { ok: false, code: CODES.SESSION_INVALID }
    if (!this.#signatureMatches(parsedToken.encoded, parsedToken.signature, parsedToken.kid)) {
      return { ok: false, code: CODES.SESSION_INVALID }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(base64urlDecode(parsedToken.encoded))
    } catch {
      return { ok: false, code: CODES.SESSION_INVALID }
    }
    if (!parsed || typeof parsed !== 'object') return { ok: false, code: CODES.SESSION_INVALID }
    const payload = parsed as Partial<SessionPayload>
    if (payload.v !== 1 || typeof payload.deviceId !== 'string') {
      return { ok: false, code: CODES.SESSION_INVALID }
    }
    if (!Number.isFinite(payload.expiresAt) || Date.now() > Number(payload.expiresAt)) {
      return { ok: false, code: CODES.SESSION_EXPIRED }
    }
    return { ok: true, payload: payload as SessionPayload }
  }

  #activeKid(): string {
    const kid = this.box.activeKid
    return typeof kid === 'string' && KID_PATTERN.test(kid) ? kid : 'k1'
  }

  #knownKids(): string[] {
    try {
      const kids = this.box.keyIds?.()
      return Array.isArray(kids) ? kids.filter((kid): kid is string => typeof kid === 'string' && KID_PATTERN.test(kid)) : []
    } catch {
      return []
    }
  }

  #hmacFor(encoded: string, kid?: string): string {
    try {
      return kid ? this.box.hmac(encoded, kid) : this.box.hmac(encoded)
    } catch {
      return this.box.hmac(encoded)
    }
  }

  /**
   * Split `<kid>:<payload>.<signature>` or the legacy `<payload>.<signature>`.
   */
  #splitToken(token: string): { kid?: string; encoded: string; signature: string } | null {
    const colon = token.indexOf(':')
    const firstDot = token.indexOf('.')
    let kid: string | undefined
    let body = token
    if (colon > 0 && (firstDot < 0 || colon < firstDot)) {
      const candidate = token.slice(0, colon)
      if (!KID_PATTERN.test(candidate)) return null
      kid = candidate
      body = token.slice(colon + 1)
    }
    const dot = body.indexOf('.')
    if (dot <= 0 || dot === body.length - 1) return null
    return { ...(kid ? { kid } : {}), encoded: body.slice(0, dot), signature: body.slice(dot + 1) }
  }

  #signatureMatches(encoded: string, signature: string, kid?: string): boolean {
    const kids = this.#knownKids()
    const candidates: Array<string | undefined> = []
    if (kid) candidates.push(kid)
    if (kids.length === 0) candidates.push(undefined)
    for (const candidate of kids) if (candidate !== kid) candidates.push(candidate)
    for (const candidate of candidates) {
      let expected: string
      try {
        expected = candidate ? this.box.hmac(encoded, candidate) : this.box.hmac(encoded)
      } catch {
        continue
      }
      if (timingSafeEqualString(signature, expected)) return true
    }
    return false
  }
}

/** Parse the session token out of a request's cookies. */
export function sessionTokenFromCookies(cookies: Record<string, string> | undefined): string | undefined {
  return cookies?.[SESSION_COOKIE]
}

/** Throw the matching GatewayError for a failed session check. */
export function requireSessionResult(result: SessionVerifyResult): SessionPayload {
  if (!result.ok) throw new GatewayError(result.code)
  return result.payload
}
