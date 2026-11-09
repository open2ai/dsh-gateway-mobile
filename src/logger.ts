/**
 * Gateway logger: console output, an in-memory ring for /status and /logs,
 * and an append-only audit trail.
 *
 * File writes go through a small in-memory queue that is drained on the next
 * `setImmediate` tick; `flush()` drains it synchronously so tests and shutdown
 * hooks can depend on the bytes being on disk. The JSONL file rotates at
 * `maxBytes` into `.1` .. `.N` (`.N` oldest) up to `maxFiles` generations.
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
  /** Rotate the JSONL file once it reaches this many bytes. */
  maxBytes?: number
  /** Number of rotated files to keep (`.1` is newest). */
  maxFiles?: number
}

export interface AuditQueryOptions {
  /** Case-insensitive prefix of the `action` field (or the entry message). */
  action?: string | undefined
  /** Only entries at or after this instant; epoch ms, ISO string or Date. */
  since?: number | string | Date | undefined
  /** Return at most this many of the most recent matches. */
  limit?: number | undefined
}

/** Filtered audit view: `entries` are ascending, `total` is the match count before `limit`. */
export interface AuditQueryResult {
  entries: LogEntry[]
  total: number
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_FILES = 3

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

/** Parse an audit `since` bound (epoch ms, ISO string or Date) into epoch ms. */
function sinceMs(value: AuditQueryOptions['since']): number | undefined {
  if (value === undefined) return undefined
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : undefined
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Dedupe key for merging on-disk and in-memory audit entries. */
function auditKey(entry: LogEntry): string {
  let meta = ''
  try {
    meta = JSON.stringify(entry.meta ?? null)
  } catch {
    meta = String(entry.meta)
  }
  return `${entry.timestamp}\u0000${entry.message}\u0000${meta}`
}

export class Logger {
  entries: LogEntry[]
  auditEntries: LogEntry[]
  file: string
  level: number
  maxEntries: number
  maxBytes: number
  maxFiles: number
  prefix: string
  /** Approximate current size of `file` in bytes, tracked in memory. */
  fileSize: number

  /** Pending JSONL lines, oldest first. */
  #queue: string[]
  #scheduled: boolean
  #auditCount: number

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ? LEVELS[options.level as keyof typeof LEVELS] ?? LEVELS.info : LEVELS.info
    this.maxEntries = options.maxEntries ?? 100
    this.file = options.file ?? ''
    this.prefix = options.prefix ?? 'dsh-gateway-mobile'
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES))
    this.maxFiles = Math.max(0, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES))
    this.entries = []
    this.auditEntries = []
    this.fileSize = this.#statFile()
    this.#queue = []
    this.#scheduled = false
    this.#auditCount = 0
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
    this.#auditCount += 1
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

  /**
   * Query the audit trail across restarts.
   *
   * Flushes pending writes, reads `gateway.log` plus its `.1`..`.N` rotated
   * generations, ignores malformed JSONL lines, merges the on-disk entries with
   * the in-memory ring (deduped by timestamp+message+meta), then filters by
   * `action` (case-insensitive prefix of the message), `since` and `limit`. Entries are
   * returned in ascending timestamp order; `total` is the match count before `limit`.
   * ascending timestamp order; `total` is the match count before `limit`.
   */
  async queryAudit(options: AuditQueryOptions = {}): Promise<AuditQueryResult> {
    await this.flush()
    const merged = new Map<string, LogEntry>()
    for (const entry of this.#readAuditFile()) {
      const key = auditKey(entry)
      if (!merged.has(key)) merged.set(key, entry)
    }
    for (const entry of this.auditEntries) {
      const key = auditKey(entry)
      if (!merged.has(key)) merged.set(key, entry)
    }

    let result = [...merged.values()]
    if (options.action !== undefined && options.action !== '') {
      const prefix = options.action.trim().toLowerCase()
      result = result.filter((entry) => entry.message.toLowerCase().startsWith(prefix))
    }
    const since = sinceMs(options.since)
    if (since !== undefined) {
      result = result.filter((entry) => {
        const at = Date.parse(entry.timestamp)
        return Number.isFinite(at) && at >= since
      })
    }
    result.sort((left, right) => {
      const leftAt = Date.parse(left.timestamp)
      const rightAt = Date.parse(right.timestamp)
      return (Number.isFinite(leftAt) ? leftAt : 0) - (Number.isFinite(rightAt) ? rightAt : 0)
    })

    const total = result.length
    const limit = options.limit
    if (limit !== undefined && Number.isFinite(limit) && limit > 0) {
      result = result.slice(-Math.floor(limit))
    }
    return { entries: result, total }
  }

  /** Update the console/file verbosity at runtime (admin settings). */
  setLevel(level: string): void {
    const normalized = String(level).trim().toLowerCase()
    const value = LEVELS[normalized as keyof typeof LEVELS]
    if (value === undefined) {
      throw new TypeError(`Unknown log level: ${level} (expected debug, info, warn or error)`)
    }
    this.level = value
  }

  /** Total number of audit entries recorded since this Logger was created. */
  auditTotal(): number {
    return this.#auditCount
  }

  /** Drain pending file writes so the log file reflects every recorded entry. */
  async flush(): Promise<void> {
    this.#drain()
  }

  #statFile(): number {
    if (!this.file) return 0
    try {
      return fs.statSync(this.file).size
    } catch {
      return 0
    }
  }

  /** Read audit entries from the current log and each rotated generation. */
  #readAuditFile(): LogEntry[] {
    if (!this.file) return []
    const candidates = [this.file]
    for (let index = 1; index <= this.maxFiles; index += 1) candidates.push(`${this.file}.${index}`)
    const entries: LogEntry[] = []
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue
      let text = ''
      try {
        text = fs.readFileSync(candidate, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          continue // Corrupt/partial line: ignore it.
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        const record = parsed as Record<string, unknown>
        if (typeof record.timestamp !== 'string' || typeof record.message !== 'string') continue
        // Only audit lines are part of the audit trail (written with audit:true).
        if (record.audit !== true && record.level !== 'audit') continue
        entries.push(record as LogEntry)
      }
    }
    return entries
  }

  #appendFile(entry: LogEntry): void {
    if (!this.file) return
    this.#queue.push(`${JSON.stringify(entry)}\n`)
    if (this.#scheduled) return
    this.#scheduled = true
    setImmediate(() => {
      this.#scheduled = false
      this.#drain()
    })
  }

  #drain(): void {
    if (this.#queue.length === 0) return
    const lines = this.#queue
    this.#queue = []
    let directoryReady = false
    for (const line of lines) {
      try {
        if (!directoryReady) {
          fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
          directoryReady = true
        }
        if (this.fileSize >= this.maxBytes) this.#rotate()
        fs.appendFileSync(this.file, line, { encoding: 'utf8', mode: 0o600 })
        this.fileSize += Buffer.byteLength(line)
      } catch {
        // Logging must never break a request.
      }
    }
  }

  /** Rotate `gateway.log` -> `.1` -> `.2` ... deleting beyond `maxFiles`. */
  #rotate(): void {
    if (!this.file) return
    try {
      if (this.maxFiles <= 0) {
        fs.rmSync(this.file, { force: true })
        this.fileSize = 0
        return
      }
      fs.rmSync(`${this.file}.${this.maxFiles}`, { force: true })
      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        try {
          fs.renameSync(`${this.file}.${index}`, `${this.file}.${index + 1}`)
        } catch {
          // The older generation does not exist yet.
        }
      }
      fs.renameSync(this.file, `${this.file}.1`)
    } catch {
      // A rotation failure must not stop logging; keep appending.
    }
    this.fileSize = 0
  }
}
