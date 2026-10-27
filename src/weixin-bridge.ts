/**
 * Bridge between the WeChat iLink channel and a dedicated DSH session.
 *
 * Phase 2: serialized text turns. A WeChat message is admitted as one DSH
 * prompt; the bridge follows the durable session event stream until `turn/end`
 * and sends the last committed assistant text back to the same conversation.
 *
 * Approval routing and image attachments are layered on later.
 *
 * @module dsh-gateway-mobile/lib/weixin-bridge
 */

import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from './logger.js'
import type { WeixinChannel, WeixinInbound, WeixinInboundImage } from './weixin.js'

type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: WeixinInboundImage['mediaType']; data: string; name?: string }

export interface SessionControllerLike {
  create(request: { cwd?: string; workspaceId?: string; sessionId?: string }): Promise<{ sessionId: string }>
  prompt(
    request: {
      requestId: string
      sessionId: string
      mode: 'queue' | 'steer'
      content: PromptPart[]
      clientTimeZone?: string
    },
    signal: AbortSignal,
  ): Promise<unknown>
  follow(
    request: {
      address: { kind: 'session'; sessionId: string }
      assistantStream?: true
    },
    signal: AbortSignal,
  ): AsyncIterable<unknown>
  list(request: Record<string, never>, signal: AbortSignal): Promise<{
    items: Array<{
      sessionId: string
      cwd?: string
      parentSessionId?: string
      origin?: string
    }>
  }>
  rename?(request: { sessionId: string; title: string }): Promise<unknown>
}

export interface WeixinBridgeOptions {
  channel: WeixinChannel
  controller: SessionControllerLike | undefined
  events?: CordisEventSource
  logger: Logger
  dataDir: string
  resolveCwd?: () => string | undefined
  resolveWorkspaceId?: () => string | undefined
  ensureWorkspace?: (sessionId: string) => Promise<void>
  approvalMaxPerHour?: number
}

export type WeixinApprovalHistoryStatus =
  | 'pending'
  | 'allowed'
  | 'rejected'
  | 'timeout'
  | 'cancelled'
  | 'unavailable'

export interface WeixinApprovalHistoryEntry {
  at: number
  id: string
  sessionId: string
  toolName: string
  reason: string
  status: WeixinApprovalHistoryStatus
}

export interface CordisEventSource {
  on(event: string, listener: (request: unknown, next: () => Promise<WeixinApprovalOutcome>) => Promise<WeixinApprovalOutcome>): unknown
  off(event: string, listener: (request: unknown, next: () => Promise<WeixinApprovalOutcome>) => Promise<WeixinApprovalOutcome>): unknown
}

export type WeixinApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

interface PendingApproval {
  id: string
  owner: string
  contextToken: string
  resolve: (outcome: WeixinApprovalOutcome) => void
  timer: ReturnType<typeof setTimeout>
  removeAbort: () => void
}

interface ApprovalRequestLike {
  agent: unknown
  toolName: string
  reason?: string
  displayReason?: Record<string, string>
  signal?: AbortSignal
}

const TURN_TIMEOUT_MS = 180_000
const APPROVAL_TIMEOUT_MS = 120_000
const APPROVAL_ID_LENGTH = 4

interface SessionFile {
  version: 1
  sessionId: string
}

export class WeixinBridge {
  private readonly channel: WeixinChannel
  private readonly controller: SessionControllerLike | undefined
  private readonly events: CordisEventSource | undefined
  private readonly logger: Logger
  private readonly file: string
  private readonly resolveCwd: (() => string | undefined) | undefined
  private readonly resolveWorkspaceId: (() => string | undefined) | undefined
  private readonly ensureWorkspace: ((sessionId: string) => Promise<void>) | undefined
  private readonly approvalMaxPerHour: number
  private readonly approvalHistoryFile: string
  private readonly approvalHistory: WeixinApprovalHistoryEntry[] = []
  private readonly approvalSentTimes: number[] = []
  private sessionId = ''
  private lastUserId = ''
  private queue: Promise<void> = Promise.resolve()
  private pendingApproval: PendingApproval | null = null
  private approvalListener:
    | ((request: unknown, next: () => Promise<WeixinApprovalOutcome>) => Promise<WeixinApprovalOutcome>)
    | undefined

  constructor(options: WeixinBridgeOptions) {
    this.channel = options.channel
    this.controller = options.controller
    this.events = options.events
    this.logger = options.logger
    this.file = path.join(options.dataDir, 'weixin-session.json')
    this.resolveCwd = options.resolveCwd
    this.resolveWorkspaceId = options.resolveWorkspaceId
    this.ensureWorkspace = options.ensureWorkspace
    this.approvalMaxPerHour = options.approvalMaxPerHour ?? 60
    this.approvalHistoryFile = path.join(options.dataDir, 'weixin-approval-history.json')
  }

