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

export type WeixinApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

interface UserQuestionAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
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
  lateAnswer?: (agent: unknown, callId: string, answer: UserQuestionAnswer) => boolean | Promise<boolean>
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
  on(event: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean }): unknown
  off(event: string, listener: (...args: any[]) => unknown): unknown
}

interface PendingApproval {
  id: string
  owner: string
  contextToken: string
  resolve: (outcome: WeixinApprovalOutcome) => void
  timer: ReturnType<typeof setTimeout>
  removeAbort: () => void
}

interface UserQuestionOptionLike {
  label: string
  description?: string
}

interface UserQuestionItemLike {
  id: string
  question: string
  detail?: string
  header?: string
  options?: UserQuestionOptionLike[]
  multiSelect?: boolean
}

interface UserQuestionRequestLike {
  questions: UserQuestionItemLike[]
  agent?: unknown
  signal?: AbortSignal
  wait?: { callId: string; timed?: boolean }
}

interface PendingUserQuestion {
  id: string
  owner: string
  contextToken: string
  items: UserQuestionItemLike[]
  answers: Array<{ id: string; selected: string[]; custom?: string }>
  index: number
  sessionId?: string
  agent?: unknown
  callId?: string
  timed: boolean
  late: boolean
  resolve: (answer: UserQuestionAnswer) => void
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
const QUESTION_TIMEOUT_MS = 300_000
const LATE_QUESTION_EXPIRY_MS = 30 * 60_000
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
  private readonly lateAnswer:
    | ((agent: unknown, callId: string, answer: UserQuestionAnswer) => boolean | Promise<boolean>)
    | undefined
  private readonly approvalHistory: WeixinApprovalHistoryEntry[] = []
  private readonly approvalSentTimes: number[] = []
  private sessionId = ''
  private lastUserId = ''
  private queue: Promise<void> = Promise.resolve()
  private pendingApproval: PendingApproval | null = null
  private pendingQuestion: PendingUserQuestion | null = null
  private approvalListener:
    | ((request: unknown, next: () => Promise<WeixinApprovalOutcome>) => Promise<WeixinApprovalOutcome>)
    | undefined
  private questionListener: ((request: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined

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
    this.lateAnswer = options.lateAnswer
  }

  async start(): Promise<void> {
    await this.loadApprovalHistory()
    this.channel.onMessage = (message) => {
      // Approval replies must bypass the turn queue; the queued DSH turn is blocked
      // waiting for this decision.
      if (this.handleApprovalReply(message)) return
      if (this.handleQuestionReply(message)) return
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
      this.events.on('approval/request', this.approvalListener, { prepend: true })
      this.questionListener = (request, next) => this.handleUserQuestion(request, next)
      this.events.on('user-questions/request', this.questionListener, { prepend: true })
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
    if (this.events && this.questionListener) {
      this.events.off('user-questions/request', this.questionListener)
    }
    this.approvalListener = undefined
    this.questionListener = undefined
    this.resolveApproval('cancelled', false)
    this.resolveQuestion(undefined)
  }

  /** Called when the bound WeChat account logs out or is replaced. */
  async resetSession(): Promise<void> {
    this.resolveApproval('cancelled', false)
    this.resolveQuestion(undefined)
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
    if (this.handleQuestionReply(message)) return
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
    if (!owner || !contextToken) {
      this.logger.warn('Cannot forward approval to WeChat: no inbound context token; delegating to web UI')
      return next()
    }
    if (this.pendingApproval || this.pendingQuestion) {
      this.logger.warn('Another WeChat interaction is already pending; delegating approval to web UI')
      return next()
    }

    const now = Date.now()
    const cutoff = now - 3_600_000
    while (this.approvalSentTimes.length && (this.approvalSentTimes[0] ?? Number.POSITIVE_INFINITY) < cutoff) {
      this.approvalSentTimes.shift()
    }
    if (this.approvalSentTimes.length >= this.approvalMaxPerHour) {
      this.logger.warn(`WeChat approval quota reached (${this.approvalMaxPerHour}/hour); delegating to web UI`)
      return next()
    }

    const sessionId = agentSessionId(req.agent) ?? ''
    const id = approvalId()
    const reason = req.displayReason?.zh || req.displayReason?.en || req.reason || '工具请求执行'
    const text = [
      '⚠️ 需要审批',
      `会话：${shortSessionId(sessionId)}`,
      `工具：${req.toolName}`,
      `原因：${reason.slice(0, 400)}`,
      '',
      '回复：Y 允许',
      '或：N 拒绝',
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
        void this.channel.sendText(owner, '审批已超时，已自动拒绝。', contextToken).catch(() => {})
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

  private async handleUserQuestion(
    request: unknown,
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    const req = userQuestionRequestOf(request)
    if (!req || req.questions.length === 0) return next()
    const owner = this.lastUserId || this.channel.lastInbound?.userId
    const contextToken = owner
      ? this.channel.contextFor(owner) ?? this.channel.lastInbound?.contextToken
      : undefined
    if (!owner || !contextToken) {
      this.logger.warn('Cannot forward user question to WeChat: no inbound context token; delegating to web UI')
      return next()
    }
    if (this.pendingApproval || this.pendingQuestion) {
      this.logger.warn('Another WeChat interaction is already pending; delegating user question to web UI')
      return next()
    }

    const id = approvalId()
    const sessionId = agentSessionId(req.agent)
    const timed = req.wait?.timed === true && typeof req.wait.callId === 'string'
    const pending: PendingUserQuestion = {
      id,
      owner,
      contextToken,
      items: req.questions,
      answers: [],
      index: 0,
      ...(sessionId ? { sessionId } : {}),
      ...(req.agent === undefined ? {} : { agent: req.agent }),
      ...(typeof req.wait?.callId === 'string' ? { callId: req.wait.callId } : {}),
      timed,
      late: false,
      timer: setTimeout(() => {}, 0),
      removeAbort: () => {},
      resolve: () => {},
    }

    try {
      await this.sendQuestionPrompt(pending)
    } catch (error) {
      this.logger.warn(`Failed to send WeChat question prompt: ${errorMessage(error)}`)
      return next()
    }
    this.logger.audit({ action: 'weixin.question.sent', id, count: req.questions.length, timed })
    this.pendingQuestion = pending

    return new Promise<unknown>((resolve, reject) => {
      const finish = (answer: UserQuestionAnswer): void => {
        const active = this.pendingQuestion
        if (!active) return
        clearTimeout(active.timer)
        active.removeAbort()
        this.pendingQuestion = null
        active.resolve(answer)
      }
      pending.resolve = (answer) => resolve(answer)
      const markLate = (): void => {
        const active = this.pendingQuestion
        if (!active || active.late) return
        clearTimeout(active.timer)
        active.late = true
        active.timer = setTimeout(() => this.expireLateQuestion(active), LATE_QUESTION_EXPIRY_MS)
        void this.channel
          .sendText(owner, '问题已超出前台等待，仍可在微信继续回答；也可以在网页补答。', contextToken)
          .catch(() => {})
      }
      pending.timer = setTimeout(() => {
        const active = this.pendingQuestion
        if (!active) return
        if (active.timed) {
          markLate()
          const reason = req.signal?.reason
          reject(reason instanceof Error ? reason : new Error('ask_user_question timed out before the user answered'))
          return
        }
        clearTimeout(active.timer)
        active.removeAbort()
        this.pendingQuestion = null
        void this.channel
          .sendText(owner, '问题已超时，交给网页继续处理。', contextToken)
          .catch(() => {})
        void Promise.resolve()
          .then(next)
          .then(resolve, () => resolve(skippedAnswers(req.questions)))
      }, QUESTION_TIMEOUT_MS)
      const onAbort = (): void => {
        if (pending.timed) {
          markLate()
          const reason = req.signal?.reason
          reject(reason instanceof Error ? reason : new Error('ask_user_question timed out before the user answered'))
          return
        }
        finish(skippedAnswers(req.questions))
      }
      pending.removeAbort = () => req.signal?.removeEventListener('abort', onAbort)
      req.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private handleQuestionReply(message: WeixinInbound): boolean {
    const pending = this.pendingQuestion
    if (!pending) return false
    const text = message.text.trim()
    if (!text) return false
    const item = pending.items[pending.index]
    if (!item) return false
    const answer = parseQuestionReply(text, item)
    if (!answer) {
      void this.channel
        .sendText(message.userId, `回复无效，请回复选项序号或文字（当前问题 ${pending.index + 1}/${pending.items.length}）。`, message.contextToken)
        .catch(() => {})
      return true
    }
    pending.answers.push(answer)
    pending.index += 1
    if (pending.index < pending.items.length) {
      void this.sendQuestionPrompt(pending).catch((error: unknown) => {
        this.logger.warn(`Failed to send next WeChat question: ${errorMessage(error)}`)
        this.resolveQuestion({
          answers: [...pending.answers, ...skippedAnswers(pending.items.slice(pending.index)).answers],
        })
      })
      return true
    }
    if (pending.late && pending.timed) {
      void this.submitLateAnswer(pending, { answers: pending.answers }, message.contextToken)
      return true
    }
    this.resolveQuestion({ answers: pending.answers })
    void this.channel
      .sendText(pending.owner, '已收到回答。', message.contextToken)
      .catch(() => {})
    this.logger.audit({ action: 'weixin.question.answered', id: pending.id, count: pending.answers.length })
    return true
  }

  private async submitLateAnswer(
    pending: PendingUserQuestion,
    answer: UserQuestionAnswer,
    contextToken: string,
  ): Promise<void> {
    let delivered = false
    if (pending.callId && pending.agent !== undefined && this.lateAnswer) {
      try {
        delivered = await this.lateAnswer(pending.agent, pending.callId, answer)
      } catch (error) {
        this.logger.warn(`Failed to submit late WeChat answer: ${errorMessage(error)}`)
      }
    }
    this.resolveQuestion(delivered ? answer : undefined)
    void this.channel
      .sendText(
        pending.owner,
        delivered ? '已回答，DSH 已收到补答。' : '问题已失效，请在网页处理。',
        contextToken,
      )
      .catch(() => {})
    this.logger.audit({ action: 'weixin.question.late-answer', id: pending.id, delivered })
  }

  private expireLateQuestion(pending: PendingUserQuestion): void {
    if (this.pendingQuestion !== pending) return
    clearTimeout(pending.timer)
    pending.removeAbort()
    this.pendingQuestion = null
    pending.resolve(skippedAnswers(pending.items))
    void this.channel
      .sendText(pending.owner, '问题已过期，请在网页处理。', pending.contextToken)
      .catch(() => {})
  }

  private async sendQuestionPrompt(pending: PendingUserQuestion): Promise<void> {
    const item = pending.items[pending.index]
    if (!item) return
    const text = questionPrompt(item, pending.index, pending.items.length, pending.sessionId)
    await this.channel.sendText(pending.owner, text, pending.contextToken)
  }

  private resolveQuestion(
    answer?: { answers: Array<{ id: string; selected: string[]; custom?: string }> },
  ): void {
    const pending = this.pendingQuestion
    if (!pending) return
    clearTimeout(pending.timer)
    pending.removeAbort()
    this.pendingQuestion = null
    pending.resolve(answer ?? skippedAnswers(pending.items))
  }

  private handleApprovalReply(message: WeixinInbound): boolean {
    const pending = this.pendingApproval
    if (!pending) return false
    const text = message.text.trim()
    if (/^(允许|同意|approve|y|yes|ok)\b/i.test(text)) {
      this.finishApproval('allowed-once')
      void this.channel.sendText(pending.owner, '已允许，继续执行。', message.contextToken).catch(() => {})
      return true
    }
    if (/^(拒绝|deny|reject|n|no)\b/i.test(text)) {
      this.finishApproval('rejected')
      void this.channel.sendText(pending.owner, '已拒绝。', message.contextToken).catch(() => {})
      return true
    }
    if (/^(允许|同意|拒绝|approve|deny|reject|y|yes|n|no)/i.test(text)) {
      void this.channel
        .sendText(message.userId, '请回复：Y 允许 或 N 拒绝', message.contextToken)
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

function userQuestionRequestOf(value: unknown): UserQuestionRequestLike | null {
  if (!isRecord(value) || !Array.isArray(value.questions)) return null
  const questions: UserQuestionItemLike[] = []
  for (const item of value.questions) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.question !== 'string') return null
    const options: UserQuestionOptionLike[] = []
    if (item.options !== undefined) {
      if (!Array.isArray(item.options)) return null
      for (const option of item.options) {
        if (!isRecord(option) || typeof option.label !== 'string') return null
        options.push({
          label: option.label,
          ...(typeof option.description === 'string' ? { description: option.description } : {}),
        })
      }
    }
    questions.push({
      id: item.id,
      question: item.question,
      ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
      ...(typeof item.header === 'string' ? { header: item.header } : {}),
      ...(options.length ? { options } : {}),
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
    })
  }
  return {
    questions,
    ...(value.agent === undefined ? {} : { agent: value.agent }),
    ...(value.signal instanceof AbortSignal ? { signal: value.signal } : {}),
    ...(isRecord(value.wait) && typeof value.wait.callId === 'string'
      ? { wait: { callId: value.wait.callId, ...(value.wait.timed === true ? { timed: true } : {}) } }
      : {}),
  }
}

function questionPrompt(
  item: UserQuestionItemLike,
  index: number,
  total: number,
  sessionId?: string,
): string {
  const options = item.options ?? []
  const lines = [
    `❓ 需要回答${total > 1 ? ` (${index + 1}/${total})` : ''}`,
    ...(sessionId ? [`会话：${shortSessionId(sessionId)}`] : []),
    ...(item.header ? [`标题：${item.header}`] : []),
    `问题：${item.question}`,
    ...(item.detail ? [`说明：${item.detail.slice(0, 500)}`] : []),
  ]
  for (const [optionIndex, option] of options.entries()) {
    lines.push(`${optionIndex + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`)
  }
  if (item.multiSelect) {
    lines.push('', '可多选，回复序号用逗号分隔（例如 1,3），也可以直接回复文字。')
  } else {
    lines.push('', options.length ? '回复选项序号或直接回复文字。' : '直接回复文字。')
  }
  lines.push('回复“跳过”跳过本题。')
  return lines.join('\n')
}

function parseQuestionReply(
  text: string,
  item: UserQuestionItemLike,
): { id: string; selected: string[]; custom?: string } | null {
  if (/^(跳过|skip)$/i.test(text)) return { id: item.id, selected: [] }
  const options = item.options ?? []
  if (item.multiSelect) {
    const exact = options.find((option) => option.label === text)
    if (exact) return { id: item.id, selected: [exact.label] }
    const selected: string[] = []
    const unknown: string[] = []
    for (const part of text.split(/[,，、\s]+/).filter(Boolean)) {
      const position = /^\d+$/.test(part) ? Number(part) - 1 : -1
      const option = position >= 0 ? options[position] : options.find((entry) => entry.label === part)
      if (option && !selected.includes(option.label)) selected.push(option.label)
      else if (!option) unknown.push(part)
    }
    if (selected.length === 0) return { id: item.id, selected: [], custom: text.slice(0, 2000) }
    return {
      id: item.id,
      selected,
      ...(unknown.length ? { custom: unknown.join(' ').slice(0, 2000) } : {}),
    }
  }
  if (/^\d+$/.test(text)) {
    const option = options[Number(text) - 1]
    return option ? { id: item.id, selected: [option.label] } : null
  }
  const option = options.find((entry) => entry.label === text)
  if (option) return { id: item.id, selected: [option.label] }
  return { id: item.id, selected: [], custom: text.slice(0, 2000) }
}

function skippedAnswers(item: UserQuestionItemLike | UserQuestionItemLike[]): {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
} {
  const items = Array.isArray(item) ? item : [item]
  return { answers: items.map((entry) => ({ id: entry.id, selected: [] })) }
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