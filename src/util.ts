/**
 * Small dependency-free helpers shared by the gateway modules.
 *
 * @module dsh-gateway-mobile/lib/util
 */

import crypto from 'node:crypto'
import path from 'node:path'
import type { IncomingMessage } from 'node:http'

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

/** Random integer in [0, max). */
export function randomInt(max: number): number {
  return crypto.randomInt(max)
}

/**
 * Generate a human-friendly code from an unambiguous alphabet.
 */
export function randomCode(length = 8, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += alphabet[randomInt(alphabet.length)]
  return out
}

/** Normalize a pairing code: uppercase, strip separators. */
export function normalizePairingCode(value: unknown): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Format a code as XXXX-XXXX for display. */
export function formatPairingCode(code: unknown): string {
  const clean = normalizePairingCode(code)
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function hmacSha256(secret: string, data: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url')
}

/** Constant-time string comparison that never throws on length mismatch. */
export function timingSafeEqualString(a: unknown, b: unknown): boolean {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')
  if (left.length !== right.length) {
    // Still hash to keep the timing profile close; result is false.
    const digest = (buf: Buffer): Buffer => crypto.createHash('sha256').update(buf).digest()
    return crypto.timingSafeEqual(digest(left), digest(right)) && false
  }
  return crypto.timingSafeEqual(left, right)
}

export function base64urlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

export function base64urlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8')
}

/** Parse a Cookie header into a plain object. */
export function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  if (!header) return out
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (!key) continue
    out[key] = value
  }
  return out
}

export interface CookieOptions {
  maxAge?: number
  path?: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

/**
 * Serialize one Set-Cookie header. `secure` is the caller's responsibility.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${value}`]
  parts.push(`Path=${options.path ?? '/'}`)
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`)
  if (options.httpOnly !== false) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  parts.push(`SameSite=${options.sameSite ?? 'Strict'}`)
  return parts.join('; ')
}

/** Escape text for HTML insertion. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Strip ANSI escape sequences (cloudflared colour output). */
export function stripAnsi(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')
}

export function requestIp(req: IncomingMessage, trustProxy = true): string {
  if (trustProxy) {
    const cf = req.headers['cf-connecting-ip']
    if (typeof cf === 'string' && cf) return (cf.split(',')[0] ?? '').trim()
    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && forwarded) return (forwarded.split(',')[0] ?? '').trim()
  }
  return req.socket?.remoteAddress ?? ''
}

export function userAgent(req: IncomingMessage): string {
  return String(req.headers['user-agent'] ?? '').slice(0, 512)
}

/** Turn a browser User-Agent into a short, human-readable device label. */
export function describeDevice(userAgentValue: unknown): string {
  const ua = String(userAgentValue ?? '')
  const os = /iPhone|iPad|iPod/i.test(ua)
    ? 'iOS'
    : /Android/i.test(ua)
      ? 'Android'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Macintosh|Mac OS X/i.test(ua)
          ? 'macOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : ''
  const browser = /Edg\//i.test(ua)
    ? 'Edge'
    : /OPR\//i.test(ua)
      ? 'Opera'
      : /Chrome\//i.test(ua)
        ? 'Chrome'
        : /Firefox\//i.test(ua)
          ? 'Firefox'
          : /Safari\//i.test(ua)
            ? 'Safari'
            : ''
  if (os && browser) return `${os} · ${browser}`
  return browser || os || 'Mobile device'
}

/** Prefer a user-set device name; fall back to a friendly UA label. */
export function deviceDisplayName(name: string | undefined, userAgentValue: string | undefined): string {
  const trimmed = String(name ?? '').trim()
  if (trimmed && !/^Mozilla\//i.test(trimmed) && trimmed !== userAgentValue) return trimmed
  return describeDevice(userAgentValue) || trimmed || 'Mobile device'
}

/** Short hash of UA for rate-limit keys. */
export function userAgentHash(req: IncomingMessage): string {
  return sha256Hex(userAgent(req)).slice(0, 16)
}

/** True for IPv4/IPv6 loopback literals (including mapped forms). */
export function isLoopbackAddress(address?: string): boolean {
  const value = String(address ?? '').toLowerCase()
  return (
    value === '127.0.0.1' ||
    value === '::1' ||
    value === '::ffff:127.0.0.1' ||
    value.startsWith('127.') ||
    value === 'localhost'
  )
}

/** True when the request came through Apache/Cloudflare-style proxy headers. */
export function isProxiedRequest(req: IncomingMessage): boolean {
  return Boolean(
    req.headers['cf-connecting-ip'] ||
      req.headers['cf-ray'] ||
      req.headers['x-forwarded-host'] ||
      (typeof req.headers['x-forwarded-for'] === 'string' && req.headers['x-forwarded-for'].length > 0),
  )
}

export function requestProtocol(req: IncomingMessage, trustProxy = true): string {
  if (trustProxy) {
    const proto = req.headers['x-forwarded-proto']
    if (typeof proto === 'string' && proto) return (proto.split(',')[0] ?? '').trim().toLowerCase()
  }
  return (req.socket as { encrypted?: boolean } | undefined)?.encrypted ? 'https' : 'http'
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

export function mimeType(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/** JSON parse that returns a fallback instead of throwing. */
export function safeJsonParse<T>(text: string, fallback: T | null = null): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/** Format an Error for logs without leaking obvious secrets. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Build a public URL without a trailing slash. */
export function trimTrailingSlash(url: string): string {
  return String(url).replace(/\/+$/, '')
}

/** Validate a relative redirect path and return it, or a safe fallback. */
export function safeNextPath(next: unknown, fallback = '/'): string {
  if (typeof next !== 'string') return fallback
  if (!next.startsWith('/') || next.startsWith('//')) return fallback
  return next
}