  async start(): Promise<void> {
    await this.loadApprovalHistory()
    this.channel.onMessage = (message) => {
      // Approval replies must bypass the turn queue; the queued DSH turn is blocked
      // waiting for this decision.
      if (this.handleApprovalReply(message)) return
      this.enqueue(message)
    }
    this.channel.onCredentialsChanged = () => {
      void this.resetSession().catch((error: unknown) => {
        this.logger.warn(`WeChat session reset failed: ${errorMessage(error)}`)
      })
    }
    this.sessionId = await this.readSessionId()
    if (this.sessionId && this.ensureWorkspace) {
      try {
        await this.ensureWorkspace(this.sessionId)
      } catch (error) {
        this.logger.warn(`Could not attach WeChat session to workspace; starting a fresh session: ${errorMessage(error)}`)
        await this.resetSession().catch(() => {})
      }
    }
    if (this.events) {
      this.approvalListener = (request, next) => this.handleApproval(request, next)
      this.events.on('approval/request', this.approvalListener)
    }
    if (this.controller) {
      this.logger.info(`WeChat DSH bridge ready (${this.sessionId || 'new session'})`)
    } else {
      this.logger.warn('WeChat DSH bridge disabled: sessionController service is unavailable')
    }
  }

  get currentSessionId(): string {
    return this.sessionId
  }

  approvalHistorySnapshot(): WeixinApprovalHistoryEntry[] {
    return this.approvalHistory.slice(0, 50)
  }

  stop(): void {
    this.channel.onMessage = undefined
    this.channel.onCredentialsChanged = undefined
    if (this.events && this.approvalListener) {
      this.events.off('approval/request', this.approvalListener)
    }
    this.approvalListener = undefined
    this.resolveApproval('cancelled', false)
  }

  /** Called when the bound WeChat account logs out or is replaced. */
  async resetSession(): Promise<void> {
    this.resolveApproval('cancelled', false)
    this.sessionId = ''
    await fsp.rm(this.file, { force: true })
    this.logger.info('WeChat DSH session reset; next message creates a new session')
  }

  private enqueue(message: WeixinInbound): void {
    this.queue = this.queue
      .then(() => this.handle(message))
      .catch((error: unknown) => {
        this.logger.error(`WeChat bridge turn failed: ${errorMessage(error)}`)
      })
  }

  private async handle(message: WeixinInbound): Promise<void> {
    this.lastUserId = message.userId
    if (this.handleApprovalReply(message)) return
    if (!this.controller) {
      this.logger.warn('WeChat message received but DSH bridge is unavailable')
      return
    }
    try {
      const reply = await this.ask(message.text, message.images ?? [])
      await this.channel.sendText(message.userId, reply || '(DSH 没有返回文本回答)', message.contextToken)
    } catch (error) {
      this.logger.warn(`WeChat DSH turn failed: ${errorMessage(error)}`)
      await this.channel
        .sendText(message.userId, `处理失败：${errorMessage(error)}`, message.contextToken)
        .catch(() => {})
    }
  }

