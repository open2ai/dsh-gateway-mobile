/**
 * WeChat iLink Bot channel.
 *
 * Phase 1: QR login, credential persistence, long-poll receive, and text send.
 * The DSH conversation bridge and approval routing are layered on top later.
 *
 * Protocol reference: 微信 iLink Bot API (get_bot_qrcode / get_qrcode_status /
 * getupdates / sendmessage). All requests are outbound; no public webhook is
 * required.
 *
 * @module dsh-gateway-mobile/lib/weixin
 */

import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { CODES, GatewayError } from './errors.js'
import type { Logger } from './logger.js'
import type { SecretBox } from './store.js'
import type { WeixinConfig } from './config.js'

export type WeixinLoginState = 'idle' | 'wait' | 'scaned' | 'pending' | 'confirmed' | 'expired' | 'error'

export interface WeixinCredentials {
  token: string
  baseUrl: string
  accountId: string
  savedAt: string
}

export interface WeixinMessageItem {
  type?: number
  text_item?: { text?: string }
  image_item?: WeixinImageItem
}

export interface WeixinImageItem {
  media?: WeixinCdnMedia
  thumb_media?: WeixinCdnMedia
  aeskey?: string
  mid_size?: number
  url?: string
}

export interface WeixinCdnMedia {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
}

export interface WeixinInboundImage {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
  data: string
  name?: string
}

export interface WeixinMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  message_type?: number
  context_token?: string
  item_list?: WeixinMessageItem[]
}

export interface WeixinLoginStatus {
  enabled: boolean
  connected: boolean
  state: WeixinLoginState
  qrcode?: string
  qrUrl?: string
  qrSvg?: string
  accountId?: string
  pendingUserId?: string
  lastError?: string
}

export interface WeixinStatus {
  enabled: boolean
  connected: boolean
  state: WeixinLoginState
  accountId?: string
  lastError?: string
  cursor: string
  received: number
}

export interface WeixinInbound {
  userId: string
  contextToken: string
  text: string
  images?: WeixinInboundImage[]
  messageId?: number
}

interface WeixinChannelOptions {
  dataDir: string
  config: WeixinConfig
  logger: Logger
  box: SecretBox
  onMessage?: (message: WeixinInbound) => void
}

interface LoginSession {
  qrcode: string
  qrUrl: string
  qrSvg: string
  state: WeixinLoginState
}

interface StoredCredentials {
  version: 1
  payload: string
}

interface ApiResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  status?: string
  qrcode?: string
  qrcode_img_content?: string
  bot_token?: string
  ilink_bot_id?: string
  ilink_user_id?: string
  baseurl?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const LOGIN_HEADER_VERSION = '1'

export class WeixinChannel {
  private readonly config: WeixinConfig
  private readonly dataDir: string
  private readonly file: string
  private readonly logger: Logger
  private readonly box: SecretBox
  onMessage: ((message: WeixinInbound) => void) | undefined
  /** Fired after an explicit logout/re-bind so the DSH session can be isolated. */
  onCredentialsChanged: (() => void) | undefined
  lastInbound: WeixinInbound | undefined
  private credentials: WeixinCredentials | null = null
  private pendingCredentials: WeixinCredentials | null = null
  private pendingUserId = ''
  private login: LoginSession | null = null
  private cursor = ''
  private received = 0
  private lastError = ''
  private polling = false
  private pollAbort: AbortController | null = null
  private readonly contexts = new Map<string, string>()

  constructor(options: WeixinChannelOptions) {
    this.config = options.config
    this.dataDir = options.dataDir
    this.file = path.join(options.dataDir, 'weixin-bot.json')
    this.logger = options.logger
    this.box = options.box
    this.onMessage = options.onMessage
  }

  get enabled(): boolean {
    return this.config.enabled
  }

  get connected(): boolean {
    return this.credentials !== null
  }

  /** Load and resume an existing bot session. */
  async start(): Promise<void> {
    if (!this.enabled) return
    this.credentials = await this.readCredentials()
    if (this.credentials) {
      // Re-encrypt legacy credentials so no historical ilink_user_id remains on disk.
      await this.writeCredentials(this.credentials)
      this.logger.info(`WeChat bot restored: ${this.credentials.accountId}`)
      this.#startPolling()
    }
  }

  /** Stop the long-poll loop and discard the pending QR state (credentials stay). */
  stop(): void {
    this.polling = false
    this.pollAbort?.abort()
    this.pollAbort = null
    this.login = null
    this.pendingCredentials = null
    this.pendingUserId = ''
  }

