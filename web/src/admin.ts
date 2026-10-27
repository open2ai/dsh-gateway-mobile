import { $, $$, api, applyI18n, el, formatTime, setText, toast } from './common'

applyI18n()

type TabName = 'overview' | 'pair' | 'weixin' | 'devices' | 'logs' | 'settings'
type DeviceFilter = 'all' | 'online' | 'offline' | 'revoked'

interface TunnelInfo {
  connected?: boolean
  state?: string
  url?: string
  publicBase?: string
  protocol?: string
  uptime?: number
  attempts?: number
  lastError?: string
}

interface GatewayInfo {
  version?: string
}

interface LogEntry {
  timestamp: string
  level: string
  message: string
}

interface StatusPayload {
  tunnel?: TunnelInfo
  gateway?: GatewayInfo
  activeDevices?: number
  onlineDevices?: number
  logs?: LogEntry[]
}

interface StatsDay {
  date: string
  requests: number
}

interface StatsPayload {
  todayRequests?: number
  windowRequests?: number
  daily?: StatsDay[]
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

interface PairingPayload {
  pairingUrl?: string
  expiresIn?: number
  code?: string
  qrSvg?: string
  tunnel?: TunnelInfo
}

interface SettingsPayload {
  sessionMaxAge: number
  pairingTokenExpiry: number
  limits?: SettingsLimits
}

interface WeixinPayload {
  enabled: boolean
  connected: boolean
  state: 'idle' | 'wait' | 'scaned' | 'pending' | 'confirmed' | 'expired' | 'error'
  qrcode?: string
  qrUrl?: string
  qrSvg?: string
  accountId?: string
  pendingUserId?: string
  lastError?: string
  cursor?: string
  received?: number
}

interface WeixinNotifyPayload {
  enabled: boolean
  debounceMs: number
  perSessionIntervalMs: number
  globalIntervalMs: number
  maxPerHour: number
  recent: Array<{ at: number; count: number; text: string }>
}

interface WeixinApprovalEntry {
  at: number
  id: string
  sessionId: string
  toolName: string
  reason: string
  status: 'pending' | 'allowed' | 'rejected' | 'timeout' | 'cancelled' | 'unavailable'
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
  status: StatusPayload | null
  stats: StatsPayload | null
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
  status: null,
  stats: null,
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
  overview: ['概览', '网关与隧道运行状态'],
  pair: ['配对', '添加一台新的移动设备'],
  weixin: ['微信', 'ClawBot/iLink 扫码连接与运行状态'],
  devices: ['设备', '在线设备优先显示，可批量撤销或永久删除记录'],
  logs: ['日志', '最近的运行与审计事件'],
  settings: ['设置', '配对码、设备登录与微信推送'],
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
    if (name === 'settings') void loadWeixinNotify()
    if (name === 'weixin') void loadWeixinStatus()
    if (name === 'weixin') void loadWeixinNotify()
    if (name === 'weixin') void loadWeixinApprovals()
    if (name !== 'weixin') clearWeixinPoll()
    if (name === 'overview') void loadOverview()
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
    if (['overview', 'pair', 'weixin', 'devices', 'logs', 'settings'].includes(name)) activate(name as TabName)
  })
}

const activate = createTabController()
bindHash()