  private async handleApproval(
    request: unknown,
    next: () => Promise<WeixinApprovalOutcome>,
  ): Promise<WeixinApprovalOutcome> {
    const req = approvalRequestOf(request)
    if (!req) return next()
    const owner = this.lastUserId || this.channel.lastInbound?.userId
    const contextToken = owner
      ? this.channel.contextFor(owner) ?? this.channel.lastInbound?.contextToken
      : undefined
    if (!owner || !contextToken) return 'unavailable'
    if (this.pendingApproval) {
      this.logger.warn('Another WeChat approval is already pending; failing closed')
      return 'unavailable'
    }

    const now = Date.now()
    const cutoff = now - 3_600_000
    while (this.approvalSentTimes.length && (this.approvalSentTimes[0] ?? Number.POSITIVE_INFINITY) < cutoff) {
      this.approvalSentTimes.shift()
    }
    if (this.approvalSentTimes.length >= this.approvalMaxPerHour) {
      this.logger.warn(`WeChat approval quota reached (${this.approvalMaxPerHour}/hour); failing closed`)
      return 'unavailable'
    }

    const sessionId = agentSessionId(req.agent) ?? ''
    const id = approvalId()
    const reason = req.displayReason?.zh || req.displayReason?.en || req.reason || '工具请求执行'
    const text = [
      `⚠️ 需要审批 #${id}`,
      `会话：${shortSessionId(sessionId)}`,
      `工具：${req.toolName}`,
      `原因：${reason.slice(0, 400)}`,
      '',
      `回复：允许 ${id}`,
      `或：拒绝 ${id}`,
    ].join('\n')

    const entry: WeixinApprovalHistoryEntry = {
      at: now,
      id,
      sessionId,
      toolName: req.toolName,
      reason: reason.slice(0, 300),
      status: 'pending',
    }
    this.approvalHistory.unshift(entry)
    if (this.approvalHistory.length > 50) this.approvalHistory.length = 50

    try {
      await this.channel.sendText(owner, text, contextToken)
      this.approvalSentTimes.push(now)
      this.logger.audit({ action: 'weixin.approval.sent', id })
      await this.saveApprovalHistory()
    } catch (error) {
      this.logger.warn(`Failed to send WeChat approval prompt: ${errorMessage(error)}`)
      entry.status = 'unavailable'
      await this.saveApprovalHistory()
      return 'unavailable'
    }

    return new Promise<WeixinApprovalOutcome>((resolve) => {
      const finish = (outcome: WeixinApprovalOutcome, status: WeixinApprovalHistoryStatus): void => {
        const pending = this.pendingApproval
        if (!pending) return
        clearTimeout(pending.timer)
        pending.removeAbort()
        this.pendingApproval = null
        entry.status = status
        void this.saveApprovalHistory()
        pending.resolve(outcome)
      }
      const timer = setTimeout(() => {
        finish('rejected', 'timeout')
        void this.channel.sendText(owner, `审批 #${id} 已超时，已自动拒绝。`, contextToken).catch(() => {})
      }, APPROVAL_TIMEOUT_MS)
      const onAbort = (): void => finish('cancelled', 'cancelled')
      req.signal?.addEventListener('abort', onAbort, { once: true })
      this.pendingApproval = {
        id,
        owner,
        contextToken,
        timer,
        removeAbort: () => req.signal?.removeEventListener('abort', onAbort),
        resolve: (outcome) => resolve(outcome),
      }
    })
  }

  private handleApprovalReply(message: WeixinInbound): boolean {
    const pending = this.pendingApproval
    if (!pending) return false
    const text = message.text.trim()
    const id = escapeRegExp(pending.id)
    if (new RegExp(`^(允许|同意|approve)\\s*#?${id}$`, 'i').test(text)) {
      this.finishApproval('allowed-once')
      void this.channel.sendText(pending.owner, `已允许 #${pending.id}，继续执行。`, message.contextToken).catch(() => {})
      return true
    }
    if (new RegExp(`^(拒绝|deny|reject)\\s*#?${id}$`, 'i').test(text)) {
      this.finishApproval('rejected')
      void this.channel.sendText(pending.owner, `已拒绝 #${pending.id}。`, message.contextToken).catch(() => {})
      return true
    }
    if (/^(允许|同意|拒绝|approve|deny|reject)/i.test(text)) {
      void this.channel
        .sendText(message.userId, `审批编号不匹配，请回复：允许 ${pending.id} 或 拒绝 ${pending.id}`, message.contextToken)
        .catch(() => {})
      return true
    }
    return false
  }

  private finishApproval(outcome: WeixinApprovalOutcome): void {
    const pending = this.pendingApproval
    if (!pending) return
    clearTimeout(pending.timer)
    pending.removeAbort()
    this.pendingApproval = null
    const status: WeixinApprovalHistoryStatus =
      outcome === 'allowed-once'
        ? 'allowed'
        : outcome === 'rejected'
          ? 'rejected'
          : outcome === 'cancelled'
            ? 'cancelled'
            : 'unavailable'
    this.setApprovalStatus(pending.id, status)
    pending.resolve(outcome)
    this.logger.audit({ action: 'weixin.approval', id: pending.id, outcome })
  }

  private resolveApproval(outcome: WeixinApprovalOutcome, notify: boolean): void {
    const pending = this.pendingApproval
    if (!pending) return
    if (notify) void this.channel.sendText(pending.owner, `审批 #${pending.id} 已取消。`, pending.contextToken).catch(() => {})
    this.finishApproval(outcome)
  }

  private setApprovalStatus(id: string, status: WeixinApprovalHistoryStatus): void {
    const entry = this.approvalHistory.find((item) => item.id === id)
    if (!entry) return
    entry.status = status
    void this.saveApprovalHistory()
  }

