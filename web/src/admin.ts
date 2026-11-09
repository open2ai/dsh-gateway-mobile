import { $, $$, api, ApiError, applyI18n, el, formatTime, onConnectionChange, setText, toast } from './common'
import type { ConnectionState } from './common'

applyI18n()

type TabName = 'overview' | 'pair' | 'weixin' | 'devices' | 'logs' | 'settings' | 'help'
type DeviceFilter = 'all' | 'online' | 'offline' | 'revoked'
type WeixinSection = 'connect' | 'push' | 'approve'

interface TunnelInfo {
  connected?: boolean
  enabled?: boolean
  mode?: string
  state?: string
  url?: string
  publicBase?: string
  protocol?: string
  uptime?: number
  attempts?: number
  lastError?: string
  health?: 'ok' | 'degraded' | 'unknown' | 'disabled'
  lastHealthyAt?: number
  restarts?: number
  lastUrlChangedAt?: number
  metricsPort?: number
  connectors?: number
}

interface LogEntry {
  timestamp: string
  level: string
  message: string
}

interface CapabilitiesPayload {
  controller?: boolean
  workspaceRegistry?: boolean
  userQuestions?: boolean
  weixin?: boolean
  tunnel?: { enabled?: boolean; mode?: string }
}

interface HealthCheck {
  name: string
  ok: boolean
  detail?: string
  data?: unknown
  optional?: boolean
}

interface HealthPayload {
  ok: boolean
  version?: string
  startedAt?: string
  uptime?: number
  serverTime?: string
  checks?: HealthCheck[]
}

interface GatewayInfo {
  version?: string
  running?: boolean
  port?: number
  startedAt?: string
  uptime?: number
  publicBase?: string
}

interface StatsDay {
  date: string
  requests: number
}

interface StatsPayload {
  todayRequests?: number
  windowRequests?: number
  totalRequests?: number
  daily?: StatsDay[]
}

interface StatusPayload {
  tunnel?: TunnelInfo
  gateway?: GatewayInfo
  proxy?: { running?: boolean }
  capabilities?: CapabilitiesPayload
  activeDevices?: number
  onlineDevices?: number
  stats?: StatsPayload | null
  logs?: LogEntry[]
}

interface Device {
  deviceId: string
  deviceName?: string
  displayName?: string
  userAgent?: string
  isOnline?: boolean
  revoked?: boolean
  expired?: boolean
  isCurrent?: boolean
  lastActiveAt?: string
  lastIp?: string
}

interface PairingStatus {
  valid?: boolean
  expiresIn?: number
  used?: boolean
}

interface PairingPayload {
  pairingUrl?: string
  expiresIn?: number
  expiresAt?: string
  code?: string
  codeRaw?: string
  qrSvg?: string
  tunnel?: TunnelInfo
  status?: PairingStatus
  urlChangedAt?: number
  previousUrl?: string
}

interface RuntimeSettingsPayload {
  tunnelEnabled?: boolean
  weixinEnabled?: boolean
  logLevel?: string
  proxyRequestTimeoutMs?: number
}

interface SettingsPayload {
  sessionMaxAge: number
  pairingTokenExpiry: number
  limits?: SettingsLimits
  runtime?: RuntimeSettingsPayload
  restartRequired?: string[]
}

type WeixinRuntimeState = 'disabled' | 'idle' | 'connecting' | 'connected' | 'degraded' | 'expired'
type WeixinLoginState = 'idle' | 'wait' | 'scaned' | 'pending' | 'confirmed' | 'expired' | 'error'

interface WeixinOwner {
  masked?: string
  boundAt?: number
}

interface WeixinPayload {
  enabled: boolean
  connected: boolean
  state?: WeixinRuntimeState | WeixinLoginState
  qrcode?: string
  qrUrl?: string
  qrSvg?: string
  accountId?: string
  pendingUserId?: string
  lastError?: string
  cursor?: string
  received?: number
  lastPollAt?: number
  lastOkAt?: number
  failures?: number
  contextAgeMs?: number
  owner?: WeixinOwner
  allowOtherUsers?: boolean
}

interface WeixinNotifyPayload {
  enabled: boolean
  debounceMs: number
  perSessionIntervalMs: number
  globalIntervalMs: number
  maxPerHour: number
  recent: Array<{ at: number; count: number; text: string }>
  lastFailure?: { at: number; reason: string; message: string }
  permanentFailureCount?: number
}

interface WeixinApprovalEntry {
  at: number
  id: string
  sessionId: string
  toolName: string
  reason: string
  status: 'pending' | 'allowed' | 'rejected' | 'timeout' | 'cancelled' | 'unavailable'
}

interface AuditPayload {
  entries?: LogEntry[]
  total?: number
}

interface KeyRotatePayload {
  rotated?: boolean
  activeKid?: string
  keyIds?: string[]
  pairingInvalidated?: boolean
}

interface SettingsLimits {
  sessionMin: number
  sessionMax: number
  pairingMin: number
  pairingMax: number
}

type LogLevelFilter = 'info' | 'warn' | 'error' | 'audit' | 'all'

interface AdminState {
  pairingUrl: string
  expiresAt: number
  ttlSeconds: number
  activeTab: TabName
  devices: Device[]
  deviceFilter: DeviceFilter
  selectedDeviceIds: Set<string>
  logs: LogEntry[]
  logLevel: LogLevelFilter
  logQuery: string
  logAuto: boolean
  settingsLimits: SettingsLimits | null
}

const state: AdminState = {
  pairingUrl: '',
  expiresAt: 0,
  ttlSeconds: 0,
  activeTab: 'overview',
  devices: [],
  deviceFilter: 'all',
  selectedDeviceIds: new Set<string>(),
  logs: [],
  logLevel: 'info',
  logQuery: '',
  logAuto: false,
  settingsLimits: null,
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败'
}

function gatewayErrorCode(error: unknown): number {
  return error && typeof error === 'object' && 'code' in error ? Number((error as { code: unknown }).code) : 0
}

function isDeleteUnsupported(error: unknown): boolean {
  const code = gatewayErrorCode(error)
  return code === 1008 || code === 404
}

const PAGE_META: Record<TabName, [string, string]> = {
  overview: ['概览', '运行状态与统计'],
  pair: ['配对', '添加一台新的移动设备'],
  weixin: ['微信', 'ClawBot/iLink 连接、推送与审批'],
  devices: ['设备', '在线设备优先显示，可批量撤销或永久删除记录'],
  logs: ['日志', '最近的运行与审计事件，可导出审计 JSON'],
  settings: ['设置', '配对码、设备登录、运行开关与密钥轮换'],
  help: ['帮助', '常见故障、版本能力与文档入口'],
}

function setChip(id: string, text: string, ok: unknown): void {
  const node = $(`#${id}`)
  if (!node) return
  node.classList.toggle('ok', Boolean(ok))
  node.classList.toggle('bad', !ok)
  const textNode = node.querySelector('span:last-child')
  if (textNode) textNode.textContent = text
  else node.textContent = text
}

function setPageMeta(name: TabName): void {
  const meta = PAGE_META[name] ?? PAGE_META.overview
  setText('#page-title', meta[0])
  setText('#page-desc', meta[1])
}

async function withBusy<T>(button: HTMLButtonElement | null, label: string, task: () => Promise<T>): Promise<T> {
  if (!button) return task()
  const html = button.innerHTML
  button.disabled = true
  button.classList.add('is-busy')
  button.setAttribute('aria-busy', 'true')
  button.textContent = label
  try {
    return await task()
  } finally {
    button.innerHTML = html
    button.disabled = false
    button.classList.remove('is-busy')
    button.removeAttribute('aria-busy')
  }
}

function createTabController(): (name: TabName) => void {
  const tabs = $$('.tab')
  const panels = $$('.tab-panel')
  const activate = (name: TabName): void => {
    state.activeTab = name
    updateHash(name)
    setPageMeta(name)
    for (const tab of tabs) {
      const active = tab.dataset.tab === name
      tab.classList.toggle('active', active)
      tab.setAttribute('aria-selected', String(active))
    }
    for (const panel of panels) panel.classList.toggle('active', panel.dataset.panel === name)
    if (name === 'pair') void loadPairing()
    if (name === 'devices') void loadDevices()
    if (name === 'logs') void loadLogs()
    if (name === 'settings') void loadSettings()
    if (name === 'weixin') void loadWeixinStatus()
    if (name === 'weixin') void loadWeixinNotify()
    if (name === 'weixin') void loadWeixinApprovals()
    if (name === 'weixin') startWeixinLiveRefresh()
    else stopWeixinLiveRefresh()
    if (name !== 'weixin') clearWeixinPoll()
    if (name === 'overview') void loadOverview()
    if (name === 'help') void loadHelp()
  }
  for (const tab of tabs) tab.addEventListener('click', () => activate(tab.dataset.tab as TabName))
  return activate
}

function updateHash(name: string): void {
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`)
}

function bindHash(): void {
  window.addEventListener('hashchange', () => {
    const name = location.hash.slice(1)
    if (['overview', 'pair', 'weixin', 'devices', 'logs', 'settings', 'help'].includes(name)) activate(name as TabName)
  })
}

const activate = createTabController()
bindHash()

async function loadOverview(): Promise<void> {
  // Overview is health + activity (KPI/chart) on every load and poll.
  await Promise.allSettled([loadDeepHealth(), loadActivityData()])
}

/** KPI cards and the 7-day chart, loaded from the compact /status payload. */
async function loadActivityData(): Promise<void> {
  try {
    const status = await api<StatusPayload>('/mobile/api/v1/status')
    const stats = status.stats ?? {}
    setText('#metric-active', String(status.activeDevices ?? '-'))
    setText('#metric-active-foot', '已授权且未撤销')
    setText('#metric-online', String(status.onlineDevices ?? '-'))
    setText('#metric-today', String(stats.todayRequests ?? '-'))
    setText('#metric-version', status.gateway?.version || deepHealth?.version || '-')
    renderSpark(stats)
  } catch {
    /* keep the previous KPI/chart values when /status is unavailable */
  }
}

interface UptimeSnapshot {
  seconds: number
  at: number
}

let uptimeSnapshot: UptimeSnapshot | null = null

function formatUptime(seconds: number | undefined): string {
  const value = Math.max(0, Math.floor(Number(seconds) || 0))
  if (value <= 0) return '-'
  if (value < 60) return `${value} 秒`
  if (value < 3600) return `${Math.floor(value / 60)} 分 ${value % 60} 秒`
  return `${Math.floor(value / 3600)} 小时 ${Math.floor((value % 3600) / 60)} 分 ${value % 60} 秒`
}

/** Remember the last reported uptime so the display can tick every second. */
function startUptime(seconds: number | undefined): void {
  const value = Math.max(0, Math.floor(Number(seconds) || 0))
  uptimeSnapshot = value > 0 ? { seconds: value, at: Date.now() } : null
}

function tickUptime(): void {
  if (!uptimeSnapshot) return
  const node = $('#tunnel-uptime')
  if (!node) return
  const elapsed = (Date.now() - uptimeSnapshot.at) / 1000
  node.textContent = formatUptime(uptimeSnapshot.seconds + elapsed)
}

const TUNNEL_STATE_LABELS: Record<string, string> = {
  connected: '已连接',
  starting: '连接中',
  reconnecting: '重连中',
  stopped: '已停止',
  disabled: '已关闭',
  error: '错误',
}

function tunnelStateLabel(state: string | undefined): string {
  return (state && TUNNEL_STATE_LABELS[state]) || state || '-'
}

const TUNNEL_HEALTH_LABELS: Record<string, string> = {
  ok: '正常',
  degraded: '降级',
  unknown: '未知',
  disabled: '已关闭',
}

function tunnelHealthLabel(health: TunnelInfo['health'], connected: boolean | undefined): string {
  if (health && TUNNEL_HEALTH_LABELS[health]) return TUNNEL_HEALTH_LABELS[health]!
  return connected ? '正常' : '不可用'
}

const WEIXIN_RUNTIME_LABELS: Record<string, string> = {
  disabled: '未启用',
  idle: '空闲（未登录）',
  connecting: '连接中 / 等待首条消息',
  connected: '已连接',
  degraded: '降级（轮询失败）',
  expired: '会话已过期',
  wait: '等待微信扫码',
  scaned: '已扫码，请在微信确认',
  pending: '等待本机确认',
  confirmed: '已连接',
  error: '连接失败',
}

function weixinStateLabel(state: string | undefined): string {
  return (state && WEIXIN_RUNTIME_LABELS[state]) || state || '-'
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) return '-'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN')
}

function formatAgeMs(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} 秒`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} 小时`
  return `${(ms / 86_400_000).toFixed(1)} 天`
}

function formatTimestamp(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '-'
  return new Date(ms).toLocaleString('zh-CN')
}

// ---------------------------------------------------------------------------
// Status chips / diagnostics (deep health is the single source for overview)
// ---------------------------------------------------------------------------

let capabilities: CapabilitiesPayload | null = null
let deepHealth: HealthPayload | null = null
let lastTunnelInfo: TunnelInfo | null = null
let lastHealthAt = 0

const CHECK_LABELS: Record<string, string> = {
  gateway: '网关',
  storage: '存储',
  'dsh-upstream': 'DSH 上游',
  tunnel: '公网隧道',
  weixin: '微信 Bot',
  capabilities: '能力矩阵',
}

function healthCheckData<T>(check: HealthCheck | undefined): T | null {
  if (!check || !check.data || typeof check.data !== 'object') return null
  return check.data as T
}

function healthChecksByName(payload: HealthPayload): Map<string, HealthCheck> {
  return new Map((payload.checks ?? []).map((check) => [check.name, check]))
}

function setStatusChip(id: string, state: 'ok' | 'bad' | 'off', text: string, title: string): void {
  const chip = $(`#${id}`)
  if (!chip) return
  chip.classList.toggle('ok', state === 'ok')
  chip.classList.toggle('bad', state === 'bad')
  chip.classList.toggle('off', state === 'off')
  chip.dataset.state = state
  const textNode = chip.querySelector('.status-chip-text')
  if (textNode) textNode.textContent = text
  chip.title = title
  const name = chip.querySelector('.status-chip-name')?.textContent ?? id
  chip.setAttribute('aria-label', `${name}：${text}`)
}

