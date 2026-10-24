/**
 * Signed session cookies for paired devices.
 *
 * The payload is base64url(JSON) + "." + HMAC-SHA256, validated in constant
 * time. Sessions are stateless; revocation is enforced against the device
 * record on every request.
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
  hmac(data: string): string
}

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
    const signature = this.box.hmac(encoded)
    return {
      token: `${encoded}.${signature}`,
      expiresAt: payload.expiresAt,
      maxAge: this.maxAgeSeconds,
    }
  }

  verify(token: string | undefined): SessionVerifyResult {
    if (!token || typeof token !== 'string') return { ok: false, code: CODES.UNAUTHENTICATED }
    const dot = token.indexOf('.')
    if (dot <= 0 || dot === token.length - 1) return { ok: false, code: CODES.SESSION_INVALID }
    const encoded = token.slice(0, dot)
    const signature = token.slice(dot + 1)
    const expected = this.box.hmac(encoded)
    if (!timingSafeEqualString(signature, expected)) return { ok: false, code: CODES.SESSION_INVALID }
    let parsed: unknown
    try {
      parsed = JSON.parse(base64urlDecode(encoded))
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