  private async loadApprovalHistory(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.approvalHistoryFile, 'utf8')
      const parsed = JSON.parse(raw) as { version?: number; items?: unknown }
      if (parsed.version !== 1 || !Array.isArray(parsed.items)) return
      for (const item of parsed.items) {
        if (isApprovalHistoryEntry(item)) this.approvalHistory.push(item)
      }
      this.approvalHistory.sort((a, b) => b.at - a.at)
      if (this.approvalHistory.length > 50) this.approvalHistory.length = 50
    } catch {
      // No approval history yet.
    }
  }

  private async saveApprovalHistory(): Promise<void> {
    const value = { version: 1, items: this.approvalHistory.slice(0, 50) }
    await fsp.mkdir(path.dirname(this.approvalHistoryFile), { recursive: true, mode: 0o700 })
    await fsp.writeFile(this.approvalHistoryFile, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  }

  private async ask(text: string, images: WeixinInboundImage[] = []): Promise<string> {
    const controller = this.controller
    if (!controller) throw new Error('DSH session controller is unavailable')
    const sessionId = await this.ensureSession()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(new Error('DSH turn timed out')), TURN_TIMEOUT_MS)
    try {
      const content: PromptPart[] = []
      if (text.trim()) content.push({ type: 'text', text })
      else if (images.length > 0) content.push({ type: 'text', text: '[微信图片]' })
      for (const image of images) {
        content.push({
          type: 'image',
          mediaType: image.mediaType,
          data: image.data,
          ...(image.name ? { name: image.name } : {}),
        })
      }
      if (content.length === 0) throw new Error('WeChat message has no content')
      const stream = controller.follow(
        { address: { kind: 'session', sessionId }, assistantStream: true },
        abort.signal,
      )
      const iterator = stream[Symbol.asyncIterator]()
      const opening = await iterator.next()
      const openingFrame = isRecord(opening.value) ? opening.value : {}
      const startSeq = typeof openingFrame.cursor === 'number' ? openingFrame.cursor : 0
      await controller.prompt(
        {
          requestId: crypto.randomUUID(),
          sessionId,
          mode: 'queue',
          content,
        },
        abort.signal,
      )
      let answer = ''
      while (!abort.signal.aborted) {
        const next = await iterator.next()
        if (next.done) break
        const frame = next.value
        if (!isRecord(frame) || frame.type !== 'event' || !isRecord(frame.event)) continue
        const event = frame.event
        if (typeof event.seq === 'number' && event.seq <= startSeq) continue
        if (event.type === 'assistant/message') {
          const candidate = assistantText(event.data)
          if (candidate) answer = candidate
        }
        if (event.type === 'turn/end') break
      }
      return answer
    } finally {
      clearTimeout(timer)
      abort.abort()
    }
  }

  private async ensureSession(): Promise<string> {
    const controller = this.controller
    if (!controller) throw new Error('DSH session controller is unavailable')
    if (this.sessionId) return this.sessionId
    const workspaceId = this.resolveWorkspaceId?.()
    const cwd = this.resolveCwd?.() || process.cwd()
    const created = workspaceId
      ? await controller.create({ workspaceId })
      : await controller.create({ cwd })
    this.sessionId = created.sessionId
    await this.writeSessionId(this.sessionId)
    if (this.ensureWorkspace) await this.ensureWorkspace(this.sessionId)
    if (this.controller?.rename) {
      await this.controller
        .rename({ sessionId: this.sessionId, title: `微信会话 ${new Date().toLocaleString('zh-CN')}` })
        .catch(() => {})
    }
    this.logger.info(`Created WeChat DSH session ${this.sessionId} in ${workspaceId ? `workspace ${workspaceId}` : cwd}`)
    return this.sessionId
  }

  private async readSessionId(): Promise<string> {
    try {
      const raw = await fsp.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<SessionFile>
      return parsed.version === 1 && typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
    } catch {
      return ''
    }
  }

  private async writeSessionId(sessionId: string): Promise<void> {
    const value: SessionFile = { version: 1, sessionId }
    await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    await fsp.writeFile(this.file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
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

function isApprovalHistoryEntry(value: unknown): value is WeixinApprovalHistoryEntry {
  if (!isRecord(value)) return false
  return (
    typeof value.at === 'number' &&
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.toolName === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.status === 'string'
  )
}

function shortSessionId(sessionId: string): string {
  if (!sessionId) return '(unknown)'
  return sessionId.length > 18 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-6)}` : sessionId
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function approvalRequestOf(value: unknown): ApprovalRequestLike | null {
  if (!isRecord(value) || typeof value.toolName !== 'string') return null
  const signal = value.signal
  return {
    agent: value.agent,
    toolName: value.toolName,
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(isStringRecord(value.displayReason) ? { displayReason: value.displayReason } : {}),
    ...(signal instanceof AbortSignal ? { signal } : {}),
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false
  return Object.values(value).every((item) => typeof item === 'string')
}

function agentSessionId(agent: unknown): string | undefined {
  if (!isRecord(agent)) return undefined
  const session = agent.session
  if (isRecord(session) && typeof session.id === 'string') return session.id
  if (typeof agent.sessionId === 'string') return agent.sessionId
  if (typeof agent.id === 'string') return agent.id
  return undefined
}

function approvalId(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.randomBytes(APPROVAL_ID_LENGTH)
  let value = ''
  for (const byte of bytes) value += alphabet[byte % alphabet.length]
  return value
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