  status(): WeixinStatus {
    return {
      enabled: this.enabled,
      connected: this.connected,
      state: this.login?.state ?? (this.connected ? 'confirmed' : 'idle'),
      ...(this.credentials ? { accountId: this.credentials.accountId } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      cursor: this.cursor,
      received: this.received,
    }
  }

  /** Request a fresh login QR; admin-only. */
  async beginLogin(): Promise<WeixinLoginStatus> {
    if (!this.enabled) throw new GatewayError(CODES.NOT_SUPPORTED, {}, 400, 'weixin.enabled is false')
    const url = new URL('/ilink/bot/get_bot_qrcode', this.baseUrl())
    url.searchParams.set('bot_type', '3')
    const headers: Record<string, string> = {}
    if (this.config.routeTag) headers.SKRouteTag = this.config.routeTag
    const response = await this.request(url, { method: 'GET', headers })
    const qrcode = typeof response.qrcode === 'string' ? response.qrcode : ''
    const qrUrl = typeof response.qrcode_img_content === 'string' ? response.qrcode_img_content : ''
    if (!qrcode || !qrUrl) throw new GatewayError(CODES.PROXY_ERROR, {}, 502, 'WeChat QR response is incomplete')
    const qrSvg = await renderQr(qrUrl)
    this.pendingCredentials = null
    this.pendingUserId = ''
    this.login = { qrcode, qrUrl, qrSvg, state: 'wait' }
    this.lastError = ''
    return this.loginStatus()
  }

  /** Poll the active QR once. Admin UI calls this on a timer. */
  async pollLogin(): Promise<WeixinLoginStatus> {
    if (!this.login) return this.loginStatus()
    const url = new URL('/ilink/bot/get_qrcode_status', this.baseUrl())
    url.searchParams.set('qrcode', this.login.qrcode)
    const headers: Record<string, string> = { 'iLink-App-ClientVersion': LOGIN_HEADER_VERSION }
    if (this.config.routeTag) headers.SKRouteTag = this.config.routeTag
    try {
      const response = await this.request(url, { method: 'GET', headers }, 45_000)
      const state = response.status
      if (state === 'confirmed') {
        const token = response.bot_token ?? ''
        const accountId = response.ilink_bot_id ?? ''
        const userId = response.ilink_user_id ?? ''
        const baseUrl = response.baseurl || this.config.baseUrl || DEFAULT_BASE_URL
        if (!token || !accountId) throw new GatewayError(CODES.PROXY_ERROR, {}, 502, 'WeChat login response is incomplete')
        if (this.config.requireApproval) {
          this.pendingCredentials = { token, baseUrl, accountId, savedAt: new Date().toISOString() }
          this.pendingUserId = userId
          this.login.state = 'pending'
          this.lastError = ''
          this.logger.audit({ action: 'weixin.login.pending', accountId })
          return this.loginStatus()
        }
        this.credentials = { token, baseUrl, accountId, savedAt: new Date().toISOString() }
        await this.writeCredentials(this.credentials)
        this.pendingCredentials = null
        this.pendingUserId = ''
        this.login = null
        this.cursor = ''
        this.contexts.clear()
        this.lastError = ''
        this.logger.audit({ action: 'weixin.login', accountId })
        this.onCredentialsChanged?.()
        this.#startPolling()
        return this.loginStatus()
      }
      if (state === 'expired') {
        this.login.state = 'expired'
        return this.loginStatus()
      }
      if (state === 'scaned' || state === 'wait') {
        this.login.state = state
        return this.loginStatus()
      }
      this.login.state = 'error'
      this.lastError = `Unexpected WeChat QR state: ${String(state)}`
      return this.loginStatus()
    } catch (error) {
      this.lastError = errorMessage(error)
      if (this.login) this.login.state = 'error'
      return this.loginStatus()
    }
  }

  async approveLogin(approve: boolean): Promise<WeixinLoginStatus> {
    const pending = this.pendingCredentials
    if (!pending || !this.login || this.login.state !== 'pending') {
      throw new GatewayError(CODES.INVALID_PARAMS, {}, 400, 'No WeChat login is waiting for approval')
    }
    if (!approve) {
      this.pendingCredentials = null
      this.pendingUserId = ''
      this.login.state = 'expired'
      this.lastError = '已拒绝该微信连接请求'
      this.logger.audit({ action: 'weixin.login.denied' })
      return this.loginStatus()
    }
    this.credentials = pending
    await this.writeCredentials(pending)
    this.pendingCredentials = null
    this.pendingUserId = ''
    this.login = null
    this.cursor = ''
    this.contexts.clear()
    this.lastError = ''
    this.logger.audit({ action: 'weixin.login', accountId: pending.accountId })
    this.onCredentialsChanged?.()
    this.#startPolling()
    return this.loginStatus()
  }

  /** Disconnect the bot, remove credentials and stop polling. */
  async logout(): Promise<WeixinLoginStatus> {
    this.stop()
    this.credentials = null
    this.cursor = ''
    this.contexts.clear()
    this.received = 0
    this.lastError = ''
    await fsp.rm(this.file, { force: true })
    this.logger.audit({ action: 'weixin.logout' })
    this.onCredentialsChanged?.()
    return this.loginStatus()
  }

  /** Send one text reply, chunked to the client-compatible 2000-character limit. */
  async sendText(toUserId: string, text: string, contextToken: string): Promise<void> {
    const credentials = this.credentials
    if (!credentials) throw new GatewayError(CODES.NOT_SUPPORTED, {}, 400, 'WeChat bot is not connected')
    if (!contextToken) throw new GatewayError(CODES.INVALID_PARAMS, {}, 400, 'WeChat context_token is required')
    for (const chunk of splitText(text)) {
      const body = {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: `dsh-gateway:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text: chunk } }],
        },
        base_info: { channel_version: this.config.channelVersion },
      }
      await this.businessRequest('/ilink/bot/sendmessage', body)
    }
  }

  /** Last known context token for a user, used by the future DSH bridge. */
  contextFor(userId: string): string | undefined {
    return this.contexts.get(userId)
  }

  private loginStatus(): WeixinLoginStatus {
    const login = this.login
    return {
      enabled: this.enabled,
      connected: this.connected,
      state: login?.state ?? (this.connected ? 'confirmed' : 'idle'),
      ...(login ? { qrcode: login.qrcode, qrUrl: login.qrUrl, qrSvg: login.qrSvg } : {}),
      ...(this.credentials ? { accountId: this.credentials.accountId } : {}),
      ...(this.pendingCredentials && this.pendingUserId ? { pendingUserId: maskWechatId(this.pendingUserId) } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  private baseUrl(): string {
    return (this.credentials?.baseUrl || this.config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  private async request(url: URL, init: RequestInit, timeoutMs = 20_000): Promise<ApiResponse> {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const text = await response.text()
    if (!response.ok) throw new GatewayError(CODES.PROXY_ERROR, {}, 502, `WeChat API HTTP ${response.status}: ${text.slice(0, 200)}`)
    try {
      return JSON.parse(text) as ApiResponse
    } catch {
      throw new GatewayError(CODES.PROXY_ERROR, {}, 502, 'WeChat API returned invalid JSON')
    }
  }

  private async businessRequest(pathname: string, body: unknown, timeoutMs = 20_000): Promise<ApiResponse> {
    const credentials = this.credentials
    if (!credentials) throw new GatewayError(CODES.NOT_SUPPORTED, {}, 400, 'WeChat bot is not connected')
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${credentials.token}`,
      'X-WECHAT-UIN': randomWechatUin(),
    }
    if (this.config.routeTag) headers.SKRouteTag = this.config.routeTag
    const url = new URL(pathname, `${credentials.baseUrl.replace(/\/+$/, '')}/`)
    return this.request(url, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs)
  }

  #startPolling(): void {
    if (this.polling || !this.credentials || !this.enabled) return
    this.polling = true
    const controller = new AbortController()
    this.pollAbort = controller
    void this.#pollLoop(controller)
  }

  async #pollLoop(controller: AbortController): Promise<void> {
    let failures = 0
    while (this.polling && !controller.signal.aborted && this.credentials) {
      try {
        const response = await this.businessRequest('/ilink/bot/getupdates', {
          get_updates_buf: this.cursor,
          base_info: { channel_version: this.config.channelVersion },
        }, 45_000)
        const ret = Number(response.ret ?? response.errcode ?? 0)
        if (ret === -14) {
          this.lastError = '微信会话已过期，请重新扫码登录'
          this.credentials = null
          this.cursor = ''
          this.contexts.clear()
          this.polling = false
          await fsp.rm(this.file, { force: true })
          this.logger.warn('WeChat session expired; QR login required')
          return
        }
        if (ret !== 0) {
          throw new Error(`WeChat getupdates ret=${ret}${response.errmsg ? `: ${response.errmsg}` : ''}`)
        }
        if (typeof response.get_updates_buf === 'string') this.cursor = response.get_updates_buf
        for (const message of response.msgs ?? []) {
          void this.#acceptMessage(message).catch((error: unknown) => {
            this.logger.warn(`WeChat message processing failed: ${errorMessage(error)}`)
          })
        }
        failures = 0
      } catch (error) {
        if (controller.signal.aborted) return
        failures += 1
        this.lastError = errorMessage(error)
        this.logger.warn(`WeChat long-poll failed (${failures}): ${this.lastError}`)
        await sleep(failures >= 3 ? 30_000 : 2_000, controller.signal)
      }
    }
  }

  async #acceptMessage(message: WeixinMessage): Promise<void> {
    if (typeof message.from_user_id === 'string' && typeof message.context_token === 'string') {
      this.contexts.set(message.from_user_id, message.context_token)
    }
    this.received += 1
    const text = message.item_list?.find((item) => item.type === 1)?.text_item?.text ?? ''
    const images: WeixinInboundImage[] = []
    for (const [index, item] of (message.item_list ?? []).entries()) {
      if (item.type !== 2 || !item.image_item) continue
      try {
        const image = await this.downloadImage(item.image_item, message.message_id, index)
        if (image) images.push(image)
      } catch (error) {
        this.logger.warn(`WeChat image download failed: ${errorMessage(error)}`)
      }
    }
    if (!text && images.length === 0) return
    this.logger.debug(`WeChat message received${images.length ? ` [${images.length} image]` : ''}`)
    const userId = message.from_user_id
    const contextToken = message.context_token
    if (typeof userId === 'string' && typeof contextToken === 'string' && this.onMessage) {
      const inbound: WeixinInbound = {
        userId,
        contextToken,
        text,
        ...(images.length ? { images } : {}),
        ...(typeof message.message_id === 'number' ? { messageId: message.message_id } : {}),
      }
      this.lastInbound = inbound
      this.onMessage(inbound)
    }
  }

  private async downloadImage(
    image: WeixinImageItem,
    messageId: number | undefined,
    index: number,
  ): Promise<WeixinInboundImage | null> {
    const query = image.media?.encrypt_query_param
    if (!query) return null
    const url = `${this.config.cdnBase.replace(/\/+$/, '')}/download?encrypted_query_param=${encodeURIComponent(query)}`
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`CDN HTTP ${response.status}`)
    const encrypted = Buffer.from(await response.arrayBuffer())
    if (encrypted.byteLength > MAX_IMAGE_BYTES) throw new Error('image exceeds 10 MB')
    const key = decodeImageKey(image)
    const bytes = key ? decryptAesEcb(encrypted, key) : encrypted
    const mediaType = detectImageType(bytes)
    if (!mediaType) throw new Error('unsupported image format')
    const suffix = mediaType.split('/')[1]
    const name = `wechat-${messageId ?? Date.now()}-${index}.${suffix === 'jpeg' ? 'jpg' : suffix}`
    return { mediaType, data: bytes.toString('base64'), name }
  }

  private async readCredentials(): Promise<WeixinCredentials | null> {
    try {
      const raw = await fsp.readFile(this.file, 'utf8')
      const stored = JSON.parse(raw) as Partial<StoredCredentials>
      if (stored.version !== 1 || typeof stored.payload !== 'string') return null
      const value = this.box.decrypt<WeixinCredentials>(stored.payload)
      if (!value || !value.token || !value.accountId) return null
      return {
        token: value.token,
        accountId: value.accountId,
        savedAt: value.savedAt,
        baseUrl: value.baseUrl || this.config.baseUrl || DEFAULT_BASE_URL,
      }
    } catch {
      return null
    }
  }

  private async writeCredentials(credentials: WeixinCredentials): Promise<void> {
    const stored: StoredCredentials = { version: 1, payload: this.box.encrypt(credentials) }
    await fsp.mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${process.pid}.tmp`
    await fsp.writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fsp.rename(temp, this.file)
  }
}

async function renderQr(content: string): Promise<string> {
  try {
    const module = await import('qrcode')
    const QRCode = module.default ?? module
    return await QRCode.toString(content, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M' })
  } catch {
    return ''
  }
}

function randomWechatUin(): string {
  const value = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(value), 'utf8').toString('base64')
}

function splitText(text: string): string[] {
  const value = String(text ?? '')
  if (value.length <= 2000) return [value]
  const chunks: string[] = []
  let rest = value
  while (rest.length > 2000) {
    let cut = rest.lastIndexOf('\n\n', 2000)
    if (cut < 1000) cut = rest.lastIndexOf('\n', 2000)
    if (cut < 1000) cut = rest.lastIndexOf(' ', 2000)
    if (cut < 1000) cut = 2000
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function maskWechatId(userId: string): string {
  const at = userId.indexOf('@')
  const local = at >= 0 ? userId.slice(0, at) : userId
  const suffix = at >= 0 ? userId.slice(at) : ''
  if (local.length <= 8) return `${local.slice(0, 3)}***${suffix}`
  return `${local.slice(0, 4)}…${local.slice(-4)}${suffix}`
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024

function decodeImageKey(image: WeixinImageItem): Buffer | null {
  if (image.aeskey && /^[0-9a-f]{32}$/i.test(image.aeskey)) return Buffer.from(image.aeskey, 'hex')
  const encoded = image.media?.aes_key
  if (!encoded) return null
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.byteLength === 16) return decoded
  if (decoded.byteLength === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  return null
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function detectImageType(bytes: Buffer): WeixinInboundImage['mediaType'] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif'
  return null
}