const WEIXIN_CHIP_STATES: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  idle: '空闲',
  degraded: '降级',
  expired: '已过期',
  disabled: '未启用',
}

function renderOverviewChips(checks: Map<string, HealthCheck>): void {
  const gateway = checks.get('gateway')
  const gatewayData = healthCheckData<{ port?: number; uptime?: number }>(gateway)
  const gatewayTitle = gateway
    ? [
        gateway.detail,
        gatewayData?.port ? `端口 ${gatewayData.port}` : '',
        typeof gatewayData?.uptime === 'number' ? `运行 ${formatUptime(gatewayData.uptime)}` : '',
      ].filter(Boolean).join(' · ')
    : '深度健康检查未加载'
  setStatusChip('chip-gateway', gateway ? (gateway.ok ? 'ok' : 'bad') : 'off', gateway ? (gateway.ok ? '正常' : '异常') : '未加载', gatewayTitle || '网关')

  const tunnel = checks.get('tunnel')
  const tunnelData = healthCheckData<TunnelInfo>(tunnel)
  if (tunnelData) lastTunnelInfo = tunnelData
  const tunnelOff = Boolean(tunnel && (tunnelData?.enabled === false || tunnelData?.state === 'disabled' || tunnel?.detail === 'disabled'))
  const tunnelTitle = tunnel
    ? [tunnelData?.url || tunnelData?.publicBase, tunnelData?.mode ? `模式 ${tunnelData.mode}` : '', tunnelData?.protocol, tunnel.detail].filter(Boolean).join(' · ')
    : '深度健康检查未加载'
  setStatusChip(
    'chip-tunnel',
    tunnel ? (tunnelOff ? 'off' : tunnel.ok ? 'ok' : 'bad') : 'off',
    tunnel
      ? tunnelOff
        ? '已关闭'
        : tunnel.ok
          ? tunnelStateLabel(tunnelData?.state)
          : tunnelStateLabel(tunnelData?.state) || tunnel.detail || '异常'
      : '未加载',
    tunnelTitle || '公网隧道',
  )

  const upstream = checks.get('dsh-upstream')
  setStatusChip(
    'chip-dsh',
    upstream ? (upstream.ok ? 'ok' : 'bad') : 'off',
    upstream ? (upstream.ok ? '正常' : '异常') : '未加载',
    upstream ? upstream.detail || 'DSH 上游' : '深度健康检查未加载',
  )

  const weixin = checks.get('weixin')
  const weixinData = healthCheckData<{ state?: string; connected?: boolean; failures?: number }>(weixin)
  const weixinDisabled = Boolean(weixin && (weixin.detail === 'disabled' || weixinData?.state === 'disabled'))
  const weixinState = weixinData?.state
  const weixinText = weixinDisabled ? '未启用' : (weixinState && WEIXIN_CHIP_STATES[weixinState]) || (weixin ? (weixin.ok ? '正常' : '异常') : '未加载')
  const weixinTitle = weixin
    ? [
        weixinState ? weixinStateLabel(weixinState) : '',
        typeof weixinData?.failures === 'number' ? `失败 ${weixinData.failures} 次` : '',
        weixin.detail && weixin.detail !== weixinState ? weixin.detail : '',
      ].filter(Boolean).join(' · ') || '微信 Bot'
    : '深度健康检查未加载'
  setStatusChip('chip-weixin', weixin ? (weixinDisabled ? 'off' : weixin.ok ? 'ok' : 'bad') : 'off', weixinText || '未加载', weixinTitle)
}

function checkDetailLabel(check: HealthCheck): string {
  const detail = check.detail ?? ''
  if (!detail) return ''
  if (check.name === 'tunnel' && TUNNEL_STATE_LABELS[detail]) return TUNNEL_STATE_LABELS[detail]!
  if (check.name === 'weixin' && WEIXIN_RUNTIME_LABELS[detail]) return WEIXIN_RUNTIME_LABELS[detail]!
  return detail
}

function renderOverviewAlert(checks: Map<string, HealthCheck>): void {
  const alert = $('#overview-alert')
  if (!alert) return
  const failed = [...checks.values()].filter((check) => !check.ok && !(check.optional === true && check.detail === 'disabled'))
  if (failed.length === 0) {
    alert.hidden = true
    return
  }
  alert.hidden = false
  setText('#overview-alert-text', `检测到 ${failed.length} 项异常：${failed
    .map((check) => `${CHECK_LABELS[check.name] ?? check.name}${checkDetailLabel(check) ? `（${checkDetailLabel(check)}）` : ''}`)
    .join('、')}`)
}

const CAPABILITY_LABELS: Array<['controller' | 'workspaceRegistry' | 'userQuestions' | 'weixin', string]> = [
  ['controller', '控制器'],
  ['workspaceRegistry', '工作区注册'],
  ['userQuestions', '用户提问'],
  ['weixin', '微信'],
]

function renderCapabilityWarning(caps: CapabilitiesPayload | null): void {
  const warning = $('#capability-warning')
  if (!warning) return
  const missing = caps ? CAPABILITY_LABELS.filter(([key]) => caps[key] === false).map(([, label]) => label) : []
  if (missing.length === 0) {
    warning.hidden = true
    return
  }
  warning.hidden = false
  setText('#capability-warning-text', `DSH 可选能力缺失：${missing.join('、')}（微信相关功能会降级）`)
}

function healthUnavailable(): void {
  for (const id of ['chip-gateway', 'chip-tunnel', 'chip-dsh', 'chip-weixin']) {
    setStatusChip(id, 'off', '未加载', '深度健康检查未加载')
  }
  const alert = $('#overview-alert')
  if (alert) alert.hidden = true
  const warning = $('#capability-warning')
  if (warning) warning.hidden = true
  deepHealth = null
  capabilities = null
  setChip('deep-health-chip', '未加载', false)
  const list = $('#deep-health-list')
  if (list) list.replaceChildren(el('p', { class: 'muted', text: '深度健康检查未加载（旧版网关或 deep=1 未实现）' }))
  setText('#deep-health-meta', 'GET /mobile/api/v1/admin/health?deep=1 不可用')
  renderCapabilitiesPlaceholder('当前网关未提供能力矩阵')
  updateTunnelPanel(undefined)
  updateHelpSummary()
}

function normalizeHealthBody(body: unknown): HealthPayload | null {
  if (!body || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  if (typeof record.ok === 'boolean') return record as unknown as HealthPayload
  if (record.data && typeof record.data === 'object') return normalizeHealthBody(record.data)
  return null
}

async function fetchHealthPayload(): Promise<{ payload: HealthPayload; httpOk: boolean } | null> {
  try {
    const payload = await api<HealthPayload>('/mobile/api/v1/admin/health?deep=1', { retry: false })
    return { payload, httpOk: true }
  } catch (error) {
    // A 503 still carries the full payload; api() throws with data attached.
    if (error instanceof ApiError && error.data && typeof error.data === 'object') {
      const payload = normalizeHealthBody(error.data)
      if (payload) return { payload, httpOk: false }
    }
    return null
  }
}

function extractCapabilities(checks: Map<string, HealthCheck>): CapabilitiesPayload | null {
  return healthCheckData<CapabilitiesPayload>(checks.get('capabilities'))
}

function applyHealth(payload: HealthPayload, httpOk: boolean): void {
  const checks = payload.checks ?? []
  if (checks.length === 0) {
    healthUnavailable()
    return
  }
  deepHealth = payload
  lastHealthAt = Date.now()
  const byName = healthChecksByName(payload)
  capabilities = extractCapabilities(byName)
  renderOverviewChips(byName)
  renderOverviewAlert(byName)
  renderCapabilityWarning(capabilities)
  renderDiagnostics(checks, payload, httpOk)
  updateTunnelPanel(byName.get('tunnel'))
  updateHelpSummary()
}

async function loadDeepHealth(): Promise<void> {
  const result = await fetchHealthPayload()
  if (result) applyHealth(result.payload, result.httpOk)
  else healthUnavailable()
}

function renderDiagnostics(checks: HealthCheck[], payload: HealthPayload, httpOk: boolean): void {
  const list = $('#deep-health-list')
  const healthy = payload.ok !== false && httpOk
  setChip('deep-health-chip', healthy ? '全部正常' : '存在异常', healthy)
  if (list) {
    list.replaceChildren()
    for (const check of checks) {
      list.append(el('div', { class: `health-check ${check.ok ? 'is-ok' : 'is-bad'}` }, [
        el('span', { class: `dot ${check.ok ? 'ok' : 'bad'}` }),
        el('span', { class: 'health-name' }, [
          el('span', { text: check.name }),
          check.detail ? el('small', { text: check.detail }) : null,
        ]),
        el('span', { class: 'health-state', text: check.optional && check.detail === 'disabled' ? '未启用' : check.ok ? '正常' : '异常' }),
      ]))
    }
  }
  const parts: string[] = []
  if (typeof payload.version === 'string') parts.push(`版本 ${payload.version}`)
  if (typeof payload.uptime === 'number') parts.push(`运行 ${formatUptime(payload.uptime)}`)
  if (payload.serverTime) parts.push(`服务器时间 ${formatDateTime(payload.serverTime)}`)
  setText('#deep-health-meta', healthy ? parts.join(' · ') : `HTTP 503 · ${parts.join(' · ')}`)
  if (capabilities) renderCapabilities(capabilities)
  else renderCapabilitiesPlaceholder('深度健康检查未返回能力矩阵')
}

function renderCapabilitiesPlaceholder(text: string): void {
  const list = $('#capability-matrix')
  if (!list) return
  list.replaceChildren(el('p', { class: 'muted', text }))
}

function updateTunnelPanel(check: HealthCheck | undefined): void {
  const data = healthCheckData<TunnelInfo>(check)
  if (data) lastTunnelInfo = data
  const tunnel = data ?? lastTunnelInfo
  const connected = Boolean(tunnel && (tunnel.state === 'connected' || tunnel.connected === true))
  const starting = tunnel?.state === 'starting'
  setChip('tunnel-chip', check ? (tunnel ? tunnelStateLabel(tunnel.state) : check.detail || (check.ok ? '正常' : '异常')) : '未加载', Boolean(check?.ok ?? connected))
  setText('#tunnel-url', tunnel?.url || tunnel?.publicBase || '-')
  const copy = $<HTMLButtonElement>('#copy-url')
  if (copy) copy.disabled = !(tunnel?.url || tunnel?.publicBase)
  setText('#tunnel-meta', tunnel?.protocol || '-')
  setText('#tunnel-health', tunnelHealthLabel(tunnel?.health, tunnel?.connected ?? connected))
  setText('#tunnel-uptime', formatUptime(tunnel?.uptime))
  if (tunnel) {
    startUptime(tunnel.uptime)
    trackPublicUrl(tunnel.url || tunnel.publicBase || '')
  }
  const startButton = $<HTMLButtonElement>('#tunnel-start')
  const stopButton = $<HTMLButtonElement>('#tunnel-stop')
  if (startButton) startButton.hidden = connected
  if (stopButton) stopButton.hidden = !connected && !starting
  setText('#tunnel-hint', check
    ? connected ? '' : tunnel?.lastError || check.detail || '隧道未连接。'
    : '深度健康检查未加载；仍可尝试启动/重启隧道。')
}

function capabilityRow(name: string, hint: string, state: 'ok' | 'bad' | 'off', label: string): HTMLElement {
  return el('div', { class: 'cap-row' }, [
    el('div', { class: 'cap-name' }, [el('span', { text: name }), el('small', { text: hint })]),
    el('span', { class: `cap-state ${state}` }, [el('span', { class: `dot ${state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : ''}`.trim() }), el('span', { text: label })]),
  ])
}

function renderCapabilities(caps: CapabilitiesPayload): void {
  const list = $('#capability-matrix')
  if (!list) return
  list.replaceChildren()
  list.append(
    capabilityRow('DSH 控制器', '会话 / 审批 / 提问接口', caps.controller ? 'ok' : 'bad', caps.controller ? '可用' : '不可用'),
    capabilityRow('工作区注册', '多工作区会话与状态', caps.workspaceRegistry ? 'ok' : 'bad', caps.workspaceRegistry ? '可用' : '不可用'),
    capabilityRow('用户提问', 'ask_user_question 桥接', caps.userQuestions ? 'ok' : 'bad', caps.userQuestions ? '可用' : '不可用'),
    capabilityRow('微信通道', 'ClawBot / iLink 消息桥', caps.weixin ? 'ok' : 'bad', caps.weixin ? '已加载' : '未启用'),
  )
  const tunnel = caps.tunnel
  list.append(capabilityRow(
    '公网隧道',
    tunnel?.mode ? `模式：${tunnel.mode}` : 'Cloudflare 隧道',
    tunnel?.enabled ? 'ok' : 'off',
    tunnel?.enabled ? `已启用${tunnel.mode ? ` · ${tunnel.mode}` : ''}` : '已关闭',
  ))
  updateHelpCapabilities()
}

// ---------------------------------------------------------------------------
// Help tab
// ---------------------------------------------------------------------------

async function loadHelp(): Promise<void> {
  updateHelpSummary()
  if (!deepHealth) void loadDeepHealth()
  else if (Date.now() - lastHealthAt > 60_000) void loadDeepHealth()
}

function updateHelpSummary(): void {
  setText('#help-version', deepHealth?.version ? `v${deepHealth.version}` : '-')
  setText('#help-uptime', formatUptime(deepHealth?.uptime))
  setText('#help-controller', capabilities ? (capabilities.controller ? '已加载' : '未加载') : '-')
  updateHelpCapabilities()
}

function updateHelpCapabilities(): void {
  if (!capabilities) {
    setText('#help-capabilities', '-')
    return
  }
  const caps = capabilities
  const enabled = [
    caps.controller ? '控制器' : '',
    caps.workspaceRegistry ? '工作区' : '',
    caps.userQuestions ? '用户提问' : '',
    caps.weixin ? '微信' : '',
    caps.tunnel?.enabled ? '隧道' : '',
  ].filter(Boolean)
  setText('#help-capabilities', enabled.length > 0 ? enabled.join(' · ') : '无')
}

/** Jump from the overview (anomaly bar / failing chip) to the help diagnostics. */
function openDiagnostics(): void {
  activate('help')
  const details = $<HTMLDetailsElement>('#help-diagnostics-details')
  if (details) {
    if (!details.open) details.open = true
    else void loadDeepHealth()
    details.scrollIntoView({ block: 'start', behavior: 'smooth' })
  } else {
    void loadDeepHealth()
  }
}

interface ChartPoint {
  x: number
  y: number
  day: StatsDay
}

function smoothPath(points: ChartPoint[]): string {
  if (points.length === 0) return ''
  const first = points[0]!
  if (points.length === 1) return `M ${first.x} ${first.y}`
  let path = `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[index - 1] ?? points[index]!
    const p1 = points[index]!
    const p2 = points[index + 1]!
    const p3 = points[index + 2] ?? p2
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6
    path += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`
  }
  return path
}

