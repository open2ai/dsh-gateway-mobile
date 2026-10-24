// Shared browser helpers for the gateway's PWA pages.

type Language = 'zh' | 'en'
type Dictionary = Record<string, string>

const I18N: Record<Language, Dictionary> = {
  zh: {
    appName: 'DSH 网关',
    pairTitle: '配对你的手机',
    pairHint: '扫描电脑上显示的二维码，或输入 8 位配对码',
    pairCode: '配对码',
    pairConfirm: '确认配对',
    pairExpires: '有效期',
    pairExpired: '配对码已过期，请在电脑上重新生成',
    pairInvalid: '配对码格式不正确',
    pairSuccess: '配对成功',
    pairFailed: '配对失败',
    pairDeviceName: '设备名称（可选）',
    pairSuccessHint: '正在进入 DSH…',
    pairSecure: '安全配对',
    pairFoot: '仅允许已配对的设备访问本机 DSH',
    copyUrl: '复制链接',
    openDsh: '打开 DSH',
    devices: '设备管理',
    oauth: '账号绑定',
    logout: '退出',
    statusTitle: '网关状态',
    tunnel: '隧道',
    tunnelPublic: '公网隧道',
    gateway: '网关',
    gatewayLocal: '本机网关',
    device: '当前设备',
    online: '在线',
    offline: '离线',
    connected: '已连接',
    disconnected: '未连接',
    version: '版本',
    devicesTitle: '设备管理',
    current: '当前设备',
    rename: '重命名',
    revoke: '撤销',
    revokeAll: '撤销全部设备',
    revokeConfirm: '撤销后该设备将立即断开连接，是否继续？',
    revokeAllPrompt: '输入 REVOKE ALL 确认撤销全部设备',
    loading: '加载中…',
    noDevices: '暂无设备',
    adminTitle: '网关管理',
    pairing: '配对',
    regenerate: '重新生成',
    tunnelStart: '启动隧道',
    tunnelStop: '停止隧道',
    tunnelRestart: '重启隧道',
    logs: '近期日志',
    localOnly: '仅本机可访问',
    oauthTitle: '绑定账号',
    oauthHint: '绑定 GitHub / Gitee 作为第二层身份确认（可选）',
    bind: '去绑定',
    skip: '跳过，稍后绑定',
    bindRequired: '本次配对要求完成账号绑定',
    bound: '已绑定',
    unbind: '解除绑定',
    openInComputer: '请在电脑上打开此页面',
    networkError: '网络错误，请检查隧道状态',
    copied: '已复制',
    confirm: '确定',
    cancel: '取消',
    close: '关闭',
    save: '保存',
    retry: '重试',
    themeToggle: '切换主题',
    id: 'ID',
    ip: 'IP',
    lastActive: '最近活跃',
    deviceNameLabel: '设备名称',
    deviceNameRequired: '设备名称不能为空',
    revokeSelf: '撤销当前设备会立即退出，需要重新配对。',
    revokeAllConfirm: '将撤销所有已授权设备并退出登录，是否继续？',
    diagTitle: '连接诊断',
    diagEnv: '环境',
    diagAddress: '当前地址',
    diagSecure: '安全上下文',
    diagYes: '是',
    diagNo: '否',
    diagUa: 'User-Agent',
    diagShowUa: '查看 User-Agent',
    diagHttp: 'HTTP',
    diagTunnel: '隧道',
    diagWs: 'WebSocket（/api/remote.mux）',
    diagHandshake: '握手',
    diagReady: '$events ready',
    diagCloseCode: '关闭码',
    diagDuration: '耗时',
    diagResult: '结果',
    diagRun: '重新检测',
    diagOk: '成功',
    diagFail: '失败',
    diagTunnelOff: '未连接',
    pairTrouble: '连不上？打开连接诊断',
    pairExpiredHint: '配对码已过期，请在电脑管理后台重新生成。',
    urlLocalOnly: '仅本机可访问',
    tunnelAccess: '公网地址',
    footer: 'DSH Gateway Mobile',
    revokedLabel: '已撤销',
    expiredLabel: '已过期',
    diagWsTimeout: '10 秒内未收到 ready；可能是 WebSocket 被网络/浏览器拦截',
    diagWsBlocked: '无法创建 WebSocket',
    diagWsCloseFailed: '握手失败；检查是否通过隧道地址访问、Cookie 是否存在',
    diagWsNoReady: '连接被关闭，未收到 ready',
    diagWsErrorGeneric: 'WebSocket 错误（浏览器不提供更多细节）',
  },
  en: {
    appName: 'DSH Gateway',
    pairTitle: 'Pair your phone',
    pairHint: 'Scan the QR code on your computer, or enter the 8-character code',
    pairCode: 'Pairing code',
    pairConfirm: 'Pair',
    pairExpires: 'Expires in',
    pairExpired: 'Code expired. Generate a new one on your computer.',
    pairInvalid: 'Invalid code format',
    pairSuccess: 'Paired',
    pairFailed: 'Pairing failed',
    pairDeviceName: 'Device name (optional)',
    pairSuccessHint: 'Opening DSH…',
    pairSecure: 'Secure pairing',
    pairFoot: 'Only paired devices can access this DSH',
    copyUrl: 'Copy link',
    openDsh: 'Open DSH',
    devices: 'Devices',
    oauth: 'Account',
    logout: 'Log out',
    statusTitle: 'Gateway status',
    tunnel: 'Tunnel',
    tunnelPublic: 'Public tunnel',
    gateway: 'Gateway',
    gatewayLocal: 'Local gateway',
    device: 'This device',
    online: 'online',
    offline: 'offline',
    connected: 'connected',
    disconnected: 'disconnected',
    version: 'Version',
    devicesTitle: 'Devices',
    current: 'current',
    rename: 'Rename',
    revoke: 'Revoke',
    revokeAll: 'Revoke all devices',
    revokeConfirm: 'This device will disconnect immediately. Continue?',
    revokeAllPrompt: 'Type REVOKE ALL to confirm',
    loading: 'Loading…',
    noDevices: 'No devices',
    adminTitle: 'Gateway admin',
    pairing: 'Pairing',
    regenerate: 'Regenerate',
    tunnelStart: 'Start tunnel',
    tunnelStop: 'Stop tunnel',
    tunnelRestart: 'Restart tunnel',
    logs: 'Recent logs',
    localOnly: 'Local access only',
    oauthTitle: 'Bind an account',
    oauthHint: 'Bind GitHub / Gitee as a second identity factor (optional)',
    bind: 'Bind',
    skip: 'Skip for now',
    bindRequired: 'Account binding is required for this pairing',
    bound: 'Bound',
    unbind: 'Unbind',
    openInComputer: 'Open this page on the computer',
    networkError: 'Network error. Check the tunnel.',
    copied: 'Copied',
    confirm: 'Confirm',
    cancel: 'Cancel',
    close: 'Close',
    save: 'Save',
    retry: 'Retry',
    themeToggle: 'Toggle theme',
    id: 'ID',
    ip: 'IP',
    lastActive: 'Last active',
    deviceNameLabel: 'Device name',
    deviceNameRequired: 'Device name is required',
    revokeSelf: 'Revoking this device logs it out immediately and requires pairing again.',
    revokeAllConfirm: 'This revokes every authorized device and logs you out. Continue?',
    diagTitle: 'Diagnostics',
    diagEnv: 'Environment',
    diagAddress: 'Address',
    diagSecure: 'Secure context',
    diagYes: 'Yes',
    diagNo: 'No',
    diagUa: 'User-Agent',
    diagShowUa: 'Show User-Agent',
    diagHttp: 'HTTP',
    diagTunnel: 'Tunnel',
    diagWs: 'WebSocket (/api/remote.mux)',
    diagHandshake: 'Handshake',
    diagReady: '$events ready',
    diagCloseCode: 'Close code',
    diagDuration: 'Duration',
    diagResult: 'Result',
    diagRun: 'Run again',
    diagOk: 'OK',
    diagFail: 'Failed',
    diagTunnelOff: 'disconnected',
    pairTrouble: 'Cannot connect? Open diagnostics',
    pairExpiredHint: 'The code expired. Generate a new one in the admin console.',
    urlLocalOnly: 'Local access only',
    tunnelAccess: 'Public URL',
    footer: 'DSH Gateway Mobile',
    revokedLabel: 'Revoked',
    expiredLabel: 'Expired',
    diagWsTimeout: 'No ready frame within 10s; the WebSocket may be blocked',
    diagWsBlocked: 'Could not create the WebSocket',
    diagWsCloseFailed: 'Handshake failed; verify the tunnel URL and cookie',
    diagWsNoReady: 'Connection closed before ready',
    diagWsErrorGeneric: 'WebSocket error (no further details from the browser)',
  },
}

