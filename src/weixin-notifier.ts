/**
 * Cross-session WeChat completion notifier.
 *
 * Watches every top-level DSH session (all workspaces), follows its durable
 * event stream, and forwards completed assistant turns to the bound WeChat
 * conversation. Notification delivery is policy-controlled: a 5s merge window,
 * per-session and global cooldowns, and a hard hourly cap.
 *
 * @module dsh-gateway-mobile/lib/weixin-notifier
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from './logger.js'
import type { WeixinChannel } from './weixin.js'
import type { SessionControllerLike } from './weixin-bridge.js'

export interface WeixinNotifyConfig {
  enabled: boolean
  debounceMs: number
  perSessionIntervalMs: number
  globalIntervalMs: number
  maxPerHour: number
}

interface NotifyOptions {
  channel: WeixinChannel
  controller: SessionControllerLike | undefined
  config: WeixinNotifyConfig
  logger: Logger
  dataDir: string
  excludeSessionId?: () => string | undefined
}

interface SessionSummaryLike {
  sessionId: string
  cwd?: string
  parentSessionId?: string
  origin?: string
  running?: boolean
  updatedAt?: number
}

interface NotificationItem {
  sessionId: string
  cwd: string
  text: string
  at: number
}

interface PendingFile {
  version: 1
  items: NotificationItem[]
}

export interface WeixinNotifyHistoryEntry {
  at: number
  count: number
  text: string
}

export interface WeixinNotifyPolicy {
  debounceMs: number
  perSessionIntervalMs: number
  globalIntervalMs: number
  maxPerHour: number
}

export interface WeixinNotifyStatus extends WeixinNotifyPolicy {
  enabled: boolean
  recent: WeixinNotifyHistoryEntry[]
}

interface StateFile {
  version: 1
  enabled: boolean
  history: WeixinNotifyHistoryEntry[]
  policy?: WeixinNotifyPolicy
}

interface Watcher {
  abort: AbortController
  task: Promise<void>
}

const LIST_INTERVAL_MS = 5_000
const RETRY_MS = 30_000
const MAX_PENDING = 50
const MAX_WATCHERS = 20
const RECENT_SESSION_MS = 60_000
const HISTORY_LIMIT = 50

export class WeixinNotifier {
  private readonly channel: WeixinChannel
  private readonly controller: SessionControllerLike | undefined
  private readonly config: WeixinNotifyConfig
  private readonly logger: Logger
  private readonly file: string
  private readonly stateFile: string
  private readonly excludeSessionId: (() => string | undefined) | undefined
  private readonly watchers = new Map<string, Watcher>()
  private readonly pending: NotificationItem[] = []
  private readonly sessionCooldown = new Map<string, number>()
  private readonly sentTimes: number[] = []
  private readonly history: WeixinNotifyHistoryEntry[] = []
  private listTimer: ReturnType<typeof setInterval> | undefined
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private lastSentAt = 0
  private running = false
  private enabled = false
  private stateLoaded = false
  private flushing = false

  constructor(options: NotifyOptions) {
    this.channel = options.channel
    this.controller = options.controller
    this.config = options.config
    this.logger = options.logger
    this.file = path.join(options.dataDir, 'weixin-notify-pending.json')
    this.stateFile = path.join(options.dataDir, 'weixin-notify-state.json')
    this.excludeSessionId = options.excludeSessionId
  }

  async start(): Promise<void> {
    await this.loadState()
    await this.loadPending()
    this.enabled = this.stateLoaded ? this.enabled : this.config.enabled
    if (this.enabled) this.startLoops()
  }

  status(): WeixinNotifyStatus {
    return {
      enabled: this.enabled,
      debounceMs: this.config.debounceMs,
      perSessionIntervalMs: this.config.perSessionIntervalMs,
      globalIntervalMs: this.config.globalIntervalMs,
      maxPerHour: this.config.maxPerHour,
      recent: this.history.slice(0, HISTORY_LIMIT),
    }
  }

  async setEnabled(enabled: boolean): Promise<WeixinNotifyStatus> {
    this.enabled = enabled
    if (enabled) this.startLoops()
    else this.stopLoops()
    await this.saveState()
    this.logger.audit({ action: 'weixin.notify.toggle', enabled })
    return this.status()
  }

  async setPolicy(patch: Partial<WeixinNotifyPolicy>): Promise<WeixinNotifyStatus> {
    const next: WeixinNotifyPolicy = {
      debounceMs: patch.debounceMs ?? this.config.debounceMs,
      perSessionIntervalMs: patch.perSessionIntervalMs ?? this.config.perSessionIntervalMs,
      globalIntervalMs: patch.globalIntervalMs ?? this.config.globalIntervalMs,
      maxPerHour: patch.maxPerHour ?? this.config.maxPerHour,
    }
    assertPolicy(next)
    Object.assign(this.config, next)
    await this.saveState()
    this.logger.audit({ action: 'weixin.notify.policy', ...next })
    return this.status()
  }

  stop(): void {
    this.stopLoops()
    void this.saveState().catch(() => {})
    void this.savePending().catch(() => {})
  }

  private startLoops(): void {
    if (!this.controller || this.running) return
    this.running = true
    this.listTimer = setInterval(() => void this.scan(), LIST_INTERVAL_MS)
    void this.scan()
    this.scheduleFlush(this.config.debounceMs)
    this.logger.info('WeChat cross-session notifier started')
  }

  private stopLoops(): void {
    this.running = false
    if (this.listTimer) clearInterval(this.listTimer)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.listTimer = undefined
    this.flushTimer = undefined
    this.retryTimer = undefined
    for (const watcher of this.watchers.values()) watcher.abort.abort()
    this.watchers.clear()
  }

  private async scan(): Promise<void> {
    const controller = this.controller
    if (!this.running || !controller) return
    if (!this.channel.connected || !this.channel.lastInbound) {
      for (const watcher of this.watchers.values()) watcher.abort.abort()
      this.watchers.clear()
      return
    }
    try {
      const result = await controller.list({}, AbortSignal.timeout(5_000))
      const seen = new Set<string>()
      for (const item of result.items as SessionSummaryLike[]) {
        if (!this.shouldWatch(item)) continue
        seen.add(item.sessionId)
        if (this.watchers.has(item.sessionId)) continue
        if (this.watchers.size >= MAX_WATCHERS) {
          this.logger.debug(`WeChat notifier watcher cap reached (${MAX_WATCHERS}); skipping ${item.sessionId}`)
          continue
        }
        this.watch(item)
      }
      for (const [sessionId, watcher] of this.watchers) {
        if (seen.has(sessionId)) continue
        watcher.abort.abort()
        this.watchers.delete(sessionId)
      }
    } catch (error) {
      this.logger.debug(`WeChat notifier session list failed: ${errorMessage(error)}`)
    }
  }

  private shouldWatch(item: SessionSummaryLike): boolean {
    if (item.parentSessionId || item.origin === 'subagent') return false
    if (item.sessionId === this.excludeSessionId?.()) return false
    // Only live sessions or sessions updated moments ago. Following every cold
    // historical session would retain a full snapshot per session and can
    // exhaust the Node heap on a long-lived gateway.
    if (item.running === true) return true
    return typeof item.updatedAt === 'number' && Date.now() - item.updatedAt < RECENT_SESSION_MS
  }

  private watch(item: SessionSummaryLike): void {
    const controller = this.controller
    if (!controller || !this.running) return
    const abort = new AbortController()
    const task = this.consume(item, abort.signal)
      .catch((error: unknown) => {
        if (!abort.signal.aborted) this.logger.debug(`WeChat notifier watcher stopped: ${errorMessage(error)}`)
      })
      .finally(() => {
        const current = this.watchers.get(item.sessionId)
        if (current?.abort === abort) this.watchers.delete(item.sessionId)
      })
    this.watchers.set(item.sessionId, { abort, task })
  }

  private async consume(item: SessionSummaryLike, signal: AbortSignal): Promise<void> {
    const controller = this.controller
    if (!controller) return
    const stream = controller.follow({ address: { kind: 'session', sessionId: item.sessionId } }, signal)
    let startSeq = 0
    let finalText = ''
    for await (const raw of stream) {
      if (signal.aborted) return
      if (!isRecord(raw)) continue
      if (raw.type === 'snapshot') {
        startSeq = typeof raw.cursor === 'number' ? raw.cursor : 0
        continue
      }
      if (raw.type !== 'event' || !isRecord(raw.event)) continue
      const event = raw.event
      if (typeof event.seq === 'number' && event.seq <= startSeq) continue
      if (event.type === 'assistant/message') {
        const text = assistantText(event.data)
        if (text) finalText = text
        continue
      }
      if (event.type === 'turn/end') {
        const reason = turnReason(event.data)
        if (!cancelled(reason) && finalText) {
          this.enqueue({ sessionId: item.sessionId, cwd: item.cwd ?? '', text: finalText, at: Date.now() })
        }
        finalText = ''
      }
    }
  }

  private enqueue(item: NotificationItem): void {
    if (!this.running) return
    if (this.pending.length >= MAX_PENDING) this.pending.shift()
    this.pending.push(item)
    this.scheduleFlush(this.config.debounceMs)
  }

  private scheduleFlush(delay: number): void {
    if (!this.running || this.flushing) return
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush()
    }, Math.max(0, delay))
  }

  private async flush(): Promise<void> {
    if (!this.running || this.flushing || this.pending.length === 0) return
    const now = Date.now()
    const limitRemaining = this.hourLimitRemaining(now)
    if (limitRemaining <= 0) {
      this.scheduleFlush(this.nextHourDelay(now))
      return
    }
    if (now - this.lastSentAt < this.config.globalIntervalMs) {
      this.scheduleFlush(this.config.globalIntervalMs - (now - this.lastSentAt))
      return
    }

    const ready: NotificationItem[] = []
    let nextCooldown = Number.POSITIVE_INFINITY
    for (const item of this.pending.splice(0)) {
      const last = this.sessionCooldown.get(item.sessionId) ?? 0
      const wait = this.config.perSessionIntervalMs - (now - last)
      if (wait > 0) {
        nextCooldown = Math.min(nextCooldown, wait)
        this.pending.push(item)
        continue
      }
      ready.push(item)
    }
    if (ready.length === 0) {
      this.scheduleFlush(Number.isFinite(nextCooldown) ? nextCooldown : RETRY_MS)
      return
    }

    const bounded = ready.slice(0, Math.min(ready.length, limitRemaining))
    const overflow = ready.slice(bounded.length)
    if (overflow.length) this.pending.unshift(...overflow)
    const lastInbound = this.channel.lastInbound
    if (!lastInbound) {
      this.pending.unshift(...bounded)
      await this.savePending()
      this.scheduleFlush(RETRY_MS)
      return
    }

    this.flushing = true
    try {
      const text = this.format(bounded)
      await this.channel.sendText(lastInbound.userId, text, lastInbound.contextToken)
      this.lastSentAt = Date.now()
      this.sentTimes.push(this.lastSentAt)
      this.history.unshift({ at: this.lastSentAt, count: bounded.length, text })
      if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT
      for (const item of bounded) this.sessionCooldown.set(item.sessionId, this.lastSentAt)
      this.logger.audit({ action: 'weixin.notify', count: bounded.length })
      await Promise.all([this.savePending(), this.saveState()])
    } catch (error) {
      this.pending.unshift(...bounded)
      this.logger.warn(`WeChat notification send failed: ${errorMessage(error)}`)
      await this.savePending()
      this.scheduleFlush(RETRY_MS)
    } finally {
      this.flushing = false
    }
    if (this.pending.length) this.scheduleFlush(this.config.debounceMs)
  }

  private format(items: NotificationItem[]): string {
    if (items.length === 1) {
      const item = items[0]
      if (!item) return ''
      return [
        '✅ DSH 任务完成',
        `工作区：${workspaceName(item.cwd)}`,
        `会话：${shortId(item.sessionId)}`,
        `摘要：${summary(item.text)}`,
      ].join('\n')
    }
    const lines = [`✅ ${items.length} 个 DSH 任务已完成`]
    for (const [index, item] of items.entries()) {
      lines.push(`${index + 1}. ${workspaceName(item.cwd)} · ${shortId(item.sessionId)}`)
      lines.push(`   ${summary(item.text)}`)
    }
    return lines.join('\n')
  }

  private hourLimitRemaining(now: number): number {
    const cutoff = now - 3_600_000
    while (this.sentTimes.length && (this.sentTimes[0] ?? Number.POSITIVE_INFINITY) < cutoff) this.sentTimes.shift()
    return Math.max(0, this.config.maxPerHour - this.sentTimes.length)
  }

  private nextHourDelay(now: number): number {
    const oldest = this.sentTimes[0]
    return oldest ? Math.max(1000, oldest + 3_600_000 - now + 1000) : 60_000
  }

  private async loadState(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.stateFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StateFile>
      if (parsed.version !== 1 || typeof parsed.enabled !== 'boolean') return
      this.enabled = parsed.enabled
      if (Array.isArray(parsed.history)) {
        for (const entry of parsed.history) {
          if (isHistoryEntry(entry)) this.history.push(entry)
        }
      }
      if (parsed.policy && isNotifyPolicy(parsed.policy)) {
        Object.assign(this.config, parsed.policy)
      }
      this.stateLoaded = true
    } catch {
      // No saved admin preference yet: use the profile default.
    }
  }

  private async saveState(): Promise<void> {
    const value: StateFile = {
      version: 1,
      enabled: this.enabled,
      history: this.history.slice(0, HISTORY_LIMIT),
      policy: {
        debounceMs: this.config.debounceMs,
        perSessionIntervalMs: this.config.perSessionIntervalMs,
        globalIntervalMs: this.config.globalIntervalMs,
        maxPerHour: this.config.maxPerHour,
      },
    }
    await fsp.mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 })
    await fsp.writeFile(this.stateFile, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  private async loadPending(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PendingFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.items)) return
      for (const item of parsed.items) {
        if (isNotification(item)) this.pending.push(item)
      }
    } catch {
      // First run or a discarded/corrupt file: start empty.
    }
  }

  private async savePending(): Promise<void> {
    if (this.pending.length === 0) {
      await fsp.rm(this.file, { force: true }).catch(() => {})
      return
    }
    const value: PendingFile = { version: 1, items: this.pending.slice(-MAX_PENDING) }
    await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    await fsp.writeFile(this.file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNotification(value: unknown): value is NotificationItem {
  if (!isRecord(value)) return false
  return (
    typeof value.sessionId === 'string' &&
    typeof value.cwd === 'string' &&
    typeof value.text === 'string' &&
    typeof value.at === 'number'
  )
}

function assertPolicy(policy: WeixinNotifyPolicy): void {
  if (!Number.isInteger(policy.debounceMs) || policy.debounceMs < 3000 || policy.debounceMs > 30_000) {
    throw new Error('debounceMs must be an integer between 3000 and 30000')
  }
  if (
    !Number.isInteger(policy.perSessionIntervalMs) ||
    policy.perSessionIntervalMs < 10_000 ||
    policy.perSessionIntervalMs > 300_000
  ) {
    throw new Error('perSessionIntervalMs must be an integer between 10000 and 300000')
  }
  if (
    !Number.isInteger(policy.globalIntervalMs) ||
    policy.globalIntervalMs < 5000 ||
    policy.globalIntervalMs > 120_000
  ) {
    throw new Error('globalIntervalMs must be an integer between 5000 and 120000')
  }
  if (!Number.isInteger(policy.maxPerHour) || policy.maxPerHour < 5 || policy.maxPerHour > 100) {
    throw new Error('maxPerHour must be an integer between 5 and 100')
  }
}

function isNotifyPolicy(value: unknown): value is WeixinNotifyPolicy {
  if (!isRecord(value)) return false
  try {
    assertPolicy(value as unknown as WeixinNotifyPolicy)
    return true
  } catch {
    return false
  }
}

function isHistoryEntry(value: unknown): value is WeixinNotifyHistoryEntry {
  return (
    isRecord(value) &&
    typeof value.at === 'number' &&
    typeof value.count === 'number' &&
    typeof value.text === 'string'
  )
}

function assistantText(data: unknown): string {
  if (!isRecord(data) || !isRecord(data.message) || !Array.isArray(data.message.content)) return ''
  return data.message.content
    .map((block) => {
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return ''
      return block.text
    })
    .join('')
    .trim()
}

function turnReason(data: unknown): unknown {
  return isRecord(data) ? data.reason : undefined
}

function cancelled(reason: unknown): boolean {
  if (typeof reason === 'string') return /cancel|abort|interrupt/i.test(reason)
  if (isRecord(reason)) {
    const kind = reason.kind
    return typeof kind === 'string' && /cancel|abort|interrupt|user/i.test(kind)
  }
  return false
}

function summary(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 500 ? `${normalized.slice(0, 497)}...` : normalized
}

function workspaceName(cwd: string): string {
  if (!cwd) return '(unknown)'
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.at(-1) ?? cwd
}

function shortId(sessionId: string): string {
  return sessionId.length > 16 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-6)}` : sessionId
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
