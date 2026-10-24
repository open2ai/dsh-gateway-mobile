/**
 * Gateway logger: console output, an in-memory ring for /status and /logs,
 * and an append-only audit trail.
 *
 * @module dsh-gateway-mobile/lib/logger
 */

import fs from 'node:fs'
import path from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'audit'

export interface LogEntry {
  timestamp: string
  level: string
  message: string
  meta?: unknown
  audit?: boolean
  [key: string]: unknown
}

export interface LoggerOptions {
  level?: string
  maxEntries?: number
  file?: string
  prefix?: string
}

const LEVELS: Readonly<Record<Exclude<LogLevel, 'audit'>, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const SECRET_KEY = /token|secret|password|authorization|cookie|code|pairing/i
const SECRET_VALUE = /^[A-Za-z0-9_.~+/=-]{16,}$/

/** Deep-redact likely secrets before logging. */
export function redact(value: unknown, key = '', depth = 0): unknown {
  if (depth > 4) return '[depth]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (SECRET_KEY.test(key) || SECRET_VALUE.test(value)) return '[redacted]'
    return value
  }
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, key, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [entryKey, entryValue] of Object.entries(value).slice(0, 30)) {
    out[entryKey] = redact(entryValue, entryKey, depth + 1)
  }
  return out
}

export class Logger {
  entries: LogEntry[]
  auditEntries: LogEntry[]
  file: string
  level: number
  maxEntries: number
  prefix: string

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ? LEVELS[options.level as keyof typeof LEVELS] ?? LEVELS.info : LEVELS.info
    this.maxEntries = options.maxEntries ?? 100
    this.file = options.file ?? ''
    this.prefix = options.prefix ?? 'dsh-gateway-mobile'
    this.entries = []
    this.auditEntries = []
  }

  enabled(level: string): boolean {
    return (LEVELS[level as keyof typeof LEVELS] ?? 0) >= this.level
  }

  log(level: Exclude<LogLevel, 'audit'>, message: string, meta?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(meta ? { meta: redact(meta) } : {}),
    }
    this.entries.push(entry)
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries)
    if (this.enabled(level)) {
      const line = `${this.prefix} ${level.toUpperCase()} ${message}`
      if (level === 'error') console.error(line, meta ? redact(meta) : '')
      else if (level === 'warn') console.warn(line, meta ? redact(meta) : '')
      else console.log(line, meta ? redact(meta) : '')
    }
    this.#appendFile(entry)
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log('debug', message, meta)
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log('info', message, meta)
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log('warn', message, meta)
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log('error', message, meta)
  }

  /** Record a security/audit event; audit entries also surface in /logs. */
  audit(event: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'audit',
      message: String(event.action ?? 'audit'),
      ...(redact(event) as Record<string, unknown>),
    }
    this.auditEntries.push(entry)
    if (this.auditEntries.length > this.maxEntries) {
      this.auditEntries.splice(0, this.auditEntries.length - this.maxEntries)
    }
    this.entries.push(entry)
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries)
    this.#appendFile({ ...entry, audit: true })
  }

  recent(limit = 50): LogEntry[] {
    return this.entries.slice(-Math.max(1, Math.min(limit, this.maxEntries)))
  }

  #appendFile(entry: LogEntry): void {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // Logging must never break a request.
    }
  }
}