function renderSpark(stats: StatsPayload): void {
  const container = $('#spark')
  const labels = $('#spark-labels')
  if (!container || !labels) return
  container.replaceChildren()
  labels.replaceChildren()
  const daily = stats.daily ?? []
  const total = daily.reduce((sum, day) => sum + (Number(day.requests) || 0), 0)
  const peak = daily.reduce((best, day) => Math.max(best, Number(day.requests) || 0), 0)
  const average = daily.length > 0 ? total / daily.length : 0
  const scaleMax = Math.max(4, Math.ceil(peak / 4) * 4)
  setText('#chart-total', String(stats.windowRequests ?? total))
  setText('#chart-summary', `总计 ${total} · 日均 ${average.toFixed(1)} · 峰值 ${peak}`)
  if (daily.length === 0) {
    container.textContent = '暂无数据'
    return
  }
  const width = 720
  const height = 154
  const padX = 16
  const padTop = 16
  const padBottom = 12
  const step = daily.length === 1 ? 0 : (width - padX * 2) / (daily.length - 1)
  const points: ChartPoint[] = daily.map((day, index) => ({
    x: padX + step * index,
    y: height - padBottom - (day.requests / scaleMax) * (height - padTop - padBottom),
    day,
  }))
  const line = smoothPath(points)
  const first = points[0]!
  const last = points[points.length - 1]!
  const area = `${line} L ${last.x.toFixed(2)} ${height - padBottom} L ${first.x.toFixed(2)} ${height - padBottom} Z`
  const grid = [0, 0.5, 1].map((ratio) => {
    const y = (padTop + (height - padTop - padBottom) * ratio).toFixed(2)
    return `<line class="chart-axis" x1="${padX}" x2="${width - padX}" y1="${y}" y2="${y}" />`
  }).join('')
  const circles = points.map((point) => `<circle class="chart-point" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3.2" fill="var(--surface)" stroke="url(#lineGradient)" stroke-width="2"><title>${point.day.date}: ${point.day.requests} 次</title></circle>`).join('')
  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="近 7 天请求趋势">
      <defs>
        <linearGradient id="lineGradient" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#6366f1" />
          <stop offset="100%" stop-color="#8b5cf6" />
        </linearGradient>
        <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#6366f1" stop-opacity=".30" />
          <stop offset="100%" stop-color="#6366f1" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${grid}
      <line class="chart-hover-line" id="chart-hover-line" x1="0" x2="0" y1="${padTop}" y2="${height - padBottom}" visibility="hidden" />
      <path d="${area}" fill="url(#areaGradient)" />
      <path d="${line}" fill="none" stroke="url(#lineGradient)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
      ${circles}
    </svg>`
  const yAxis = $('#chart-y')
  if (yAxis) {
    yAxis.replaceChildren()
    for (const [index, value] of [scaleMax, scaleMax / 2, 0].entries()) {
      const ratio = index / 2
      yAxis.append(
        el('span', {
          class: 'chart-y-label',
          text: String(Math.round(value)),
          style: `top:${((padTop + (height - padTop - padBottom) * ratio) / height) * 100}%`,
        }),
      )
    }
  }

  for (const day of daily) {
    labels.append(el('span', { text: day.date?.slice(5) ?? '' }))
  }

  const tip = $('#chart-tip')
  const hoverLine = $('#chart-hover-line')
  if (!tip || !hoverLine) return
  const showAt = (index: number): void => {
    const point = points[index]
    if (!point) return
    const rect = container.getBoundingClientRect()
    tip.textContent = `${point.day.requests} 次`
    tip.hidden = false
    tip.style.left = `${(point.x / width) * rect.width}px`
    tip.style.top = `${(point.y / height) * rect.height - 10}px`
    hoverLine.setAttribute('x1', String(point.x))
    hoverLine.setAttribute('x2', String(point.x))
    hoverLine.setAttribute('visibility', 'visible')
    for (const [dotIndex, circle] of container.querySelectorAll('circle.chart-point').entries()) {
      circle.classList.toggle('active', dotIndex === index)
    }
  }
  const pick = (event: PointerEvent): void => {
    const rect = container.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    showAt(Math.round(ratio * (daily.length - 1)))
  }
  container.onpointermove = pick
  container.onpointerdown = pick
  container.onpointerleave = () => {
    tip.hidden = true
    hoverLine.setAttribute('visibility', 'hidden')
    for (const circle of container.querySelectorAll('circle.chart-point')) circle.classList.remove('active')
  }
}

const TUNNEL_URL_KEY = 'dsh-admin-tunnel-url'
let pairAutoRefreshDone = false
let pairRegenInFlight = false
let pairingExpiredPolled = false

function applyPairing(data: PairingPayload): void {
  state.pairingUrl = data.pairingUrl || ''
  state.expiresAt = Date.now() + (data.expiresIn ?? 0) * 1000
  state.ttlSeconds = data.expiresIn || 900
  // Keep the one-shot expiry probe latched while the server keeps returning an
  // already-expired code, otherwise tickPairing and loadPairing would ping-pong.
  if ((data.expiresIn ?? 0) > 0) pairingExpiredPolled = false
  setText('#pairing-code', data.code || '----')
  setText('#pairing-url', data.pairingUrl || '')
  const external = String(data.pairingUrl || '').startsWith('https://')
  const qr = $('#qr')
  if (qr) {
    qr.classList.toggle('qr-empty', !external)
    qr.innerHTML = external ? data.qrSvg || '' : '<span class="qr-placeholder">隧道连接后生成二维码</span>'
  }
  setText(
    '#pair-hint',
    external ? '' : '隧道未连接：当前配对链接只指向 127.0.0.1，手机无法打开。请先在“概览”启动隧道。',
  )
  if (data.status?.valid === false) setText('#pair-expiry', '已过期')
  trackTunnelUrl(data)
  maybeAutoRefreshPairing(data)
  tickPairing()
}

/** Persist the current public URL and surface a persistent banner when it changes. */
function trackTunnelUrl(data: PairingPayload): void {
  trackPublicUrl(data.tunnel?.url || data.tunnel?.publicBase || '', data.previousUrl || '', data.urlChangedAt || 0)
}

function trackPublicUrl(current: string, serverPrevious = '', urlChangedAt = 0): void {
  if (!current) return
  let previous = ''
  try { previous = localStorage.getItem(TUNNEL_URL_KEY) || '' } catch { /* storage may be blocked */ }
  const changedPrevious = serverPrevious && serverPrevious !== current ? serverPrevious : ''
  const changed = Boolean((previous && previous !== current) || (changedPrevious && urlChangedAt && Date.now() - urlChangedAt < 86_400_000))
  if (changed) showTunnelChangeBanner(previous || changedPrevious, current)
  try { localStorage.setItem(TUNNEL_URL_KEY, current) } catch { /* storage may be blocked */ }
}

function showTunnelChangeBanner(previous: string, current: string): void {
  const banner = $('#tunnel-change-banner')
  if (!banner) return
  setText('#tunnel-change-text', previous
    ? `旧地址 ${previous} · 新地址 ${current}，手机上的旧配对链接已失效，请重新生成配对码并配对。`
    : `公网地址已变化：${current}。手机上的旧配对链接已失效，请重新配对。`)
  banner.hidden = false
}

function hideTunnelChangeBanner(): void {
  const banner = $('#tunnel-change-banner')
  if (banner) banner.hidden = true
}

// ---------------------------------------------------------------------------
// Weak-network banner (mirrors common.ts connection state)
// ---------------------------------------------------------------------------

let lastAdminConnection: ConnectionState = 'online'

function renderConnectionBanner(state: ConnectionState): void {
  const banner = $('#connection-banner')
  const recovered = lastAdminConnection !== 'online'
  lastAdminConnection = state
  if (state === 'online') {
    if (banner) banner.hidden = true
    if (recovered) {
      toast('网络已恢复，正在刷新数据', 'ok')
      void refreshAll()
    }
    return
  }
  if (banner) banner.hidden = false
  setText('#connection-title', state === 'offline' ? '网络连接中断' : '网络不稳定')
  setText('#connection-text', state === 'offline'
    ? '请求已暂停，恢复网络后会自动重试；也可以点“立即重试”。'
    : '请求失败，已按 0.5s / 1s / 2s 退避重试（最多 3 次）。')
}

function maybeAutoRefreshPairing(data: PairingPayload): void {
  const valid = data.status?.valid
  if (valid === true) {
    pairAutoRefreshDone = false
    return
  }
  if (valid !== false) return
  if (document.visibilityState !== 'visible' || state.activeTab !== 'pair') return
  if (pairAutoRefreshDone || pairRegenInFlight) return
  pairAutoRefreshDone = true
  setText('#pair-hint', '配对码已过期，正在自动刷新…')
  void regeneratePairing(true)
}

async function regeneratePairing(auto = false): Promise<void> {
  if (pairRegenInFlight) return
  pairRegenInFlight = true
  const button = $<HTMLButtonElement>('#regenerate')
  const request = (): Promise<PairingPayload> =>
    api<PairingPayload>('/mobile/api/v1/admin/pairing/regenerate', { method: 'POST' })
  try {
    const data = auto ? await request() : await withBusy(button, '生成中…', request)
    applyPairing(data)
    // Do not auto-retry when the freshly issued code is still reported invalid.
    pairAutoRefreshDone = data.status?.valid !== false
    toast(auto ? '配对码已过期，已自动刷新' : '已生成新配对码', 'ok')
  } catch (error) {
    if (auto) setText('#pair-hint', `配对码已过期，自动刷新失败：${errorMessage(error)}。请点“重新生成”。`)
    else toast(errorMessage(error))
  } finally {
    pairRegenInFlight = false
  }
}

async function loadPairing(): Promise<void> {
  try {
    const data = await api<PairingPayload>('/mobile/api/v1/admin/pairing')
    applyPairing(data)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? Number((error as { code: unknown }).code) : 0
    setText('#pairing-code', code === 3003 ? '仅本机可访问' : errorMessage(error))
  }
}

function tickPairing() {
  if (!state.expiresAt) return
  const left = Math.max(0, Math.floor((state.expiresAt - Date.now()) / 1000))
  setText('#pair-expiry', left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : '已过期')
  const progress = $('#pair-progress')
  if (progress) progress.style.width = `${Math.min(100, Math.round((left / Math.max(1, state.ttlSeconds)) * 100))}%`
  if (left === 0 && state.activeTab === 'pair' && document.visibilityState === 'visible' && !pairingExpiredPolled) {
    pairingExpiredPolled = true
    void loadPairing()
  }
}

// ---------------------------------------------------------------------------
// Devices: online-first list, filter chips, multi-select + batch revoke
// ---------------------------------------------------------------------------

const DEVICE_FILTERS: DeviceFilter[] = ['all', 'online', 'offline', 'revoked']

const DEVICE_FILTER_EMPTY: Record<DeviceFilter, string> = {
  all: '暂无设备，先到“配对”页添加一台。',
  online: '当前没有在线设备',
  offline: '没有离线设备',
  revoked: '没有已撤销或已过期的设备',
}

function isDeviceInactive(device: Device): boolean {
  return Boolean(device.revoked || device.expired)
}

function deviceStatus(device: Device): { label: string; dot: string } {
  if (device.revoked) return { label: '已撤销', dot: 'bad' }
  if (device.expired) return { label: '已过期', dot: '' }
  return device.isOnline ? { label: '在线', dot: 'ok' } : { label: '离线', dot: '' }
}

function deviceActiveTime(device: Device): number {
  const value = Date.parse(device.lastActiveAt ?? '')
  return Number.isNaN(value) ? 0 : value
}

/** Online first, then offline, expired, revoked; newest activity first inside a group. */
function sortDevices(devices: Device[]): Device[] {
  const rank = (device: Device): number => {
    if (device.revoked) return 3
    if (device.expired) return 2
    return device.isOnline ? 0 : 1
  }
  return [...devices].sort((left, right) =>
    rank(left) - rank(right) ||
    Number(Boolean(right.isCurrent)) - Number(Boolean(left.isCurrent)) ||
    deviceActiveTime(right) - deviceActiveTime(left),
  )
}

function matchesDeviceFilter(device: Device, filter: DeviceFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'revoked') return isDeviceInactive(device)
  if (isDeviceInactive(device)) return false
  return filter === 'online' ? Boolean(device.isOnline) : !device.isOnline
}

function visibleDevices(): Device[] {
  return state.devices.filter((device) => matchesDeviceFilter(device, state.deviceFilter))
}

/** Rows are selectable regardless of state: active ones for revoking, inactive ones for deleting. */
function selectableDevices(): Device[] {
  return visibleDevices()
}

function splitSelectedDevices(): { active: Device[]; inactive: Device[] } {
  const active: Device[] = []
  const inactive: Device[] = []
  for (const device of state.devices) {
    if (!state.selectedDeviceIds.has(device.deviceId)) continue
    if (isDeviceInactive(device)) inactive.push(device)
    else active.push(device)
  }
  return { active, inactive }
}

function updateDeviceCounts(): void {
  const count = (filter: DeviceFilter): number =>
    state.devices.filter((device) => matchesDeviceFilter(device, filter)).length
  setText('#filter-count-all', String(count('all')))
  setText('#filter-count-online', String(count('online')))
  setText('#filter-count-offline', String(count('offline')))
  setText('#filter-count-revoked', String(count('revoked')))
  const inactiveCount = count('revoked')
  const selectedInactive = splitSelectedDevices().inactive.length
  const purge = $<HTMLButtonElement>('#device-purge')
  if (purge) {
    purge.hidden = inactiveCount === 0 || state.deviceFilter !== 'revoked' || selectedInactive > 0
    purge.textContent = '清理已撤销'
  }
  for (const chip of $$<HTMLButtonElement>('#device-filters .filter-chip')) {
    const filter = chip.dataset.filter as DeviceFilter | undefined
    if (!filter) continue
    const active = filter === state.deviceFilter
    chip.classList.toggle('active', active)
    chip.setAttribute('aria-pressed', String(active))
  }
}

function updateDeviceSelection(): void {
  const { active: selectedActive, inactive: selectedInactive } = splitSelectedDevices()
  const visible = selectableDevices()
  const visibleActive = visible.filter((device) => !isDeviceInactive(device))
  const batchRevoke = $<HTMLButtonElement>('#batch-revoke')
  if (batchRevoke) {
    batchRevoke.hidden = selectedActive.length === 0 && visibleActive.length === 0
    batchRevoke.disabled = selectedActive.length === 0
    batchRevoke.textContent = selectedActive.length > 0 ? `撤销所选 (${selectedActive.length})` : '撤销所选'
  }
  const batchDelete = $<HTMLButtonElement>('#batch-delete')
  if (batchDelete) {
    batchDelete.hidden = selectedInactive.length === 0
    batchDelete.disabled = selectedInactive.length === 0
    batchDelete.textContent = selectedInactive.length > 0 ? `永久删除 (${selectedInactive.length})` : '永久删除'
  }
  const visibleSelected = visible.filter((device) => state.selectedDeviceIds.has(device.deviceId)).length
  const allSelected = visible.length > 0 && visibleSelected === visible.length
  const selectAll = $<HTMLButtonElement>('#device-select-all')
  if (selectAll) {
    selectAll.hidden = visible.length === 0
    selectAll.textContent = allSelected ? '取消全选' : '全选'
    selectAll.disabled = visible.length === 0
    selectAll.classList.toggle('active', allSelected)
  }
  const head = $<HTMLInputElement>('#device-select-all-head')
  if (head) {
    head.checked = allSelected
    head.indeterminate = visibleSelected > 0 && !allSelected
    head.disabled = visible.length === 0
  }
}

function setVisibleSelection(selected: boolean): void {
  for (const device of selectableDevices()) {
    if (selected) state.selectedDeviceIds.add(device.deviceId)
    else state.selectedDeviceIds.delete(device.deviceId)
  }
  renderDevices()
}

function toggleSelectAll(): void {
  const visible = selectableDevices()
  const allSelected = visible.length > 0 && visible.every((device) => state.selectedDeviceIds.has(device.deviceId))
  setVisibleSelection(!allSelected)
}

function renderDeviceRow(device: Device): HTMLElement {
  const displayName = device.displayName || device.deviceName || device.deviceId
  const fullName = device.deviceName || device.userAgent || ''
  const inactive = isDeviceInactive(device)
  const status = deviceStatus(device)
  const selected = state.selectedDeviceIds.has(device.deviceId)

  const checkbox = el('input', {
    type: 'checkbox',
    class: 'device-check',
    'aria-label': `选择设备 ${displayName}`,
  }) as HTMLInputElement
  checkbox.checked = selected

  const title = el('div', { class: 'device-title' }, [
    el('strong', { text: displayName, title: fullName }),
    device.isCurrent ? el('span', { class: 'badge current', text: '当前' }) : null,
  ])
  const meta = el('div', { class: 'device-meta' }, [
    el('span', { class: 'mono', text: device.deviceId }),
  ])
  const info = el('div', { class: 'device-info' }, [title, meta])
  const statusNode = el('div', {
    class: 'device-status',
    'data-label': '状态',
  }, [
    el('span', { class: `dot ${status.dot}`.trim() }),
    el('span', { text: status.label }),
  ])
  const absoluteActive = device.lastActiveAt ? new Date(device.lastActiveAt) : null
  const active = el('div', {
    class: 'device-active',
    'data-label': '最近活跃',
    text: formatTime(device.lastActiveAt),
    title: absoluteActive && !Number.isNaN(absoluteActive.getTime()) ? absoluteActive.toLocaleString() : '',
  })
  const ip = el('div', {
    class: 'device-ip',
    'data-label': 'IP 地址',
    text: device.lastIp || '-',
  })
  const actions = el('div', { class: 'device-actions' }, inactive
    ? [
        el('button', { class: 'text-button danger', text: '永久删除', onclick: () => void deleteDevices([device]) }),
      ]
    : [
        el('button', { class: 'text-button', text: '重命名', onclick: () => void renameDevice(device) }),
        el('button', { class: 'text-button danger', text: '撤销', onclick: () => void revokeDevices([device]) }),
      ])
  const row = el('article', {
    class: [
      'device-item',
      inactive ? 'is-inactive' : '',
      device.isOnline && !inactive ? 'is-online' : '',
      selected ? 'selected' : '',
    ].filter(Boolean).join(' '),
  }, [
    el('label', { class: 'device-select' }, [checkbox]),
    info,
    el('div', { class: 'device-facts' }, [statusNode, active, ip]),
    actions,
  ])
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) state.selectedDeviceIds.add(device.deviceId)
    else state.selectedDeviceIds.delete(device.deviceId)
    row.classList.toggle('selected', checkbox.checked)
    updateDeviceSelection()
  })
  return row
}

function renderDevices(): void {
  updateDeviceCounts()
  updateDeviceSelection()
  const list = $('#device-list')
  if (!list) return
  const devices = visibleDevices()
  list.replaceChildren()
  const table = $('#device-table')
  if (table) table.classList.toggle('is-empty', devices.length === 0)
  if (devices.length === 0) {
    list.append(el('div', { class: 'device-empty' }, [
      el('p', { class: 'muted', text: DEVICE_FILTER_EMPTY[state.deviceFilter] }),
    ]))
    return
  }
  for (const device of devices) list.append(renderDeviceRow(device))
}

function renderDeviceSkeleton(): void {
  const list = $('#device-list')
  if (!list) return
  list.replaceChildren()
  for (let index = 0; index < 3; index += 1) {
    list.append(el('div', { class: 'device-skeleton' }, [
      el('div', { class: 'skeleton skeleton-title' }),
      el('div', { class: 'skeleton skeleton-line' }),
      el('div', { class: 'skeleton skeleton-line short' }),
    ]))
  }
}

function renderDeviceError(message: string): void {
  const list = $('#device-list')
  if (!list) return
  list.replaceChildren()
  list.append(el('div', { class: 'device-empty' }, [
    el('p', { class: 'muted', text: message }),
    el('button', { class: 'button', text: '重试', onclick: () => void loadDevices() }),
  ]))
}

async function loadDevices(): Promise<void> {
  if (state.devices.length === 0) renderDeviceSkeleton()
  try {
    const data = await api<{ devices?: Device[] }>('/mobile/api/v1/devices?all=1')
    state.devices = sortDevices(data.devices ?? [])
    const devicesById = new Map(state.devices.map((device) => [device.deviceId, device]))
    for (const deviceId of [...state.selectedDeviceIds]) {
      if (!devicesById.has(deviceId)) state.selectedDeviceIds.delete(deviceId)
    }
    renderDevices()
  } catch (error) {
    renderDeviceError(errorMessage(error) || '加载失败')
  }
}

interface ModalOptions {
  title: string
  eyebrow?: string
  body: string | Node
  confirmText?: string
  danger?: boolean
  onConfirm: () => Promise<boolean | void>
}

function openModal({ title, eyebrow = 'DEVICE', body, confirmText = '确定', danger = false, onConfirm }: ModalOptions): Promise<boolean> {
  const dialog = $<HTMLDialogElement>('#modal')
  const titleNode = $<HTMLElement>('#modal-title')
  const eyebrowNode = $<HTMLElement>('#modal-eyebrow')
  const bodyNode = $<HTMLElement>('#modal-body')
  const confirm = $<HTMLButtonElement>('#modal-confirm')
  const cancel = $<HTMLButtonElement>('#modal-cancel')
  const close = $<HTMLButtonElement>('#modal-close')
  if (!dialog || !titleNode || !bodyNode || !confirm || !cancel || !close) return Promise.resolve(false)

  titleNode.textContent = title
  if (eyebrowNode) eyebrowNode.textContent = eyebrow
  bodyNode.replaceChildren()
  if (typeof body === 'string') bodyNode.innerHTML = body
  else if (body) bodyNode.append(body)
  confirm.textContent = confirmText
  confirm.className = `button ${danger ? 'danger' : 'primary'}`
  confirm.disabled = false

  return new Promise<boolean>((resolve) => {
    const finish = (value: boolean): void => {
      if (dialog.open) dialog.close()
      resolve(value)
    }
    dialog.oncancel = (event) => { event.preventDefault(); finish(false) }
    dialog.onclick = (event) => { if (event.target === dialog) finish(false) }
    cancel.onclick = () => finish(false)
    close.onclick = () => finish(false)
    bodyNode.onkeydown = (event) => {
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
        event.preventDefault()
        confirm.click()
      }
    }
    confirm.onclick = async () => {
      confirm.disabled = true
      try {
        const result = await onConfirm()
        if (result === false) return
        finish(true)
      } catch (error) {
        toast(errorMessage(error) || '操作失败')
      } finally {
        confirm.disabled = false
      }
    }
    dialog.showModal()
    queueMicrotask(() => {
      const input = bodyNode.querySelector('input')
      if (input) { input.focus(); input.select() }
    })
  })
}

async function renameDevice(device: Device): Promise<void> {
  const input = el('input', {
    type: 'text',
    value: device.deviceName || '',
    maxlength: '40',
    placeholder: '给设备起个名字',
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement
  const field = el('label', { class: 'field' }, [el('span', { text: '设备名称' }), input])
  await openModal({
    title: '重命名设备',
    eyebrow: 'DEVICE',
    body: field,
    confirmText: '保存',
    onConfirm: async () => {
      const name = input.value.trim()
      if (!name) {
        toast('设备名称不能为空')
        return false
      }
      await api(`/mobile/api/v1/devices/${encodeURIComponent(device.deviceId)}`, {
        method: 'PATCH',
        body: { deviceName: name },
      })
      toast('已重命名', 'ok')
      await loadDevices()
      return true
    },
  })
}

/** Revoke one or many devices behind a single confirmation dialog. */
async function revokeDevices(devices: Device[]): Promise<void> {
  const targets = devices.filter((device) => !isDeviceInactive(device))
  if (targets.length === 0) {
    toast('请先选择要撤销的设备')
    return
  }
  const count = targets.length
  const body = el('div', { class: 'revoke-body' })
  body.append(el('p', { class: 'revoke-lead' }, [
    document.createTextNode(count > 1 ? '即将撤销以下设备的授权：' : '即将撤销该设备的授权：'),
  ]))
  const list = el('ul', { class: 'revoke-list' })
  for (const device of targets) {
    const status = deviceStatus(device)
    list.append(el('li', { class: 'revoke-item' }, [
      el('span', { class: `dot ${status.dot}`.trim() }),
      el('span', { class: 'revoke-name', text: device.displayName || device.deviceName || device.deviceId }),
      el('span', { class: 'revoke-meta', text: `${status.label} · ${device.lastIp || '-'}` }),
    ]))
  }
  body.append(list)
  body.append(el('p', { class: 'hint', text: '撤销后设备会立即断开连接，无法恢复授权；如需再次访问，请重新配对。' }))

  await openModal({
    title: count > 1 ? `撤销 ${count} 台设备` : '撤销设备',
    eyebrow: 'DANGER',
    body,
    confirmText: count > 1 ? `撤销 ${count} 台` : '撤销',
    danger: true,
    onConfirm: async () => {
      const confirm = $<HTMLButtonElement>('#modal-confirm')
      let revoked = 0
      const failures: string[] = []
      for (const [index, device] of targets.entries()) {
        if (confirm) confirm.textContent = count > 1 ? `撤销中 ${index + 1}/${count}…` : '撤销中…'
        try {
          await api(`/mobile/api/v1/devices/${encodeURIComponent(device.deviceId)}/revoke`, { method: 'POST' })
          revoked += 1
        } catch (error) {
          failures.push(errorMessage(error))
        }
      }
      for (const device of targets) state.selectedDeviceIds.delete(device.deviceId)
      await loadDevices()
      if (failures.length > 0) {
        toast(`已撤销 ${revoked} 台，${failures.length} 台失败：${failures[0]}`, 'error')
      } else if (count > 1) {
        toast(`已撤销 ${revoked} 台设备`, 'ok')
      } else {
        toast('设备已撤销，重新配对即可恢复', 'ok')
      }
      return true
    },
  })
}

function revokeSelectedDevices(): void {
  const targets = state.devices.filter(
    (device) => state.selectedDeviceIds.has(device.deviceId) && !isDeviceInactive(device),
  )
  if (targets.length === 0) {
    toast('请先选择要撤销的设备')
    return
  }
  void revokeDevices(targets)
}

function deleteSelectedDevices(): void {
  const targets = state.devices.filter(
    (device) => state.selectedDeviceIds.has(device.deviceId) && isDeviceInactive(device),
  )
  if (targets.length === 0) {
    toast('请先选择要永久删除的设备')
    return
  }
  void deleteDevices(targets)
}

const DELETE_UNAVAILABLE_TEXT = '当前 dsh 进程尚未加载删除接口，请重启一次 dsh web 后再试'

function deviceListBody(devices: Device[], lead: string): HTMLElement {
  const body = el('div', { class: 'revoke-body' })
  body.append(el('p', { class: 'revoke-lead', text: lead }))
  const list = el('ul', { class: 'revoke-list' })
  for (const device of devices) {
    const status = deviceStatus(device)
    list.append(el('li', { class: 'revoke-item' }, [
      el('span', { class: `dot ${status.dot}`.trim() }),
      el('span', { class: 'revoke-name', text: device.displayName || device.deviceName || device.deviceId }),
      el('span', { class: 'revoke-meta', text: `${status.label} · ${device.lastIp || '-'}` }),
    ]))
  }
  body.append(list)
  return body
}

/** Permanently delete one or many revoked/expired device records. */
async function deleteDevices(devices: Device[]): Promise<void> {
  const targets = devices.filter(isDeviceInactive)
  if (targets.length === 0) return
  const count = targets.length
  const body = deviceListBody(targets, count > 1 ? '即将从设备记录中永久删除以下设备：' : '即将从设备记录中永久删除该设备：')
  body.append(el('p', { class: 'hint', text: '永久删除后无法恢复；如需再次访问，请重新配对。' }))
  await openModal({
    title: '永久删除设备',
    eyebrow: 'DANGER',
    body,
    confirmText: '永久删除',
    danger: true,
    onConfirm: async () => {
      const confirm = $<HTMLButtonElement>('#modal-confirm')
      let deleted = 0
      const failures: unknown[] = []
      for (const [index, device] of targets.entries()) {
        if (confirm) confirm.textContent = count > 1 ? `删除中 ${index + 1}/${count}…` : '删除中…'
        try {
          await api(`/mobile/api/v1/devices/${encodeURIComponent(device.deviceId)}`, { method: 'DELETE' })
          deleted += 1
        } catch (error) {
          failures.push(error)
        }
      }
      for (const device of targets) state.selectedDeviceIds.delete(device.deviceId)
      await loadDevices()
      if (failures.some(isDeleteUnsupported)) {
        toast(DELETE_UNAVAILABLE_TEXT, 'error')
      } else if (failures.length > 0) {
        toast(`已删除 ${deleted} 台，${failures.length} 台失败：${errorMessage(failures[0])}`, 'error')
      } else if (count > 1) {
        toast(`已永久删除 ${deleted} 台设备`, 'ok')
      } else {
        toast('设备记录已永久删除', 'ok')
      }
      return true
    },
  })
}

/** Permanently delete every revoked/expired device record in one call. */
async function purgeRevokedDevices(): Promise<void> {
  const targets = state.devices.filter(isDeviceInactive)
  if (targets.length === 0) {
    toast('没有可清理的已撤销记录')
    return
  }
  const body = deviceListBody(targets, '即将从设备记录中永久删除以下已撤销 / 已过期记录：')
  body.append(el('p', { class: 'hint', text: '永久删除后无法恢复；这些设备需要重新配对才能再次访问。' }))
  await openModal({
    title: '清理已撤销记录',
    eyebrow: 'DANGER',
    body,
    confirmText: '永久删除',
    danger: true,
    onConfirm: async () => {
      try {
        const data = await api<{ deleted?: number }>('/mobile/api/v1/devices/purge', {
          method: 'POST',
          body: { confirmText: 'DELETE REVOKED' },
        })
        toast(`已永久删除 ${data.deleted ?? targets.length} 条记录`, 'ok')
        await loadDevices()
      } catch (error) {
        toast(isDeleteUnsupported(error) ? DELETE_UNAVAILABLE_TEXT : errorMessage(error) || '删除失败', 'error')
      }
      return true
    },
  })
}

const LOG_LEVEL_FILTERS: LogLevelFilter[] = ['info', 'warn', 'error', 'audit', 'all']

const LOG_LEVEL_LABELS: Record<string, string> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  audit: 'AUDIT',
}

function logMatches(entry: LogEntry, level: LogLevelFilter, query: string): boolean {
  const entryLevel = String(entry.level).toLowerCase()
  const matchesLevel = level === 'all'
    ? true
    : level === 'info'
      ? entryLevel === 'info' || entryLevel === 'audit'
      : entryLevel === level
  if (!matchesLevel) return false
  if (!query) return true
  return entry.message.toLowerCase().includes(query.toLowerCase())
}

function formatLogTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return timestamp
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  const time = date.toLocaleTimeString()
  if (sameDay) return time
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${time}`
}