const lang: Language = (navigator.language || 'zh').toLowerCase().startsWith('en') ? 'en' : 'zh'

export function t(key: string): string {
  return I18N[lang][key] ?? I18N.zh[key] ?? key
}

export function $<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector)
}

export function $$<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll<T>(selector)]
}

type AttrValue = string | number | boolean | EventListener | null | undefined
export type Attrs = Record<string, AttrValue>
export type Child = Node | string | number | null | undefined

export function el(tag: string, attrs: Attrs = {}, children: Child | Child[] = []): HTMLElement {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue
    if (key === 'text') node.textContent = String(value)
    else if (key === 'html') node.innerHTML = String(value)
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, String(value))
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue
    node.append(typeof child === 'number' ? String(child) : child)
  }
  return node
}

let toastTimer: ReturnType<typeof setTimeout> | undefined

export function toast(message: string, type = 'error'): void {
  let node = document.querySelector<HTMLElement>('.toast')
  if (!node) {
    node = document.createElement('div')
    node.className = 'toast'
    document.body.append(node)
  }
  node.textContent = message
  node.className = `toast show ${type}`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => node?.classList.remove('show'), 3000)
}

export interface ApiOptions {
  method?: string
  body?: unknown
  redirectOnAuth?: boolean
}