async function loadOverview(): Promise<void> {
  try {
    const [status, stats, logs, deviceList] = await Promise.all([
      api<StatusPayload>('/mobile/api/v1/status'),
      api<StatsPayload>('/mobile/api/v1/admin/stats?days=7'),
      api<{ logs?: LogEntry[] }>('/mobile/api/v1/logs?limit=100'),
      api<{ devices?: Device[] }>('/mobile/api/v1/devices?all=1'),
    ])
    state.status = status
    state.stats = stats
    state.logs = logs.logs ?? []
    const tunnel = status.tunnel ?? {}
    const connected = Boolean(tunnel.connected)
    const startButton = $<HTMLButtonElement>('#tunnel-start')
    const stopButton = $<HTMLButtonElement>('#tunnel-stop')
    const starting = tunnel.state === 'starting'
    if (startButton) startButton.hidden = connected
    if (stopButton) stopButton.hidden = !connected && !starting
    const pairHint = $('#pair-hint')
    if (pairHint) {
      pairHint.textContent = connected ? '' : '隧道未连接：当前二维码只指向 127.0.0.1，手机无法打开。请先启动隧道。'
    }
    setChip('tunnel-chip', tunnelStateLabel(tunnel.state), Boolean(tunnel.connected))
    setText('#tunnel-url', tunnel.url || tunnel.publicBase || '-')
    const copyUrlButton = $<HTMLButtonElement>('#copy-url')
    if (copyUrlButton) copyUrlButton.disabled = !tunnel.url
    setText('#tunnel-meta', tunnel.protocol || '-')
    setText('#tunnel-uptime', formatUptime(tunnel.uptime))
    startUptime(tunnel.uptime)
    setText('#tunnel-hint', tunnel.connected ? '' : tunnel.lastError || '隧道未连接：二维码只在电脑本机有效。')
    const registered = deviceList.devices ?? []
    const inactive = registered.filter((device) => isDeviceInactive(device)).length
    const active = status.activeDevices ?? registered.length - inactive
    setText('#metric-active', String(active))
    setText('#metric-active-foot', `共 ${registered.length} 台 · ${inactive} 台已撤销/过期`)
    setText('#metric-online', String(status.onlineDevices ?? '-'))
    setText('#metric-today', String(stats.todayRequests ?? '-'))
    setText('#metric-version', status.gateway?.version || '-')
    renderSpark(stats)
    renderLogPreview()
    try {
      const wx = await api<WeixinPayload>('/mobile/api/v1/admin/weixin')
      const received = typeof wx.received === 'number' ? `${wx.received} 条` : '-'
      if (!wx.enabled) {
        setChip('overview-weixin-chip', '未启用', false)
        setText('#overview-weixin-account', '微信通道未启用')
        setText('#overview-weixin-received', '-')
      } else if (wx.connected) {
        setChip('overview-weixin-chip', '已连接', true)
        setText('#overview-weixin-account', wx.accountId ? `Bot：${wx.accountId}` : '微信 Bot 已连接')
        setText('#overview-weixin-received', received)
      } else {
        setChip('overview-weixin-chip', '未连接', false)
        setText('#overview-weixin-account', '微信 Bot 未连接')
        setText('#overview-weixin-received', '-')
      }
    } catch {
      setChip('overview-weixin-chip', '不可用', false)
      setText('#overview-weixin-account', '当前网关未加载微信接口')
      setText('#overview-weixin-received', '-')
    }
  } catch (error) {
    const message = errorMessage(error) || '加载失败'
    toast(message)
    setText('#tunnel-hint', `概览加载失败：${message}（点右上角刷新重试）`)
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
  if (state.activeTab !== 'overview' || !uptimeSnapshot) return
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

function renderLogPreview() {
  const container = $('#log-preview')
  if (!container) return
  container.replaceChildren()
  const entries = (state.status?.logs ?? state.logs ?? []).filter((entry) => entry.level !== 'debug').slice(-5)
  if (entries.length === 0) {
    container.append(el('p', { class: 'muted', text: '暂无日志' }))
    return
  }
  for (const entry of entries) {
    container.append(
      el('div', { class: 'log-line' }, [
        el('span', { class: `log-level ${entry.level}`, text: entry.level }),
        el('span', { class: 'log-message', text: entry.message }),
        el('span', { class: 'log-time', text: new Date(entry.timestamp).toLocaleTimeString() }),
      ]),
    )
  }
}

async function loadPairing(): Promise<void> {
  try {
    const data = await api<PairingPayload>('/mobile/api/v1/admin/pairing')
    state.pairingUrl = data.pairingUrl || ''
    state.expiresAt = Date.now() + (data.expiresIn ?? 0) * 1000
    state.ttlSeconds = data.expiresIn || 900
    setText('#pairing-code', data.code || '----')
    setText('#pairing-url', data.pairingUrl || '')
    const connected = Boolean(data.tunnel?.connected)
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
    tickPairing()
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
    state.status = state.status ?? {}
    state.status.logs = state.logs
    renderLogs()
    renderLogPreview()
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
  if (qr) {
    qr.hidden = data.state === 'pending' || !svg
    qr.innerHTML = svg
  }
  if (login) {
    login.hidden = Boolean(data.connected) || data.state === 'pending'
    login.disabled = !data.enabled
    login.textContent = data.state === 'expired' || data.state === 'error' ? '重新获取二维码' : '获取二维码'
  }
  if (logout) logout.hidden = !data.connected
  if (rebind) rebind.hidden = !data.connected
  if (approve) approve.hidden = data.state !== 'pending'
  if (deny) deny.hidden = data.state !== 'pending'

  if (!data.enabled) {
    if (status) status.textContent = '微信通道未启用'
    if (hint) hint.textContent = '在 gateway-mobile 配置中开启 weixin.enabled 后重启。'
    return
  }
  if (data.connected) {
    if (status) status.textContent = `已连接：${data.accountId || 'WeChat Bot'}`
    if (hint) hint.textContent = '微信 Bot 已连接；扫码账号不在本地记录。换号请点“换绑微信”。'
    return
  }
  if (data.state === 'pending') {
    if (status) status.textContent = '有微信请求连接'
    if (hint) hint.textContent = `扫码账号：${data.pendingUserId || '已隐藏'}。需要本机管理员确认后才保存凭证并连接。`
    return
  }
  const labels: Record<WeixinPayload['state'], string> = {
    idle: '未连接',
    wait: '等待微信扫码…',
    scaned: '已扫码，请在微信中确认',
    pending: '等待本机确认',
    confirmed: '已连接',
    expired: '二维码已过期',
    error: '连接失败',
  }
  if (status) status.textContent = labels[data.state] ?? '未连接'
  if (hint) {
    hint.textContent = data.state === 'error'
      ? data.lastError || '连接失败，请重新获取二维码'
      : data.state === 'expired'
        ? '二维码已过期，请点击“重新获取二维码”。'
        : '用微信扫描二维码登录 ClawBot；扫码后需在本机管理员确认。'
  }
  if ((data.state === 'wait' || data.state === 'scaned') && svg) scheduleWeixinPoll()
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
  } catch (error) {
    const code = gatewayErrorCode(error)
    if (code === 1008 || code === 404) {
      setSettingsAvailable(false, '当前运行的 dsh 进程尚未加载设置接口。请重启一次 dsh web，然后刷新本页。')
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

async function refreshAll() {
  await Promise.allSettled([loadOverview(), loadPairing()])
  if (state.activeTab === 'devices') await loadDevices()
  if (state.activeTab === 'logs') await loadLogs()
  if (state.activeTab === 'settings') await loadSettings()
}

async function tunnelAction(action: 'start' | 'stop' | 'restart'): Promise<void> {
  const button = { start: $<HTMLButtonElement>('#tunnel-start'), stop: $<HTMLButtonElement>('#tunnel-stop'), restart: $<HTMLButtonElement>('#tunnel-restart') }[action]
  try {
    await withBusy(button ?? null, '处理中…', async () => {
      await api(`/mobile/api/v1/admin/tunnel/${action}`, { method: 'POST' })
      toast(`${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}隧道成功`, 'ok')
      await loadOverview()
      await loadPairing()
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
  const url = state.status?.tunnel?.url
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
$('#go-logs')?.addEventListener('click', () => activate('logs'))
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
$('#regenerate')?.addEventListener('click', async () => {
  try {
    const data = await api<PairingPayload>('/mobile/api/v1/admin/pairing/regenerate', { method: 'POST' })
    state.pairingUrl = data.pairingUrl || ''
    state.expiresAt = Date.now() + (data.expiresIn ?? 0) * 1000
    state.ttlSeconds = data.expiresIn || 900
    setText('#pairing-code', data.code || '----')
    setText('#pairing-url', data.pairingUrl || '')
    const qr = $('#qr')
    if (qr) qr.innerHTML = data.qrSvg || ''
    tickPairing()
    toast('已生成新配对码', 'ok')
  } catch (error) {
    toast(errorMessage(error))
  }
})
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

$('#save-settings')?.addEventListener('click', () => void saveSettings())
$('#reset-settings')?.addEventListener('click', () => void resetSettings())
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
activate(['overview', 'pair', 'weixin', 'devices', 'logs', 'settings'].includes(initialTab) ? (initialTab as TabName) : 'overview')
setInterval(tickPairing, 1000)
setInterval(tickUptime, 1000)
setInterval(() => {
  if (state.activeTab === 'logs' && state.logAuto) void loadLogs()
}, 10_000)
setInterval(() => {
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