function renderLogs(): void {
  const list = $('#log-list')
  const meta = $('#log-meta')
  for (const chip of $$<HTMLButtonElement>('#log-filters .filter-chip')) {
    const level = chip.dataset.level as LogLevelFilter | undefined
    if (!level) continue
    const active = level === state.logLevel
    chip.classList.toggle('active', active)
    chip.setAttribute('aria-pressed', String(active))
  }
  const filtered = state.logs.filter((entry) => logMatches(entry, state.logLevel, state.logQuery))
  if (meta) {
    meta.textContent = `共 ${state.logs.length} 条 · 显示 ${filtered.length} 条${state.logAuto ? ' · 自动刷新中' : ''}`
  }
  if (!list) return
  list.replaceChildren()
  if (filtered.length === 0) {
    list.append(el('div', { class: 'log-empty' }, [el('p', { class: 'muted', text: '没有匹配的日志' })]))
    return
  }
  for (const entry of [...filtered].reverse()) {
    const level = String(entry.level).toLowerCase()
    const date = new Date(entry.timestamp)
    list.append(el('div', { class: `log-item level-${level}` }, [
      el('time', {
        class: 'log-item-time',
        text: formatLogTime(entry.timestamp),
        title: Number.isNaN(date.getTime()) ? entry.timestamp : date.toLocaleString(),
      }),
      el('span', { class: `log-item-level ${level}`, text: LOG_LEVEL_LABELS[level] ?? level.toUpperCase() }),
      el('span', { class: 'log-item-msg', text: entry.message }),
    ]))
  }
}