export class ApiError extends Error {
  code: number
  data?: unknown

  constructor(message: string, code: number, data?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}

interface ApiEnvelope<T> {
  code: number
  message?: string
  data: T
}

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = { 'x-requested-with': 'XMLHttpRequest' }
  let body: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  let response: Response
  try {
    response = await fetch(path, { method, headers, body: body ?? null, credentials: 'same-origin' })
  } catch {
    throw new ApiError(t('networkError'), 0)
  }
  let envelope: ApiEnvelope<T>
  try {
    envelope = (await response.json()) as ApiEnvelope<T>
  } catch {
    throw new ApiError(`HTTP ${response.status}`, 5001)
  }
  if (!response.ok || envelope.code !== 0) {
    if (options.redirectOnAuth !== false && [2001, 2002, 2003, 3001, 3002].includes(envelope.code)) {
      const next = encodeURIComponent(location.pathname + location.search)
      location.replace(`/mobile/pair?next=${next}`)
    }
    throw new ApiError(envelope.message || `HTTP ${response.status}`, envelope.code, envelope.data)
  }
  return envelope.data
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '-'
  const diff = Date.now() - date.getTime()
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return `${Math.floor(diff / 86_400_000)}d`
}

export interface DeviceLike {
  deviceName?: string
  deviceId?: string
}

export function deviceLabel(device: DeviceLike | null | undefined): string {
  return device?.deviceName || device?.deviceId || '-'
}

export function setText(selector: string, text: string | number | null | undefined): void {
  const node = $(selector)
  if (node) node.textContent = text === null || text === undefined ? '' : String(text)
}

export function safeNext(): string {
  const next = new URLSearchParams(location.search).get('next')
  if (next && next.startsWith('/') && !next.startsWith('//')) return next
  return '/'
}

export function escape(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function applyI18n(): void {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((node) => {
    const key = node.dataset.i18n
    if (key) node.textContent = t(key)
  })
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'
}

// ---------------------------------------------------------------------------
// Theme (shared by the phone pages and the admin console)
// ---------------------------------------------------------------------------

export type Theme = 'dark' | 'light'

const THEME_KEY = 'dsh-theme'
const LEGACY_THEME_KEYS = ['dsh-admin-theme', 'dsh-gateway-theme']

function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY)
    if (value === 'dark' || value === 'light') return value
    for (const key of LEGACY_THEME_KEYS) {
      const legacy = localStorage.getItem(key)
      if (legacy === 'dark' || legacy === 'light') return legacy
    }
  } catch {
    /* storage may be blocked */
  }
  return null
}

export function currentTheme(): Theme {
  return storedTheme() ?? 'dark'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta) meta.content = theme === 'light' ? '#f4f5f7' : '#101113'
}

function syncThemeIcon(): void {
  const use = document.querySelector<SVGUseElement>('#theme-toggle use')
  if (!use) return
  const light = document.documentElement.dataset.theme === 'light'
  use.setAttribute('href', light ? '#i-moon' : '#i-sun')
}

/** Apply the saved/system theme and wire any `#theme-toggle` buttons. */
export function initTheme(): Theme {
  ensureIconSprite()
  const theme = currentTheme()
  applyTheme(theme)
  syncThemeIcon()
  for (const button of document.querySelectorAll<HTMLElement>('#theme-toggle')) {
    button.addEventListener('click', () => {
      const next: Theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
      applyTheme(next)
      try { localStorage.setItem(THEME_KEY, next) } catch { /* storage may be blocked */ }
      syncThemeIcon()
    })
  }
  return theme
}

