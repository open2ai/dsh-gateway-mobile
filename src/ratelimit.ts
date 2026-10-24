/**
 * Sliding-window rate limiting and pairing brute-force lockout.
 *
 * @module dsh-gateway-mobile/lib/ratelimit
 */

export interface RateLimitResult {
  ok: boolean
  remaining: number
  retryAfter: number
}

/** Sliding-window limiter keyed by an opaque string. */
export class RateLimiter {
  windowMs: number
  max: number
  hits: Map<string, number[]>
  timer: ReturnType<typeof setInterval>

  constructor(options: { windowSeconds: number; max: number }) {
    this.windowMs = options.windowSeconds * 1000
    this.max = options.max
    this.hits = new Map()
    this.timer = setInterval(() => this.sweep(), Math.max(30_000, this.windowMs))
    this.timer.unref?.()
  }

  hit(key: string): RateLimitResult {
    const now = Date.now()
    const cutoff = now - this.windowMs
    const recent = (this.hits.get(key) ?? []).filter((stamp) => stamp > cutoff)
    if (recent.length >= this.max) {
      const retryAfter = Math.max(1, Math.ceil(((recent[0] ?? now) + this.windowMs - now) / 1000))
      this.hits.set(key, recent)
      return { ok: false, remaining: 0, retryAfter }
    }
    recent.push(now)
    this.hits.set(key, recent)
    return { ok: true, remaining: this.max - recent.length, retryAfter: 0 }
  }

  reset(key: string): void {
    this.hits.delete(key)
  }

  sweep(): void {
    const cutoff = Date.now() - this.windowMs
    for (const [key, stamps] of this.hits) {
      const recent = stamps.filter((stamp) => stamp > cutoff)
      if (recent.length === 0) this.hits.delete(key)
      else this.hits.set(key, recent)
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }
}

export interface LockoutResult {
  locked: boolean
  retryAfter: number
  remaining: number
}

interface LockoutEntry {
  failures: number
  lockedUntil: number
}

/** Pairing-code failure counter with a lockout window. */
export class PairingLockout {
  maxAttempts: number
  lockoutMs: number
  entries: Map<string, LockoutEntry>

  constructor(options: { maxAttempts: number; lockoutSeconds: number }) {
    this.maxAttempts = options.maxAttempts
    this.lockoutMs = options.lockoutSeconds * 1000
    this.entries = new Map()
  }

  check(key: string): LockoutResult {
    const entry = this.entries.get(key)
    if (!entry) return { locked: false, retryAfter: 0, remaining: this.maxAttempts }
    if (entry.lockedUntil > Date.now()) {
      return {
        locked: true,
        retryAfter: Math.max(1, Math.ceil((entry.lockedUntil - Date.now()) / 1000)),
        remaining: 0,
      }
    }
    if (entry.lockedUntil !== 0) {
      this.entries.delete(key)
      return { locked: false, retryAfter: 0, remaining: this.maxAttempts }
    }
    return { locked: false, retryAfter: 0, remaining: Math.max(0, this.maxAttempts - entry.failures) }
  }

  fail(key: string): LockoutResult {
    const entry = this.entries.get(key) ?? { failures: 0, lockedUntil: 0 }
    entry.failures += 1
    if (entry.failures >= this.maxAttempts) {
      entry.lockedUntil = Date.now() + this.lockoutMs
      entry.failures = 0
    }
    this.entries.set(key, entry)
    if (entry.lockedUntil > Date.now()) {
      return { locked: true, retryAfter: Math.ceil(this.lockoutMs / 1000), remaining: 0 }
    }
    return { locked: false, retryAfter: 0, remaining: Math.max(0, this.maxAttempts - entry.failures) }
  }

  success(key: string): void {
    this.entries.delete(key)
  }
}