async function loadLogs(): Promise<void> {
  try {
    const data = await api<{ logs?: LogEntry[] }>('/mobile/api/v1/logs?limit=200')
    state.logs = data.logs ?? []
    renderLogs()
  } catch (error) {
    const list = $('#log-list')
    if (!list) return
    list.replaceChildren(el('div', { class: 'log-empty' }, [
      el('p', { class: 'muted', text: errorMessage(error) || '日志加载失败' }),
      el('button', { class: 'button', text: '重试', onclick: () => void loadLogs() }),
    ]))
    setText('#log-meta', '加载失败')
  }
}

function formatSessionDuration(seconds: number): string {
  const days = seconds / 86400
  if (days >= 1) return `${Number(days.toFixed(2))} 天`
  const hours = seconds / 3600
  if (hours >= 1) return `${Number(hours.toFixed(1))} 小时`
  return `${Math.round(seconds / 60)} 分钟`
}

function formatPairingDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  return seconds >= 3600 ? `${Number((seconds / 3600).toFixed(1))} 小时` : `${Math.round(seconds / 60)} 分钟`
}

function setSettingsAvailable(available: boolean, message = ''): void {
  const notice = $('#settings-notice')
  if (notice) {
    notice.hidden = available
    notice.textContent = message
  }
  for (const selector of ['#setting-session-days', '#setting-pairing-minutes', '#save-settings', '#reset-settings']) {
    const node = $<HTMLInputElement | HTMLButtonElement>(selector)
    if (node) node.disabled = !available
  }
}

function setFieldError(field: 'session' | 'pairing', message: string): void {
  const node = $(`#error-${field}`)
  if (node) node.textContent = message
  const input = $(field === 'session' ? '#setting-session-days' : '#setting-pairing-minutes')
  if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false')
}

function clearSettingsErrors(): void {
  setFieldError('session', '')
  setFieldError('pairing', '')
}

function setSettingsStatus(text: string, ok: boolean): void {
  const node = $('#settings-status')
  if (!node) return
  node.textContent = text
  node.classList.toggle('ok', ok)
  node.classList.toggle('bad', !ok)
}

let weixinTimer: ReturnType<typeof setTimeout> | undefined

function clearWeixinPoll(): void {
  if (weixinTimer !== undefined) {
    clearTimeout(weixinTimer)
    weixinTimer = undefined
  }
}

function scheduleWeixinPoll(): void {
  clearWeixinPoll()
  weixinTimer = setTimeout(() => {
    weixinTimer = undefined
    void pollWeixinLogin()
  }, 1500)
}

function renderWeixinDetails(data: WeixinPayload): void {
  const runtime = data.state ?? (data.connected ? 'connected' : 'idle')
  setText('#weixin-state-label', weixinStateLabel(runtime))
  setText('#weixin-last-poll', formatTimestamp(data.lastPollAt))
  setText('#weixin-last-ok', formatTimestamp(data.lastOkAt))
  const failures = typeof data.failures === 'number' ? data.failures : 0
  setText('#weixin-failures', `${failures} 次`)
  const age = data.contextAgeMs
  setText('#weixin-context-age', typeof age === 'number' ? (age < 0 ? '无有效上下文' : `${formatAgeMs(age)}前`) : '-')
  const owner = data.owner
  setText('#weixin-owner', owner?.masked
    ? `${owner.masked}${typeof owner.boundAt === 'number' && owner.boundAt > 0 ? ` · 绑定于 ${formatTimestamp(owner.boundAt)}` : ''}`
    : '未绑定')
  setText('#weixin-allow-others', data.allowOtherUsers ? '允许（白名单）' : '不允许')
  const alert = $('#weixin-owner-alert')
  if (alert) alert.hidden = Boolean(owner?.masked) || !data.enabled
}

function renderWeixin(data: WeixinPayload): void {
  const qr = $('#weixin-qr')
  const status = $('#weixin-status')
  const hint = $('#weixin-hint')
  const login = $<HTMLButtonElement>('#weixin-login')
  const logout = $<HTMLButtonElement>('#weixin-logout')
  const rebind = $<HTMLButtonElement>('#weixin-rebind')
  const approve = $<HTMLButtonElement>('#weixin-approve')
  const deny = $<HTMLButtonElement>('#weixin-deny')
  const svg = data.qrSvg || ''
  const runtime = data.state
  renderWeixinDetails(data)
  if (qr) {
    qr.hidden = runtime === 'pending' || !svg
    qr.innerHTML = svg
  }
  if (login) {
    login.hidden = Boolean(data.connected) || runtime === 'pending'
    login.disabled = !data.enabled
    login.textContent = runtime === 'expired' || runtime === 'error' ? '重新获取二维码' : '获取二维码'
  }
  if (logout) logout.hidden = !data.connected
  if (rebind) rebind.hidden = !data.connected
  if (approve) approve.hidden = runtime !== 'pending'
  if (deny) deny.hidden = runtime !== 'pending'

  if (!data.enabled) {
    if (status) status.textContent = '微信通道未启用'
    if (hint) hint.textContent = '在 gateway-mobile 配置中开启 weixin.enabled 后重启。'
    return
  }
  if (runtime === 'pending') {
    if (status) status.textContent = '有微信请求连接'
    if (hint) hint.textContent = `扫码账号：${data.pendingUserId || '已隐藏'}。需要本机管理员确认后才保存凭证并连接。`
    return
  }
  if (runtime === 'degraded') {
    if (status) status.textContent = '连接降级：轮询连续失败'
    if (hint) hint.textContent = data.lastError || '微信轮询连续失败，正在自动重试；若持续失败请重新扫码。'
    return
  }
  if (runtime === 'expired') {
    if (status) status.textContent = '微信会话已过期'
    if (hint) hint.textContent = data.lastError || '微信会话已过期，请点击“重新获取二维码”重新扫码登录。'
    return
  }
  if (data.connected) {
    if (status) status.textContent = `已连接：${data.accountId || 'WeChat Bot'}`
    if (hint) {
      hint.textContent = data.owner?.masked
        ? `微信 Bot 已连接，所有者 ${data.owner.masked}；换号请点“换绑微信”。`
        : '微信 Bot 已连接；尚未绑定所有者，收到第一条入站消息后自动绑定。换号请点“换绑微信”。'
    }
    return
  }
  const labels: Record<string, string> = {
    idle: '未连接',
    disabled: '微信通道未启用',
    connecting: '连接中…',
    wait: '等待微信扫码…',
    scaned: '已扫码，请在微信中确认',
    pending: '等待本机确认',
    confirmed: '已连接',
    expired: '二维码已过期',
    error: '连接失败',
  }
  if (status) status.textContent = (runtime && labels[runtime]) || '未连接'
  if (hint) {
    hint.textContent = runtime === 'error'
      ? data.lastError || '连接失败，请重新获取二维码'
      : '用微信扫描二维码登录 ClawBot；扫码后需在本机管理员确认。'
  }
  if ((runtime === 'wait' || runtime === 'scaned') && svg) scheduleWeixinPoll()
}