// ---------------------------------------------------------------------------
// Inline SVG sprite for the phone pages (same icon language as the admin UI)
// ---------------------------------------------------------------------------

const SPRITE = `
  <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></symbol>
  <symbol id="i-moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></symbol>
  <symbol id="i-arrow-left" viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7"/></symbol>
  <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></symbol>
  <symbol id="i-phone" viewBox="0 0 24 24"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></symbol>
  <symbol id="i-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></symbol>
  <symbol id="i-link" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"/></symbol>
  <symbol id="i-list" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></symbol>
  <symbol id="i-external" viewBox="0 0 24 24"><path d="M14 3h7v7"/><path d="M21 3 10 14"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></symbol>
  <symbol id="i-x" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></symbol>
`

export function ensureIconSprite(): void {
  if (document.querySelector('.svg-sprite')) return
  const holder = document.createElement('div')
  holder.innerHTML = `<svg class="svg-sprite" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">${SPRITE}</svg>`
  const sprite = holder.firstElementChild
  if (sprite) document.body.prepend(sprite)
}

// ---------------------------------------------------------------------------
// Modal dialog shared by the phone pages
// ---------------------------------------------------------------------------

export interface DialogOptions {
  title: string
  body?: string | Node
  confirmText?: string
  cancelText?: string
  danger?: boolean
  onConfirm?: () => Promise<boolean | void> | boolean | void
}

let dialogNode: HTMLDialogElement | null = null

function ensureDialog(): HTMLDialogElement {
  if (dialogNode) return dialogNode
  const dialog = document.createElement('dialog')
  dialog.className = 'dialog'
  dialog.id = 'gw-dialog'
  dialog.innerHTML = `
    <div class="dialog-inner">
      <div class="dialog-head">
        <h3 class="dialog-title"></h3>
        <button class="icon-btn dialog-close" type="button" aria-label="${t('close')}">
          <svg class="icon"><use href="#i-x"/></svg>
        </button>
      </div>
      <div class="dialog-body"></div>
      <div class="dialog-actions">
        <button class="btn secondary dialog-cancel" type="button">${t('cancel')}</button>
        <button class="btn dialog-confirm" type="button">${t('confirm')}</button>
      </div>
    </div>`
  document.body.append(dialog)
  dialogNode = dialog
  return dialog
}

/** Promise-based confirmation dialog; resolves true when the user confirms. */
export function openDialog(options: DialogOptions): Promise<boolean> {
  const dialog = ensureDialog()
  const title = dialog.querySelector<HTMLElement>('.dialog-title')!
  const body = dialog.querySelector<HTMLElement>('.dialog-body')!
  const confirm = dialog.querySelector<HTMLButtonElement>('.dialog-confirm')!
  const cancel = dialog.querySelector<HTMLButtonElement>('.dialog-cancel')!
  const close = dialog.querySelector<HTMLButtonElement>('.dialog-close')!

  title.textContent = options.title
  body.replaceChildren()
  if (typeof options.body === 'string') body.innerHTML = options.body
  else if (options.body) body.append(options.body)
  confirm.textContent = options.confirmText ?? t('confirm')
  cancel.textContent = options.cancelText ?? t('cancel')
  confirm.className = `btn ${options.danger ? 'danger' : 'primary'} dialog-confirm`
  confirm.disabled = false

  return new Promise<boolean>((resolve) => {
    const finish = (value: boolean): void => {
      if (dialog.open) dialog.close()
      dialog.oncancel = null
      dialog.onclick = null
      confirm.onclick = null
      cancel.onclick = null
      close.onclick = null
      resolve(value)
    }
    dialog.oncancel = (event) => { event.preventDefault(); finish(false) }
    dialog.onclick = (event) => { if (event.target === dialog) finish(false) }
    cancel.onclick = () => finish(false)
    close.onclick = () => finish(false)
    confirm.onclick = () => {
      confirm.disabled = true
      void Promise.resolve(options.onConfirm?.())
        .then((result) => {
          if (result === false) { confirm.disabled = false; return }
          finish(true)
        })
        .catch((error) => {
          confirm.disabled = false
          toast(error instanceof Error ? error.message : t('networkError'))
        })
    }
    dialog.showModal()
    queueMicrotask(() => {
      const input = body.querySelector('input')
      if (input) { input.focus(); input.select() }
    })
  })
}