async function loadWeixinStatus(): Promise<void> {
  try {
    renderWeixin(await api<WeixinPayload>('/mobile/api/v1/admin/weixin'))
  } catch (error) {
    if (weixinGatewayUnavailable(error)) {
      setText('#weixin-status', '当前网关未加载微信接口')
      setText('#weixin-hint', '运行的 DSH 还是旧版本。重启 dsh web，或等待插件重载后刷新本页。')
      const login = $<HTMLButtonElement>('#weixin-login')
      if (login) login.disabled = true
      return
    }
    toast(errorMessage(error))
  }
}

function weixinGatewayUnavailable(error: unknown): boolean {
  const code = gatewayErrorCode(error)
  return code === 1008 || code === 404
}

async function startWeixinLogin(): Promise<void> {
  clearWeixinPoll()
  try {
    const data = await withBusy($<HTMLButtonElement>('#weixin-login'), '获取中…', () =>
      api<WeixinPayload>('/mobile/api/v1/admin/weixin/login', { method: 'POST' }),
    )
    renderWeixin(data)
    if (data.state === 'wait' || data.state === 'scaned') scheduleWeixinPoll()
  } catch (error) {
    toast(weixinGatewayUnavailable(error)
      ? '当前网关还是旧版本，重启 dsh web 后刷新本页再试。'
      : errorMessage(error))
    await loadWeixinStatus()
  }
}

async function pollWeixinLogin(): Promise<void> {
  try {
    const data = await api<WeixinPayload>('/mobile/api/v1/admin/weixin/login')
    renderWeixin(data)
  } catch (error) {
    toast(errorMessage(error))
    clearWeixinPoll()
  }
}

let weixinHistoryExpanded = false
let weixinHistoryItems: WeixinNotifyPayload['recent'] = []
let weixinHistorySelected = 0
let weixinLiveTimer: ReturnType<typeof setInterval> | undefined

function startWeixinLiveRefresh(): void {
  stopWeixinLiveRefresh()
  weixinLiveTimer = setInterval(() => {
    if (document.hidden) return
    void loadWeixinNotify()
    void loadWeixinApprovals()
  }, 15_000)
}

function stopWeixinLiveRefresh(): void {
  if (weixinLiveTimer !== undefined) {
    clearInterval(weixinLiveTimer)
    weixinLiveTimer = undefined
  }
}

function selectWeixinHistory(index: number): void {
  weixinHistorySelected = index
  const rows = $$('#weixin-notify-history .notify-history-row')
  rows.forEach((row, rowIndex) => row.classList.toggle('is-selected', rowIndex === index))
  renderWeixinHistoryDetail(index)
}

function renderWeixinHistoryDetail(index: number): void {
  const detail = $('#weixin-notify-detail')
  const entry = weixinHistoryItems[index]
  if (!detail) return
  detail.innerHTML = ''
  if (!entry) {
    detail.append(el('p', { class: 'muted', text: '点击左侧记录查看详情。' }))
    return
  }
  detail.append(
    el('div', { class: 'notify-detail-meta' }, [
      el('span', { text: new Date(entry.at).toLocaleString('zh-CN') }),
      el('span', { text: `${entry.count} 条` }),
    ]),
    el('div', { class: 'notify-detail-text', text: entry.text }),
  )
}

function setNumberInput(selector: string, value: number): void {
  const input = $<HTMLInputElement>(selector)
  if (input) input.value = String(value)
}

function updateWeixinPolicyOutputs(): void {
  const pairs: Array<[string, string, string]> = [
    ['#weixin-notify-debounce', '#weixin-notify-debounce-value', ' 秒'],
    ['#weixin-notify-per-session', '#weixin-notify-per-session-value', ' 秒'],
    ['#weixin-notify-global', '#weixin-notify-global-value', ' 秒'],
    ['#weixin-notify-max', '#weixin-notify-max-value', ' 条'],
  ]
  for (const [inputSelector, outputSelector, unit] of pairs) {
    const input = $<HTMLInputElement>(inputSelector)
    const output = $(outputSelector)
    if (input && output) output.textContent = `${input.value}${unit}`
  }
}

function renderWeixinNotify(data: WeixinNotifyPayload): void {
  const stateNode = $('#weixin-notify-state')
  const toggle = $<HTMLInputElement>('#weixin-notify-enabled')
  const history = $('#weixin-notify-history')
  const summary = $('#weixin-notify-summary')
  const expand = $<HTMLButtonElement>('#weixin-notify-toggle')
  if (stateNode) {
    stateNode.textContent = data.enabled ? '已开启' : '已关闭'
    stateNode.classList.toggle('ok', data.enabled)
    stateNode.classList.toggle('bad', !data.enabled)
  }
  if (toggle) {
    toggle.checked = data.enabled
    toggle.disabled = false
  }
  const failure = $('#weixin-notify-failure')
  if (failure) {
    const last = data.lastFailure
    const permanent = data.permanentFailureCount ?? 0
    if (last && (last.reason === 'auth-expired' || permanent > 0)) {
      failure.hidden = false
      failure.textContent = `微信会话异常，推送可能暂停（永久失败 ${permanent} 次）· ${last.message}（${formatTimestamp(last.at)}）`
    } else if (last && Date.now() - last.at < 86_400_000) {
      failure.hidden = false
      failure.textContent = `最近一次推送失败（${formatTimestamp(last.at)} · ${last.reason}）：${last.message}`
    } else {
      failure.hidden = true
      failure.textContent = ''
    }
  }
  setNumberInput('#weixin-notify-debounce', Math.round(data.debounceMs / 1000))
  setNumberInput('#weixin-notify-per-session', Math.round(data.perSessionIntervalMs / 1000))
  setNumberInput('#weixin-notify-global', Math.round(data.globalIntervalMs / 1000))
  setNumberInput('#weixin-notify-max', data.maxPerHour)
  updateWeixinPolicyOutputs()
  if (!history) return
  weixinHistoryItems = data.recent
  weixinHistorySelected = 0
  history.innerHTML = ''
  if (summary) summary.textContent = data.recent.length === 0 ? '暂无推送记录' : `共 ${data.recent.length} 条 · 左侧选择记录查看详情`
  if (data.recent.length === 0) {
    history.append(el('p', { class: 'muted', text: '暂无推送记录。' }))
    if (expand) expand.hidden = true
    renderWeixinHistoryDetail(0)
    return
  }
  const canCollapse = data.recent.length > 3
  history.classList.toggle('is-collapsed', canCollapse && !weixinHistoryExpanded)
  if (expand) {
    expand.hidden = !canCollapse
    expand.textContent = weixinHistoryExpanded ? '收起' : '展开全部'
  }
  for (const [index, entry] of data.recent.entries()) {
    const preview = entry.text.split('\n').map((line) => line.trim()).find(Boolean) ?? 'DSH 任务完成'
    const row = el('button', { class: 'notify-history-row', type: 'button' }, [
      el('div', { class: 'notify-history-meta' }, [
        el('span', { text: new Date(entry.at).toLocaleString('zh-CN') }),
        el('span', { text: `${entry.count} 条` }),
      ]),
      el('div', { class: 'notify-history-preview', text: preview.slice(0, 100) }),
    ])
    row.addEventListener('click', () => selectWeixinHistory(index))
    history.append(row)
  }
  selectWeixinHistory(0)
}

async function loadWeixinNotify(): Promise<void> {
  try {
    renderWeixinNotify(await api<WeixinNotifyPayload>('/mobile/api/v1/admin/weixin/notify'))
  } catch (error) {
    if (!weixinGatewayUnavailable(error)) toast(errorMessage(error))
    setText('#weixin-notify-state', '未加载')
    const toggle = $<HTMLInputElement>('#weixin-notify-enabled')
    if (toggle) toggle.disabled = true
  }
}

function approvalStatusLabel(status: WeixinApprovalEntry['status']): string {
  return {
    pending: '等待回复',
    allowed: '已允许',
    rejected: '已拒绝',
    timeout: '已超时',
    cancelled: '已取消',
    unavailable: '无法送达',
  }[status]
}

function renderWeixinApprovals(items: WeixinApprovalEntry[]): void {
  const history = $('#weixin-approval-history')
  if (!history) return
  history.innerHTML = ''
  if (items.length === 0) {
    history.append(el('p', { class: 'muted', text: '暂无审批记录。' }))
    return
  }
  for (const entry of items) {
    const status = approvalStatusLabel(entry.status)
    history.append(el('div', { class: 'approval-history-item' }, [
      el('div', { class: 'approval-history-meta' }, [
        el('span', { text: new Date(entry.at).toLocaleString('zh-CN') }),
        el('span', { class: `approval-status ${entry.status}`, text: status }),
      ]),
      el('div', { class: 'approval-history-title', text: `#${entry.id} · ${entry.toolName}` }),
      el('div', { class: 'approval-history-session', text: `会话：${shortSessionId(entry.sessionId)}` }),
      el('div', { class: 'approval-history-reason', text: entry.reason }),
    ]))
  }
}

function shortSessionId(sessionId: string): string {
  if (!sessionId) return '(unknown)'
  return sessionId.length > 18 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-6)}` : sessionId
}

async function loadWeixinApprovals(): Promise<void> {
  try {
    const data = await api<{ items?: WeixinApprovalEntry[] }>('/mobile/api/v1/admin/weixin/approvals')
    renderWeixinApprovals(data.items ?? [])
  } catch (error) {
    if (!weixinGatewayUnavailable(error)) toast(errorMessage(error))
  }
}

async function setWeixinNotifyEnabled(enabled: boolean): Promise<void> {
  const toggle = $<HTMLInputElement>('#weixin-notify-enabled')
  if (toggle) toggle.disabled = true
  try {
    const data = await api<WeixinNotifyPayload>('/mobile/api/v1/admin/weixin/notify', {
      method: 'POST',
      body: { enabled },
    })
    renderWeixinNotify(data)
    toast(enabled ? '已开启跨会话推送' : '已关闭跨会话推送', 'ok')
  } catch (error) {
    toast(errorMessage(error))
    if (toggle) toggle.disabled = false
    await loadWeixinNotify()
  }
}

async function saveWeixinNotifyPolicy(): Promise<void> {
  const button = $<HTMLButtonElement>('#weixin-notify-save-policy')
  const read = (selector: string): number => Math.round(Number($<HTMLInputElement>(selector)?.value))
  const debounce = read('#weixin-notify-debounce')
  const perSession = read('#weixin-notify-per-session')
  const globalInterval = read('#weixin-notify-global')
  const maxPerHour = read('#weixin-notify-max')
  if (
    !Number.isFinite(debounce) || debounce < 3 || debounce > 30 ||
    !Number.isFinite(perSession) || perSession < 10 || perSession > 300 ||
    !Number.isFinite(globalInterval) || globalInterval < 5 || globalInterval > 120 ||
    !Number.isFinite(maxPerHour) || maxPerHour < 5 || maxPerHour > 100
  ) {
    toast('请填写有效的推送节奏参数')
    return
  }
  try {
    const data = await withBusy(button, '保存中…', () =>
      api<WeixinNotifyPayload>('/mobile/api/v1/admin/weixin/notify', {
        method: 'POST',
        body: {
          debounceMs: debounce * 1000,
          perSessionIntervalMs: perSession * 1000,
          globalIntervalMs: globalInterval * 1000,
          maxPerHour,
        },
      }),
    )
    renderWeixinNotify(data)
    toast('推送节奏已保存，立即生效', 'ok')
  } catch (error) {
    toast(errorMessage(error))
  }
}

async function approveWeixin(approve: boolean): Promise<void> {
  clearWeixinPoll()
  const button = $<HTMLButtonElement>(approve ? '#weixin-approve' : '#weixin-deny')
  try {
    const data = await withBusy(button, approve ? '连接中…' : '拒绝中…', () =>
      api<WeixinPayload>('/mobile/api/v1/admin/weixin/approve', {
        method: 'POST',
        body: { approve },
      }),
    )
    renderWeixin(data)
    toast(approve ? '已允许微信连接' : '已拒绝该微信连接请求', approve ? 'ok' : undefined)
  } catch (error) {
    toast(errorMessage(error))
    await loadWeixinStatus()
  }
}

async function logoutWeixin(): Promise<void> {
  clearWeixinPoll()
  try {
    const data = await withBusy($<HTMLButtonElement>('#weixin-logout'), '断开中…', () =>
      api<WeixinPayload>('/mobile/api/v1/admin/weixin/logout', { method: 'POST' }),
    )
    renderWeixin(data)
    toast('已断开微信连接', 'ok')
  } catch (error) {
    toast(errorMessage(error))
  }
}

async function rebindWeixin(): Promise<void> {
  const confirmed = await openModal({
    title: '换绑微信',
    eyebrow: 'WECHAT',
    body: el('div', { class: 'weixin-rebind-body' }, [
      el('p', { text: '换绑会断开当前微信，并重置微信专用的 DSH 会话。' }),
      el('p', { class: 'hint', text: '旧微信号之后不会再收到 DSH 回复；新号扫码确认后会自动连接。' }),
    ]),
    confirmText: '继续换绑',
    danger: true,
    onConfirm: async () => true,
  })
  if (!confirmed) return
  clearWeixinPoll()
  try {
    const data = await withBusy($<HTMLButtonElement>('#weixin-rebind'), '换绑中…', async () => {
      await api<WeixinPayload>('/mobile/api/v1/admin/weixin/logout', { method: 'POST' })
      return api<WeixinPayload>('/mobile/api/v1/admin/weixin/login', { method: 'POST' })
    })
    renderWeixin(data)
    if (data.state === 'wait' || data.state === 'scaned') scheduleWeixinPoll()
    toast('请用新的微信扫码并确认', 'ok')
  } catch (error) {
    toast(errorMessage(error))
    await loadWeixinStatus()
  }
}

// ---------------------------------------------------------------------------
// WeChat sub-sections (连接 / 推送 / 审批)
// ---------------------------------------------------------------------------

function setWeixinSection(section: WeixinSection): void {
  for (const button of $$<HTMLButtonElement>('.weixin-subnav [data-wx-section]')) {
    const active = button.dataset.wxSection === section
    button.classList.toggle('active', active)
    button.setAttribute('aria-selected', String(active))
  }
  for (const panel of $$<HTMLElement>('.wx-section')) {
    panel.classList.toggle('active', panel.dataset.wxPanel === section)
  }
  if (section === 'push') void loadWeixinNotify()
  if (section === 'approve') void loadWeixinApprovals()
}

function initWeixinSections(): void {
  const nav = $('.weixin-subnav')
  if (!nav) return
  nav.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest<HTMLButtonElement>('[data-wx-section]')
    const section = button?.dataset.wxSection as WeixinSection | undefined
    if (!section) return
    setWeixinSection(section)
  })
  setWeixinSection('connect')
}

// ---------------------------------------------------------------------------
// Audit export (GET /admin/audit → JSON Blob download)
// ---------------------------------------------------------------------------

async function exportAudit(): Promise<void> {
  const button = $<HTMLButtonElement>('#export-audit')
  const action = $<HTMLInputElement>('#audit-action')?.value.trim() ?? ''
  const sinceMs = Number($<HTMLSelectElement>('#audit-since')?.value ?? 0)
  const params = new URLSearchParams({ limit: '500' })
  if (action) params.set('action', action)
  if (Number.isFinite(sinceMs) && sinceMs > 0) params.set('since', String(Date.now() - sinceMs))
  try {
    const data = await withBusy(button, '导出中…', () =>
      api<AuditPayload>(`/mobile/api/v1/admin/audit?${params.toString()}`),
    )
    const entries = data.entries ?? []
    const payload = {
      exportedAt: new Date().toISOString(),
      action: action || null,
      sinceMs: Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : null,
      total: data.total ?? entries.length,
      entries,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const href = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = `dsh-audit-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(href), 0)
    setText('#audit-export-status', `已导出 ${entries.length} 条 · ${new Date().toLocaleTimeString()}`)
    toast(`已导出 ${entries.length} 条审计记录`, 'ok')
  } catch (error) {
    setText('#audit-export-status', '导出失败')
    if (!weixinGatewayUnavailable(error)) toast(errorMessage(error) || '导出失败')
    else toast('当前网关未加载审计接口，重启 dsh web 后重试')
  }
}

// ---------------------------------------------------------------------------
// Key rotation (二次确认 + POST /admin/key/rotate)
// ---------------------------------------------------------------------------

function renderKeyState(data: KeyRotatePayload): void {
  const kid = data.activeKid || '-'
  setText('#key-active-kid', kid)
  setText('#key-active-badge', kid !== '-' ? `活动 ${kid}` : '-')
  const list = $('#key-id-list')
  if (!list) return
  const ids = data.keyIds ?? (kid !== '-' ? [kid] : [])
  list.replaceChildren()
  if (ids.length === 0) {
    list.append(el('span', { class: 'muted', text: '未知' }))
    return
  }
  for (const id of ids) {
    list.append(el('span', {
      class: `key-chip ${id === data.activeKid ? 'active' : ''}`.trim(),
      text: id,
    }))
  }
}

async function rotateKey(): Promise<void> {
  const input = el('input', {
    type: 'text',
    placeholder: '输入 ROTATE 确认',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': '输入 ROTATE 确认轮换密钥',
  }) as HTMLInputElement
  const body = el('div', { class: 'rotate-key-body' }, [
    el('p', { html: '轮换会生成新的会话签名与凭证加密密钥，<strong>已签发的设备可能需要重新配对</strong>。' }),
    el('p', { class: 'hint', text: '旧密钥仍保留用于解密与验签（最多 5 个）；操作会写入审计日志，不会记录密钥内容。' }),
    el('label', { class: 'field' }, [el('span', { text: '输入 ROTATE 继续' }), input]),
  ])
  await openModal({
    title: '轮换密钥',
    eyebrow: 'DANGER',
    body,
    confirmText: '轮换密钥',
    danger: true,
    onConfirm: async () => {
      if (input.value.trim().toUpperCase() !== 'ROTATE') {
        toast('请输入 ROTATE 以确认轮换')
        return false
      }
      try {
        const data = await withBusy($<HTMLButtonElement>('#rotate-key'), '轮换中…', () =>
          api<KeyRotatePayload>('/mobile/api/v1/admin/key/rotate', { method: 'POST' }),
        )
        renderKeyState(data)
        const notice = $('#key-rotate-notice')
        if (notice) {
          notice.hidden = false
          notice.textContent = `密钥已轮换：活动密钥 ${data.activeKid || '-'}，共 ${(data.keyIds ?? []).length} 个密钥。`
            + `旧设备可能需要重新配对${data.pairingInvalidated ? '；当前配对码已失效，请重新生成' : ''}。`
        }
        setText('#key-rotate-status', `已轮换 · ${new Date().toLocaleTimeString()}`)
        toast('密钥已轮换，旧设备可能需要重新配对', 'ok')
        return true
      } catch (error) {
        toast(errorMessage(error) || '轮换失败')
        return false
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Runtime switches (settings tab): tunnel/weixin/log level/proxy timeout
// ---------------------------------------------------------------------------

const RUNTIME_LOG_LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error']
let runtimeSettingsReady = false

function setRuntimeSettingsAvailable(available: boolean, message = ''): void {
  runtimeSettingsReady = available
  const notice = $('#runtime-settings-notice')
  if (notice) {
    notice.hidden = available || !message
    notice.textContent = message
  }
  for (const selector of ['#runtime-tunnel-enabled', '#runtime-weixin-enabled', '#runtime-log-level', '#runtime-proxy-timeout', '#save-runtime-settings']) {
    const node = $<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(selector)
    if (node) node.disabled = !available
  }
  setText('#runtime-settings-badge', available ? '可运行' : '未加载')
}

function runtimeFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    tunnelEnabled: '隧道开关',
    weixinEnabled: '微信开关',
    logLevel: '日志级别',
    proxyRequestTimeoutMs: '代理超时',
    'tunnel.enabled': '隧道开关',
    'weixin.enabled': '微信开关',
    'log.level': '日志级别',
    'proxy.requestTimeoutMs': '代理超时',
  }
  return labels[field] ?? field
}

function renderRestartRequired(fields: string[] | undefined): void {
  if (!runtimeSettingsReady) return
  const notice = $('#runtime-settings-notice')
  const hint = $('#runtime-restart-hint')
  const required = (fields ?? []).filter(Boolean)
  if (notice && required.length > 0) {
    notice.hidden = false
    notice.textContent = `以下运行设置需要重启 dsh web 后完全生效：${required.map(runtimeFieldLabel).join('、')}`
  } else if (notice) {
    notice.hidden = true
    notice.textContent = ''
  }
  if (hint) {
    hint.textContent = required.length > 0
      ? '已保存并持久化到 admin-settings.json；重启 dsh web 后全部生效。'
      : '保存后立即生效；持久化到 admin-settings.json，下次启动仍生效。'
  }
}

function renderRuntimeSettings(settings: SettingsPayload): void {
  const runtime = settings.runtime
  if (!runtime) {
    setRuntimeSettingsAvailable(false, '当前运行的 dsh 进程尚未加载运行开关接口。请重启一次 dsh web，然后刷新本页。')
    renderRestartRequired([])
    return
  }
  setRuntimeSettingsAvailable(true)
  const tunnel = $<HTMLInputElement>('#runtime-tunnel-enabled')
  const weixin = $<HTMLInputElement>('#runtime-weixin-enabled')
  const level = $<HTMLSelectElement>('#runtime-log-level')
  const timeout = $<HTMLInputElement>('#runtime-proxy-timeout')
  if (tunnel) tunnel.checked = runtime.tunnelEnabled !== false
  if (weixin) weixin.checked = runtime.weixinEnabled !== false
  if (level) {
    const value = String(runtime.logLevel || 'info')
    level.value = RUNTIME_LOG_LEVELS.includes(value) ? value : 'info'
  }
  if (timeout) {
    const ms = Number(runtime.proxyRequestTimeoutMs)
    timeout.value = String(Number.isFinite(ms) ? Math.max(0, Math.trunc(ms)) : 0)
  }
  renderRestartRequired(settings.restartRequired)
}

function setRuntimeSettingsStatus(text: string, ok: boolean): void {
  const node = $('#runtime-settings-status')
  if (!node) return
  node.textContent = text
  node.classList.toggle('ok', ok)
  node.classList.toggle('bad', !ok)
}

async function saveRuntimeSettings(): Promise<void> {
  const tunnel = $<HTMLInputElement>('#runtime-tunnel-enabled')
  const weixin = $<HTMLInputElement>('#runtime-weixin-enabled')
  const level = $<HTMLSelectElement>('#runtime-log-level')
  const timeoutInput = $<HTMLInputElement>('#runtime-proxy-timeout')
  const rawTimeout = Number(timeoutInput?.value)
  if (!Number.isFinite(rawTimeout) || rawTimeout < 0 || rawTimeout > 3_600_000) {
    setRuntimeSettingsStatus('代理超时需在 0–3600000 ms 之间', false)
    toast('代理超时需在 0–3600000 ms 之间')
    return
  }
  const body = {
    tunnelEnabled: Boolean(tunnel?.checked),
    weixinEnabled: Boolean(weixin?.checked),
    logLevel: RUNTIME_LOG_LEVELS.includes(level?.value ?? '') ? String(level?.value) : 'info',
    proxyRequestTimeoutMs: Math.trunc(rawTimeout),
  }
  try {
    const settings = await withBusy($<HTMLButtonElement>('#save-runtime-settings'), '保存中…', () =>
      api<SettingsPayload>('/mobile/api/v1/admin/settings', { method: 'POST', body }),
    )
    renderRuntimeSettings(settings)
    setRuntimeSettingsStatus(`已保存 · ${new Date().toLocaleTimeString()}`, true)
    toast('运行开关已保存，立即生效', 'ok')
    // Tunnel/weixin switches change live status; refresh the surfaces that show it.
    await Promise.allSettled([loadOverview(), loadPairing()])
  } catch (error) {
    const code = gatewayErrorCode(error)
    if (code === 1008 || code === 404) {
      setRuntimeSettingsAvailable(false, '当前运行的 dsh 进程尚未加载运行开关接口。请重启一次 dsh web，然后刷新本页。')
      return
    }
    setRuntimeSettingsStatus(errorMessage(error) || '保存失败', false)
    toast(errorMessage(error) || '保存失败')
  }
}

async function loadSettings(): Promise<void> {
  try {
    const settings = await api<SettingsPayload>('/mobile/api/v1/admin/settings')
    setSettingsAvailable(true)
    const limits = settings.limits ?? { sessionMin: 300, sessionMax: 90 * 86400, pairingMin: 30, pairingMax: 86400 }
    state.settingsLimits = limits
    const daysInput = $<HTMLInputElement>('#setting-session-days')
    const minutesInput = $<HTMLInputElement>('#setting-pairing-minutes')
    if (daysInput) {
      daysInput.value = String(Number((settings.sessionMaxAge / 86400).toFixed(2)))
      daysInput.min = String(Number((limits.sessionMin / 86400).toFixed(4)))
      daysInput.max = String(Math.round(limits.sessionMax / 86400))
    }
    if (minutesInput) {
      minutesInput.value = String(Number((settings.pairingTokenExpiry / 60).toFixed(1)))
      minutesInput.min = String(Math.ceil(limits.pairingMin / 60))
      minutesInput.max = String(Math.floor(limits.pairingMax / 60))
    }
    setText('#hint-session', `允许 ${formatSessionDuration(limits.sessionMin)} – ${formatSessionDuration(limits.sessionMax)}`)
    setText('#hint-pairing', `允许 ${formatPairingDuration(limits.pairingMin)} – ${formatPairingDuration(limits.pairingMax)}`)
    setText('#current-session', formatSessionDuration(settings.sessionMaxAge))
    setText('#current-pairing', formatPairingDuration(settings.pairingTokenExpiry))
    clearSettingsErrors()
    setSettingsStatus('', true)
    renderRuntimeSettings(settings)
  } catch (error) {
    const code = gatewayErrorCode(error)
    if (code === 1008 || code === 404) {
      setSettingsAvailable(false, '当前运行的 dsh 进程尚未加载设置接口。请重启一次 dsh web，然后刷新本页。')
      setRuntimeSettingsAvailable(false, '当前运行的 dsh 进程尚未加载运行开关接口。请重启一次 dsh web，然后刷新本页。')
      return
    }
    toast(errorMessage(error) || '读取设置失败')
  }
}

function validateSettings(): { sessionMaxAge: number; pairingTokenExpiry: number } | null {
  clearSettingsErrors()
  const limits = state.settingsLimits ?? { sessionMin: 300, sessionMax: 90 * 86400, pairingMin: 30, pairingMax: 86400 }
  const days = Number($<HTMLInputElement>('#setting-session-days')?.value)
  const minutes = Number($<HTMLInputElement>('#setting-pairing-minutes')?.value)
  let ok = true
  if (!Number.isFinite(days) || days <= 0) {
    setFieldError('session', '请输入有效的天数')
    ok = false
  }
  const sessionMaxAge = Math.round(days * 86400)
  if (ok && (sessionMaxAge < limits.sessionMin || sessionMaxAge > limits.sessionMax)) {
    setFieldError('session', `需在${formatSessionDuration(limits.sessionMin)}到${formatSessionDuration(limits.sessionMax)}之间`)
    ok = false
  }
  if (!Number.isFinite(minutes) || minutes <= 0) {
    setFieldError('pairing', '请输入有效的分钟数')
    ok = false
  }
  const pairingTokenExpiry = Math.round(minutes * 60)
  if (ok && (pairingTokenExpiry < limits.pairingMin || pairingTokenExpiry > limits.pairingMax)) {
    setFieldError('pairing', `需在${formatPairingDuration(limits.pairingMin)}到${formatPairingDuration(limits.pairingMax)}之间`)
    ok = false
  }
  if (!ok) return null
  return { sessionMaxAge, pairingTokenExpiry }
}

async function saveSettings(): Promise<void> {
  const values = validateSettings()
  if (!values) {
    setSettingsStatus('请修正标红的字段', false)
    return
  }
  try {
    await withBusy($<HTMLButtonElement>('#save-settings'), '保存中…', async () => {
      await api('/mobile/api/v1/admin/settings', { method: 'POST', body: values })
      await loadSettings()
      setSettingsStatus(`已保存 · ${new Date().toLocaleTimeString()}`, true)
      toast('设置已保存，立即生效', 'ok')
      if (state.activeTab === 'pair') await loadPairing()
    })
  } catch (error) {
    const code = gatewayErrorCode(error)
    if (code === 1008 || code === 404) {
      setSettingsAvailable(false, '当前运行的 dsh 进程尚未加载设置接口。请重启一次 dsh web，然后刷新本页。')
      return
    }
    setSettingsStatus(errorMessage(error) || '保存失败', false)
    toast(errorMessage(error) || '保存失败')
  }
}

async function resetSettings(): Promise<void> {
  const confirmed = await openModal({
    title: '恢复默认设置',
    eyebrow: 'SETTINGS',
    body: el('p', { text: '将登录会话恢复为 24 小时、配对码有效期恢复为 15 分钟，并立即保存。' }),
    confirmText: '恢复默认',
    onConfirm: async () => true,
  })
  if (!confirmed) return
  const daysInput = $<HTMLInputElement>('#setting-session-days')
  const minutesInput = $<HTMLInputElement>('#setting-pairing-minutes')
  if (daysInput) daysInput.value = '1'
  if (minutesInput) minutesInput.value = '15'
  await saveSettings()
}

let refreshAllInFlight = false

async function refreshAll() {
  if (refreshAllInFlight) return
  refreshAllInFlight = true
  try {
    await Promise.allSettled([loadOverview(), loadPairing()])
    if (state.activeTab === 'devices') await loadDevices()
    if (state.activeTab === 'logs') await loadLogs()
    if (state.activeTab === 'settings') await loadSettings()
    if (state.activeTab === 'weixin') {
      await loadWeixinStatus()
      await loadWeixinNotify()
      await loadWeixinApprovals()
    }
  } finally {
    refreshAllInFlight = false
  }
}

async function tunnelAction(action: 'start' | 'stop' | 'restart'): Promise<void> {
  const button = { start: $<HTMLButtonElement>('#tunnel-start'), stop: $<HTMLButtonElement>('#tunnel-stop'), restart: $<HTMLButtonElement>('#tunnel-restart') }[action]
  try {
    await withBusy(button ?? null, '处理中…', async () => {
      await api(`/mobile/api/v1/admin/tunnel/${action}`, { method: 'POST' })
      toast(`${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}隧道成功`, 'ok')
      await Promise.allSettled([loadDeepHealth(), loadPairing()])
    })
  } catch (error) {
    toast(errorMessage(error))
  }
}

const THEME_KEY = 'dsh-theme'
const LEGACY_THEME_KEY = 'dsh-admin-theme'

function applyTheme(theme: string | null | undefined): void {
  const next = theme === 'light' ? 'light' : 'dark'
  document.body.dataset.theme = next
  document.documentElement.style.colorScheme = next
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta) meta.content = next === 'light' ? '#f4f5f7' : '#101113'
  const use = $('#theme-toggle use')
  if (use) use.setAttribute('href', next === 'light' ? '#i-moon' : '#i-sun')
  try { localStorage.setItem(THEME_KEY, next) } catch { /* storage may be blocked */ }
}

try {
  const forcedTheme = new URLSearchParams(location.search).get('theme')
  let savedTheme: string
  if (forcedTheme === 'light' || forcedTheme === 'dark') {
    savedTheme = forcedTheme
  } else {
    const shared = localStorage.getItem(THEME_KEY)
    const legacy = localStorage.getItem(LEGACY_THEME_KEY)
    savedTheme = shared === 'light' || shared === 'dark' ? shared : legacy === 'light' ? 'light' : 'dark'
  }
  applyTheme(savedTheme)
} catch { applyTheme('dark') }

$('#theme-toggle')?.addEventListener('click', () => {
  applyTheme(document.body.dataset.theme === 'light' ? 'dark' : 'light')
})

const SIDEBAR_KEY = 'dsh-admin-sidebar'
const shell = document.querySelector<HTMLElement>('.app-shell')

function applySidebar(collapsed: boolean, persist = true): void {
  if (!shell) return
  shell.classList.toggle('sidebar-collapsed', collapsed)
  const label = collapsed ? '展开侧栏' : '收起侧栏'
  for (const selector of ['#sidebar-toggle', '#brand-toggle']) {
    const button = $(selector)
    if (!button) continue
    button.setAttribute('aria-expanded', String(!collapsed))
    button.setAttribute('aria-label', label)
    button.setAttribute('title', label)
  }
  if (!persist) return
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded') } catch { /* storage may be blocked */ }
}

try {
  const params = new URLSearchParams(location.search)
  const forced = params.get('sidebar')
  const saved = forced === 'collapsed' ? true : forced === 'expanded' ? false : localStorage.getItem(SIDEBAR_KEY) === 'collapsed'
  applySidebar(saved, false)
} catch {
  applySidebar(false, false)
}

for (const selector of ['#sidebar-toggle', '#brand-toggle']) {
  $(selector)?.addEventListener('click', () => {
    applySidebar(!shell?.classList.contains('sidebar-collapsed'))
  })
}

$('#copy-url')?.addEventListener('click', async () => {
  const url = lastTunnelInfo?.url || lastTunnelInfo?.publicBase
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
    toast('公网地址已复制', 'ok')
  } catch {
    toast(url)
  }
})

$('#refresh')?.addEventListener('click', () => void refreshAll())
$('#go-pair')?.addEventListener('click', () => activate('pair'))
$('#refresh-devices')?.addEventListener('click', () => void loadDevices())
$('#refresh-logs')?.addEventListener('click', () => void loadLogs())
$('#log-filters')?.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const chip = target.closest<HTMLButtonElement>('.filter-chip')
  const level = chip?.dataset.level as LogLevelFilter | undefined
  if (!level || !LOG_LEVEL_FILTERS.includes(level)) return
  state.logLevel = level
  renderLogs()
})
$('#log-search')?.addEventListener('input', (event) => {
  state.logQuery = (event.target as HTMLInputElement).value.trim()
  renderLogs()
})
$('#log-auto')?.addEventListener('change', (event) => {
  state.logAuto = (event.target as HTMLInputElement).checked
  renderLogs()
})
$('#device-filters')?.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const chip = target.closest<HTMLButtonElement>('.filter-chip')
  const filter = chip?.dataset.filter
  if (!filter || !DEVICE_FILTERS.includes(filter as DeviceFilter)) return
  state.deviceFilter = filter as DeviceFilter
  renderDevices()
})
$('#device-select-all')?.addEventListener('click', () => toggleSelectAll())
$('#device-select-all-head')?.addEventListener('change', (event) => {
  setVisibleSelection((event.target as HTMLInputElement).checked)
})
$('#batch-revoke')?.addEventListener('click', () => revokeSelectedDevices())
$('#device-purge')?.addEventListener('click', () => void purgeRevokedDevices())
$('#batch-delete')?.addEventListener('click', () => deleteSelectedDevices())
$('#tunnel-start')?.addEventListener('click', () => void tunnelAction('start'))
$('#tunnel-stop')?.addEventListener('click', () => void tunnelAction('stop'))
$('#tunnel-restart')?.addEventListener('click', () => void tunnelAction('restart'))
$('#regenerate')?.addEventListener('click', () => void regeneratePairing(false))
$('#copy')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.pairingUrl)
    toast('已复制', 'ok')
  } catch {
    toast(state.pairingUrl)
  }
})

function bindCollapsiblePanel(panelId: string, buttonId: string): void {
  const panel = $(`#${panelId}`)
  const button = $(`#${buttonId}`)
  if (!panel || !button) return
  button.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('is-collapsed')
    button.setAttribute('aria-expanded', String(!collapsed))
    button.setAttribute('title', collapsed ? '展开' : '折叠')
  })
}

bindCollapsiblePanel('weixin-history-panel', 'weixin-history-collapse')
bindCollapsiblePanel('weixin-approval-panel', 'weixin-approval-collapse')
initWeixinSections()

// Overview: compact status chips, anomaly/capability hints, diagnostics shortcuts.
$('#overview-alert-diagnostics')?.addEventListener('click', openDiagnostics)
$('#overview-status-chips')?.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const chip = target.closest<HTMLButtonElement>('.status-chip')
  if (chip?.dataset.state === 'bad') openDiagnostics()
})
$('#help-diagnostics-details')?.addEventListener('toggle', (event) => {
  const details = event.target as HTMLDetailsElement
  if (details.open) void loadDeepHealth()
})
$('#deep-health-refresh')?.addEventListener('click', () => void loadDeepHealth())
$('#capability-refresh')?.addEventListener('click', () => void loadDeepHealth())
$('#help-refresh')?.addEventListener('click', () => void loadDeepHealth())
$('#export-audit')?.addEventListener('click', () => void exportAudit())
$('#rotate-key')?.addEventListener('click', () => void rotateKey())
$('#weixin-owner-rebind')?.addEventListener('click', () => void rebindWeixin())
$('#tunnel-change-dismiss')?.addEventListener('click', hideTunnelChangeBanner)
$('#tunnel-change-go')?.addEventListener('click', () => activate('pair'))
$('#help-go-overview')?.addEventListener('click', () => activate('overview'))
$('#help-go-weixin')?.addEventListener('click', () => activate('weixin'))
$('#help-go-pair')?.addEventListener('click', () => activate('pair'))
$('#help-go-settings')?.addEventListener('click', () => activate('settings'))
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  if (state.activeTab === 'pair') void loadPairing()
  else if (state.activeTab === 'overview') void loadOverview()
})

$('#save-settings')?.addEventListener('click', () => void saveSettings())
$('#reset-settings')?.addEventListener('click', () => void resetSettings())
$('#save-runtime-settings')?.addEventListener('click', () => void saveRuntimeSettings())
$('#connection-retry')?.addEventListener('click', () => { void refreshAll() })
onConnectionChange(renderConnectionBanner)
$('#weixin-login')?.addEventListener('click', () => void startWeixinLogin())
$('#weixin-approve')?.addEventListener('click', () => void approveWeixin(true))
$('#weixin-deny')?.addEventListener('click', () => void approveWeixin(false))
$('#weixin-rebind')?.addEventListener('click', () => void rebindWeixin())
$('#weixin-logout')?.addEventListener('click', () => void logoutWeixin())
$('#weixin-refresh')?.addEventListener('click', () => void loadWeixinStatus())
$('#weixin-notify-refresh')?.addEventListener('click', () => void loadWeixinNotify())
$('#weixin-notify-save-policy')?.addEventListener('click', () => void saveWeixinNotifyPolicy())
for (const selector of ['#weixin-notify-debounce', '#weixin-notify-per-session', '#weixin-notify-global', '#weixin-notify-max']) {
  $(selector)?.addEventListener('input', updateWeixinPolicyOutputs)
}
$('#weixin-notify-toggle')?.addEventListener('click', () => {
  weixinHistoryExpanded = !weixinHistoryExpanded
  const history = $('#weixin-notify-history')
  history?.classList.toggle('is-collapsed', !weixinHistoryExpanded)
  const toggle = $<HTMLButtonElement>('#weixin-notify-toggle')
  if (toggle) toggle.textContent = weixinHistoryExpanded ? '收起' : '展开全部'
})
$('#weixin-approval-refresh')?.addEventListener('click', () => void loadWeixinApprovals())
$('#weixin-notify-enabled')?.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement
  void setWeixinNotifyEnabled(target.checked)
})
$('#settings-form')?.addEventListener('submit', (event) => {
  event.preventDefault()
  void saveSettings()
})
for (const selector of ['#setting-session-days', '#setting-pairing-minutes']) {
  $(selector)?.addEventListener('input', () => clearSettingsErrors())
}

const initialTab = location.hash.slice(1)
activate(['overview', 'pair', 'weixin', 'devices', 'logs', 'settings', 'help'].includes(initialTab) ? (initialTab as TabName) : 'overview')
setInterval(tickPairing, 1000)
setInterval(tickUptime, 1000)
setInterval(() => {
  if (state.activeTab === 'logs' && state.logAuto) void loadLogs()
}, 10_000)
setInterval(() => {
  // Overview polls health + activity (KPI cards and the 7-day chart).
  if (state.activeTab === 'overview') void loadOverview()
  else if (state.activeTab === 'pair') void loadPairing()
  else if (state.activeTab === 'devices') {
    const list = $('#device-list')
    const busy = document.querySelector('dialog.modal[open]') !== null ||
      state.selectedDeviceIds.size > 0 ||
      Boolean(list && list.contains(document.activeElement))
    if (!busy) void loadDevices()
  }
}, 30_000)
