/**
 * DSH browser half: the “手机网关” workbench page and its left-sidebar entry.
 *
 * The DSH client module system loads this file as a lazy-CJS factory
 * (`window.__ModuleLoader__.load({ id, factory })`) and mounts it on the root
 * loader row whose specifier is the bare package name. Runtime imports are
 * limited to React and its JSX runtime: everything else (slots, locale) is a
 * Cordis client service injected through `apply`.
 *
 * UI surface, matching the official Plugins/Schedules pages:
 * - `main` keyed panel `gateway-mobile-workbench` renders the page;
 * - `sidebar.panellist` entry with the same id adds the left-rail icon.
 *
 * Data comes from the host bridge under `/api/gateway-mobile/*`. The server
 * decides what this browser may see: `local` in the ping payload tells the page
 * whether it is the machine's own DSH UI (management tabs available) or a
 * paired phone opening the same UI through the tunnel (read-only overview).
 * That flag is a UI hint only; every local-only route is enforced server-side.
 *
 * @module dsh-gateway-mobile/lib/client
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

export const name = 'dsh-gateway-mobile/workbench'
/** Client services this browser half waits for before registering slots. */
export const inject = ['slots', 'locale']

/** Keyed `main` panel id; must equal the `sidebar.panellist` entry id. */
const PANEL_ID = 'gateway-mobile-workbench'
/** Locale namespace for the sidebar label. */
const NS = 'gatewayWorkbench'

interface SlotOptions {
  name: string
  key?: string
  id?: string
  order?: number
  label?: () => string
  locale?: string
}

interface ClientContext {
  effect(callback: () => (() => void) | void, label?: string): unknown
  slots: {
    inject(name: string, callback: () => (() => void) | void): unknown
    register(options: SlotOptions, component: (props: any) => ReactElement | null): () => void
  }
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind(namespace: string): (key: string) => string
  }
}

const DICTIONARIES: Record<string, Record<string, string>> = {
  zh: { panel: '手机网关' },
  en: { panel: 'Mobile Gateway' },
}

type Tab = 'overview' | 'pairing' | 'devices' | 'logs' | 'settings'

interface TunnelView {
  enabled: boolean
  mode: string
  state: string
  connected: boolean
  url: string
  publicBase: string
  protocol: string
  lastError: string
}

interface CapabilityView {
  controller?: boolean
  workspaceRegistry?: boolean
  userQuestions?: boolean
  weixin?: boolean
  tunnel?: { enabled?: boolean; mode?: string }
}

interface PingView {
  ok: boolean
  plugin: string
  version: string
  local: boolean
  serverTime: string
  gateway: {
    origin: string
    port: number
    publicBase: string
    uptime: number
    adminUrl: string
  }
  tunnel: TunnelView
  devices: { active: number; online: number }
  capabilities: CapabilityView
}

interface PairingView {
  code: string
  codeRaw: string
  expiresIn: number
  expiresAt: string
  pairingUrl: string
  qrSvg: string
  tunnel: TunnelView
  status: { valid: boolean; expiresIn: number; used: boolean }
  previousUrl: string
  urlChangedAt: number
}

interface DeviceView {
  deviceId: string
  deviceName: string
  displayName: string
  userAgent: string
  createdAt: string
  lastActiveAt: string
  lastIp: string
  isOnline: boolean
  isCurrent: boolean
  revoked: boolean
  expired: boolean
}

interface LogItem {
  timestamp: string
  level: string
  message: string
}

interface SettingsView {
  version?: string
  sessionMaxAge?: number
  pairingTokenExpiry?: number
  limits?: { sessionMin?: number; sessionMax?: number; pairingMin?: number; pairingMax?: number }
  runtime?: {
    tunnelEnabled?: boolean
    weixinEnabled?: boolean
    logLevel?: string
    proxyRequestTimeoutMs?: number
  }
  restartRequired?: string[]
}

/**
 * Keep the workbench page readable on a phone as well as on the desktop.
 * Colors come from DSH's own semantic theme tokens (`--dsw-alias-*`), which the
 * theme plugin defines on body for both light and dark appearance, so the page
 * follows the active DSH theme instead of assuming a light background.
 */
const STYLE = `
.gwmb-page { box-sizing: border-box; width: 100%; height: 100%; overflow: hidden; display: flex; flex-direction: column; gap: 18px; padding: 28px clamp(16px, 4vw, 48px) 0; max-width: 1080px; margin: 0 auto; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); }
.gwmb-head, .gwmb-tabs { flex: 0 0 auto; }
.gwmb-scroll { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 18px; overflow-y: auto; overflow-x: hidden; padding-bottom: 56px; }
.gwmb-head { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 20px; }
.gwmb-title { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: 0.01em; color: var(--dsw-alias-label-primary); }
.gwmb-sub { margin: 2px 0 0; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.gwmb-grow { flex: 1 1 auto; }
.gwmb-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.gwmb-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); border-radius: var(--dsw-radius-md, 10px); padding: 6px 12px; font-size: 13px; line-height: 1.4; cursor: pointer; text-decoration: none; }
.gwmb-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.gwmb-btn:active { background: var(--dsw-alias-interactive-bg-active); }
.gwmb-btn:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-link)); outline-offset: 1px; }
.gwmb-btn:disabled { opacity: .5; cursor: default; }
.gwmb-tabs { display: flex; flex-wrap: wrap; gap: 6px; border-bottom: 1px solid var(--dsw-alias-border-l1); padding-bottom: 6px; }
.gwmb-tab { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 14px; padding: 7px 12px; border-radius: var(--dsw-radius-md, 10px); cursor: pointer; }
.gwmb-tab:hover { background: var(--dsw-alias-interactive-bg-hover); }
.gwmb-tab:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-link)); outline-offset: 1px; }
.gwmb-tab-active { color: var(--dsw-alias-label-primary); font-weight: 600; background: var(--dsw-alias-interactive-bg-active); }
.gwmb-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
.gwmb-card { min-width: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg, 16px); padding: 14px 16px; background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; gap: 6px; }
.gwmb-card h3 { margin: 0; font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-tertiary); letter-spacing: .04em; text-transform: uppercase; }
.gwmb-inline { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.gwmb-inline-value { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.gwmb-value { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.gwmb-meta { font-size: 12px; color: var(--dsw-alias-label-tertiary); word-break: break-all; }
.gwmb-ok { color: var(--dsw-alias-state-success-primary); }
.gwmb-warn { color: var(--dsw-alias-state-warn-primary); }
.gwmb-bad { color: var(--dsw-alias-state-error-primary); }
.gwmb-muted { color: var(--dsw-alias-label-tertiary); }
.gwmb-note { font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.gwmb-code { font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 12px; overflow-wrap: anywhere; }
.gwmb-error { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }
.gwmb-banner { border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); color: var(--dsw-alias-label-primary); border-radius: var(--dsw-radius-md, 10px); padding: 10px 14px; font-size: 13px; }
.gwmb-qr { display: flex; align-items: center; justify-content: center; background: #fff; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md, 10px); padding: 10px; width: 232px; max-width: 100%; }
.gwmb-qr svg { width: 100%; height: auto; display: block; }
.gwmb-pairing-grid { display: grid; grid-template-columns: minmax(280px, 340px) minmax(0, 1fr); gap: 12px; align-items: start; }
@media (max-width: 760px) { .gwmb-pairing-grid { grid-template-columns: minmax(0, 1fr); } }
.gwmb-pairing-main { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; }
.gwmb-pairing-meta { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.gwmb-code-big { font-size: 30px; letter-spacing: .18em; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
.gwmb-row { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; }
.gwmb-table { width: 100%; border-collapse: collapse; font-size: 13px; color: var(--dsw-alias-label-primary); }
.gwmb-table th, .gwmb-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
.gwmb-table th { font-size: 12px; color: var(--dsw-alias-label-tertiary); font-weight: 500; white-space: nowrap; }
.gwmb-table-wrap { width: 100%; overflow-x: auto; }
.gwmb-devices-table { table-layout: fixed; min-width: 780px; }
.gwmb-devices-table td { vertical-align: middle; }
.gwmb-devices-table th:nth-child(1), .gwmb-devices-table td:nth-child(1) { width: 36%; }
.gwmb-devices-table th:nth-child(2), .gwmb-devices-table td:nth-child(2) { width: 104px; }
.gwmb-devices-table th:nth-child(3), .gwmb-devices-table td:nth-child(3) { width: 150px; }
.gwmb-devices-table th:nth-child(4), .gwmb-devices-table td:nth-child(4) { width: 150px; }
.gwmb-devices-table th:nth-child(5), .gwmb-devices-table td:nth-child(5) { width: 120px; }
.gwmb-nowrap { white-space: nowrap; }
.gwmb-device-name, .gwmb-device-ua { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwmb-device-name { color: var(--dsw-alias-label-primary); }
.gwmb-device-ua { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.gwmb-log { display: grid; grid-template-columns: 148px 60px minmax(0, 1fr); gap: 10px; font-size: 12px; padding: 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); min-width: 0; }
.gwmb-log-time { color: var(--dsw-alias-label-caption); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gwmb-log-msg { min-width: 0; overflow-wrap: anywhere; word-break: break-word; color: var(--dsw-alias-label-secondary); }
.gwmb-select { font-size: 13px; padding: 5px 8px; border-radius: var(--dsw-radius-md, 10px); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.gwmb-kv { display: grid; grid-template-columns: minmax(140px, 220px) 1fr; gap: 6px 16px; font-size: 13px; }
.gwmb-kv dt { color: var(--dsw-alias-label-tertiary); }
.gwmb-kv dd { margin: 0; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.gwmb-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px 18px; }
.gwmb-form-row { display: flex; flex-direction: column; gap: 5px; font-size: 13px; min-width: 0; }
.gwmb-form-row > span:first-child { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.gwmb-input { box-sizing: border-box; width: 100%; font-size: 13px; font-family: inherit; padding: 6px 9px; border-radius: var(--dsw-radius-md, 10px); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.gwmb-input:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-link)); outline-offset: 1px; }
`

// Insert the stylesheet while the module factory is materializing: the client
// module system claims <style> elements created in this window and removes
// them again when the plugin is unloaded or replaced by HMR.
const styleElement = document.createElement('style')
styleElement.setAttribute('data-gw-workbench', '')
styleElement.textContent = STYLE
document.head.append(styleElement)

function isLoopbackPage(): boolean {
  const host = window.location.hostname.toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as T
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  const init: RequestInit = { method: 'POST', credentials: 'same-origin' }
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  init.headers = headers
  const response = await fetch(path, init)
  if (!response.ok) {
    // Surface the gateway error envelope's message when present.
    let detail = `HTTP ${response.status}`
    try {
      const payload = (await response.json()) as { message?: unknown }
      if (typeof payload.message === 'string' && payload.message) detail = payload.message
    } catch {
      // keep the status text
    }
    throw new Error(detail)
  }
  return (await response.json()) as T
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.floor(seconds)
  if (total < 60) return `${total}s`
  if (total < 3600) return `${Math.floor(total / 60)}m`
  if (total < 86400) return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`
  return `${Math.floor(total / 86400)}d ${Math.floor((total % 86400) / 3600)}h`
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '已过期'
  const total = Math.floor(seconds)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  if (minutes <= 0) return `${rest}s`
  return `${minutes}m ${String(rest).padStart(2, '0')}s`
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

/** Compact `YYYY-MM-DD HH:mm` used by table cells that must stay on one line. */
function formatShortTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function InfoCard(props: { title: string; value?: string; tone?: string; children?: ReactNode }): ReactElement {
  return (
    <section className="gwmb-card">
      <div className="gwmb-inline">
        <h3>{props.title}</h3>
        {props.value !== undefined ? (
          <span className={`gwmb-inline-value ${props.tone ?? ''}`}>{props.value}</span>
        ) : null}
      </div>
      {props.children}
    </section>
  )
}

function ErrorCard(props: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="gwmb-card gwmb-error">
      <h3>{props.title}</h3>
      {props.children}
    </section>
  )
}

function OverviewTab(props: {
  ping: PingView | null
  refreshedAt: string
  bridgeReady: boolean
  local: boolean
  onRefresh: () => void
}): ReactElement {
  const { ping } = props
  const online = ping?.tunnel.connected === true
  const [tunnelBusy, setTunnelBusy] = useState('')
  const [tunnelError, setTunnelError] = useState('')

  const controlTunnel = async (action: 'start' | 'stop' | 'restart'): Promise<void> => {
    setTunnelBusy(action)
    setTunnelError('')
    try {
      await apiPost('/api/gateway-mobile/admin/tunnel', { action })
      props.onRefresh()
    } catch (cause) {
      setTunnelError(messageOf(cause))
    } finally {
      setTunnelBusy('')
    }
  }

  return (
    <>
      {!props.bridgeReady && ping ? (
        <section className="gwmb-card">
          <h3>宿主桥版本较旧</h3>
          <p className="gwmb-note">
            当前 DSH 进程仍运行旧版宿主桥，只显示概览。重启一次 <span className="gwmb-code">dsh web</span> 后，配对、设备、日志与设置页签才会出现。
          </p>
        </section>
      ) : null}
      <div className="gwmb-grid">
        <InfoCard
          title="网关"
          value={ping ? `127.0.0.1:${ping.gateway.port}` : '—'}
          tone={ping ? 'gwmb-ok' : 'gwmb-muted'}
        >
          <div className="gwmb-meta">
            运行 {ping ? formatUptime(ping.gateway.uptime) : '—'}
            {props.refreshedAt ? ` · 上次读取 ${props.refreshedAt}` : ' · 正在读取…'}
          </div>
        </InfoCard>

        <InfoCard
          title="隧道"
          value={ping ? ping.tunnel.state : '—'}
          tone={online ? 'gwmb-ok' : ping ? 'gwmb-warn' : 'gwmb-muted'}
        >
          <div className="gwmb-meta">{ping ? `${ping.tunnel.mode} · ${ping.tunnel.protocol}` : '—'}</div>
          {ping?.tunnel.url ? <div className="gwmb-meta gwmb-code">{ping.tunnel.url}</div> : null}
          {props.local ? (
            <div className="gwmb-actions">
              <button
                className="gwmb-btn"
                type="button"
                disabled={tunnelBusy !== '' || !ping}
                onClick={() => void controlTunnel('start')}
              >
                {tunnelBusy === 'start' ? '启动中…' : '启动'}
              </button>
              <button
                className="gwmb-btn"
                type="button"
                disabled={tunnelBusy !== '' || !ping}
                onClick={() => void controlTunnel('stop')}
              >
                {tunnelBusy === 'stop' ? '停止中…' : '停止'}
              </button>
              <button
                className="gwmb-btn"
                type="button"
                disabled={tunnelBusy !== '' || !ping}
                onClick={() => void controlTunnel('restart')}
              >
                {tunnelBusy === 'restart' ? '重连中…' : '重连'}
              </button>
            </div>
          ) : null}
          {tunnelError ? <div className="gwmb-meta gwmb-bad">{tunnelError}</div> : null}
        </InfoCard>

        <InfoCard title="设备" value={ping ? String(ping.devices.active) : '—'}>
          <div className="gwmb-meta">
            在线 {ping ? ping.devices.online : '—'} · 已配对 {ping ? ping.devices.active : '—'}
          </div>
          <div className="gwmb-meta">{ping?.local ? '本机可管理全部设备' : '手机端为只读视图'}</div>
        </InfoCard>

        <InfoCard title="能力">
          <div className="gwmb-meta">
            DSH 控制器 {ping?.capabilities.controller ? '可用' : '不可用'} · 工作区{' '}
            {ping?.capabilities.workspaceRegistry ? '可用' : '不可用'}
          </div>
          <div className="gwmb-meta">
            用户提问 {ping?.capabilities.userQuestions ? '可用' : '不可用'} · 微信{' '}
            {ping?.capabilities.weixin ? '已启用' : '未启用'}
          </div>
        </InfoCard>
      </div>

      {props.bridgeReady && ping?.local ? (
        <section className="gwmb-card">
          <h3>使用提示</h3>
          <p className="gwmb-note">
            管理操作（配对二维码、设备、日志、设置）在本机 DSH UI 内完成；手机经网关打开同一 UI 时只看到本只读概览。
            独立管理台仍可通过页头按钮打开。
          </p>
        </section>
      ) : null}
      {props.bridgeReady && ping && !ping.local ? (
        <section className="gwmb-card">
          <h3>只读视图</h3>
          <p className="gwmb-note">
            当前页面经手机网关打开，按安全策略仅展示只读概览。配对码、设备、日志与设置请在本机 DSH UI 或独立管理台查看。
          </p>
        </section>
      ) : null}
    </>
  )
}

function PairingTab(): ReactElement {
  const [data, setData] = useState<PairingView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [tick, setTick] = useState(Date.now())

  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await apiGet<PairingView>('/api/gateway-mobile/read/pairing'))
      setError('')
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => setTick(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [load])

  const remaining = data ? Math.max(0, Math.round((Date.parse(data.expiresAt) - tick) / 1000)) : 0

  const regenerate = async (): Promise<void> => {
    setBusy(true)
    try {
      setData(await apiPost<PairingView>('/api/gateway-mobile/admin/pairing/regenerate'))
      setError('')
      setTick(Date.now())
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (): Promise<void> => {
    if (!data) return
    try {
      await navigator.clipboard.writeText(data.pairingUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  if (error && !data) {
    return (
      <ErrorCard title="配对信息不可用">
        <div className="gwmb-meta">{error}</div>
      </ErrorCard>
    )
  }

  return (
    <>
      {data?.previousUrl ? (
        <div className="gwmb-banner">
          隧道地址已变化：旧地址 {data.previousUrl} 已失效，手机需要重新配对。
        </div>
      ) : null}

      <div className="gwmb-pairing-grid">
        <section className="gwmb-card" aria-label="扫码配对">
          {data ? (
            <div className="gwmb-pairing-main">
              <div className="gwmb-qr" dangerouslySetInnerHTML={{ __html: data.qrSvg }} />
              <div className="gwmb-code-big">{data.code}</div>
              <div className="gwmb-meta gwmb-muted">手机扫码，或在手机入口输入该配对码</div>
            </div>
          ) : (
            <div className="gwmb-meta">正在读取配对信息…</div>
          )}
          {error ? <div className="gwmb-meta gwmb-bad">{error}</div> : null}
        </section>

        <section className="gwmb-card" aria-label="手机入口与链接">
          {data ? (
            <div className="gwmb-pairing-meta">
              <div>
                <div className="gwmb-meta">手机入口</div>
                <div className="gwmb-code">{data.tunnel.url || '隧道未连接'}</div>
              </div>
              <div>
                <div className="gwmb-meta">配对链接</div>
                <div className="gwmb-code">{data.pairingUrl}</div>
              </div>
              <div className={`gwmb-meta ${data.status.valid ? 'gwmb-ok' : 'gwmb-warn'}`}>
                有效期 {formatDuration(remaining)} ·{' '}
                {data.status.valid ? '当前配对码有效' : data.status.used ? '配对码已使用' : '配对码已过期'}
              </div>
              <div className="gwmb-actions">
                <button className="gwmb-btn" type="button" onClick={() => void copy()}>
                  {copied ? '已复制' : '复制配对链接'}
                </button>
                <button className="gwmb-btn" type="button" disabled={busy} onClick={() => void regenerate()}>
                  {busy ? '生成中…' : '重新生成'}
                </button>
              </div>
              <div className="gwmb-meta gwmb-muted">
                配对码用掉或过期后，可在这里重新生成；手机端工作台为只读视图，不显示配对码。
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </>
  )
}

function DevicesTab(): ReactElement {
  const [devices, setDevices] = useState<DeviceView[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiGet<{ devices: DeviceView[] }>('/api/gateway-mobile/read/devices')
      setDevices(payload.devices)
      setError('')
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [load])

  if (error) {
    return (
      <ErrorCard title="设备列表不可用">
        <div className="gwmb-meta">{error}</div>
      </ErrorCard>
    )
  }

  return (
    <section className="gwmb-card">
      <h3>已配对设备（{devices?.length ?? 0}）</h3>
      <div className="gwmb-meta" style={{ marginBottom: 8 }}>
        只读视图；重命名、撤销与清理请在独立管理台完成。
      </div>
      <div className="gwmb-table-wrap">
        <table className="gwmb-table gwmb-devices-table">
          <thead>
            <tr>
              <th>设备</th>
              <th>状态</th>
              <th>最近活动</th>
              <th>创建时间</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {(devices ?? []).map((device) => {
              const tone = device.revoked || device.expired ? 'gwmb-bad' : device.isOnline ? 'gwmb-ok' : 'gwmb-warn'
              const state = device.revoked ? '已撤销' : device.expired ? '已过期' : device.isOnline ? '在线' : '离线'
              const name = device.displayName || device.deviceName
              return (
                <tr key={device.deviceId}>
                  <td className="gwmb-device-cell">
                    <div className="gwmb-device-name" title={name}>
                      {name}
                    </div>
                    <div className="gwmb-device-ua" title={device.userAgent}>
                      {device.userAgent}
                    </div>
                  </td>
                  <td className={`gwmb-nowrap ${tone}`}>
                    {state}
                    {device.isCurrent ? ' · 本机' : ''}
                  </td>
                  <td className="gwmb-nowrap">{formatShortTime(device.lastActiveAt)}</td>
                  <td className="gwmb-nowrap">{formatShortTime(device.createdAt)}</td>
                  <td className="gwmb-code gwmb-nowrap">{device.lastIp || '—'}</td>
                </tr>
              )
            })}
            {devices !== null && devices.length === 0 ? (
              <tr>
                <td colSpan={5} className="gwmb-muted">
                  还没有已配对设备。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {devices === null ? <div className="gwmb-meta">正在读取设备…</div> : null}
    </section>
  )
}

function LogsTab(): ReactElement {
  const [logs, setLogs] = useState<LogItem[] | null>(null)
  const [level, setLevel] = useState('all')
  const [error, setError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiGet<{ logs: LogItem[] }>('/api/gateway-mobile/read/logs?limit=200')
      setLogs(payload.logs)
      setError('')
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [load])

  if (error) {
    return (
      <ErrorCard title="日志不可用">
        <div className="gwmb-meta">{error}</div>
      </ErrorCard>
    )
  }

  const levels = ['all', 'error', 'warn', 'info', 'debug']
  const visible = (logs ?? []).filter((item) => level === 'all' || item.level === level)

  return (
    <section className="gwmb-card">
      <div className="gwmb-row" style={{ justifyContent: 'space-between' }}>
        <h3>最近日志（{visible.length}）</h3>
        <select className="gwmb-select" value={level} onChange={(event) => setLevel(event.target.value)}>
          {levels.map((item) => (
            <option key={item} value={item}>
              {item === 'all' ? '全部级别' : item}
            </option>
          ))}
        </select>
      </div>
      <div>
        {visible.map((item, index) => (
          <div className="gwmb-log" key={`${item.timestamp}-${index}`}>
            <span className="gwmb-log-time">{formatTime(item.timestamp)}</span>
            <span className={item.level === 'error' ? 'gwmb-bad' : item.level === 'warn' ? 'gwmb-warn' : 'gwmb-muted'}>
              {item.level}
            </span>
            <span className="gwmb-log-msg">{item.message}</span>
          </div>
        ))}
        {logs !== null && visible.length === 0 ? <div className="gwmb-meta">暂无日志。</div> : null}
        {logs === null ? <div className="gwmb-meta">正在读取日志…</div> : null}
      </div>
      <div className="gwmb-meta">审计导出请在独立管理台完成。</div>
    </section>
  )
}

interface SettingsForm {
  sessionDays: string
  pairingMinutes: string
  tunnelEnabled: boolean
  weixinEnabled: boolean
  logLevel: string
  proxyTimeoutMs: string
}

function toSettingsForm(settings: SettingsView): SettingsForm {
  return {
    sessionDays: settings.sessionMaxAge ? String(Math.round(settings.sessionMaxAge / 86400)) : '1',
    pairingMinutes: settings.pairingTokenExpiry ? String(Math.round(settings.pairingTokenExpiry / 60)) : '15',
    tunnelEnabled: settings.runtime?.tunnelEnabled !== false,
    weixinEnabled: settings.runtime?.weixinEnabled !== false,
    logLevel: settings.runtime?.logLevel ?? 'info',
    proxyTimeoutMs: settings.runtime?.proxyRequestTimeoutMs ? String(settings.runtime.proxyRequestTimeoutMs) : '',
  }
}

function SettingsTab(props: { pluginVersion: string }): ReactElement {
  const [form, setForm] = useState<SettingsForm | null>(null)
  const [limits, setLimits] = useState<SettingsView['limits']>(undefined)
  const [version, setVersion] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiGet<SettingsView>('/api/gateway-mobile/read/settings')
      setForm(toSettingsForm(payload))
      setLimits(payload.limits)
      setVersion(payload.version ?? '')
      setError('')
      setMessage('')
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const update = <K extends keyof SettingsForm,>(key: K, value: SettingsForm[K]): void => {
    setForm((current) => (current === null ? current : { ...current, [key]: value }))
    setMessage('')
  }

  const save = async (): Promise<void> => {
    if (!form) return
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const patch: Record<string, unknown> = {
        sessionMaxAge: Math.round(Number(form.sessionDays) * 86400),
        pairingTokenExpiry: Math.round(Number(form.pairingMinutes) * 60),
        tunnelEnabled: form.tunnelEnabled,
        weixinEnabled: form.weixinEnabled,
        logLevel: form.logLevel,
      }
      if (form.proxyTimeoutMs.trim() !== '') {
        patch.proxyRequestTimeoutMs = Math.round(Number(form.proxyTimeoutMs))
      }
      const payload = await apiPost<SettingsView>('/api/gateway-mobile/admin/settings', patch)
      setForm(toSettingsForm(payload))
      setLimits(payload.limits)
      setVersion(payload.version ?? version)
      setMessage('设置已保存并生效')
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setSaving(false)
    }
  }

  if (error && form === null) {
    return (
      <ErrorCard title="设置不可用">
        <div className="gwmb-meta">{error}</div>
        <div className="gwmb-note">只读与设置修改都需要本机 DSH UI；手机端为只读视图。</div>
      </ErrorCard>
    )
  }
  if (form === null) return <div className="gwmb-meta">正在读取设置…</div>

  const sessionMinMinutes = limits?.sessionMin ? Math.round(limits.sessionMin / 60) : 5
  const sessionMaxDays = limits?.sessionMax ? Math.round(limits.sessionMax / 86400) : 90
  const pairingMinMinutes = limits?.pairingMin ? Math.max(1, Math.round(limits.pairingMin / 60)) : 1
  const pairingMaxMinutes = limits?.pairingMax ? Math.round(limits.pairingMax / 60) : 1440
  const levels = ['debug', 'info', 'warn', 'error']

  return (
    <section className="gwmb-card">
      <h3>设置</h3>
      <div className="gwmb-meta">插件版本 {version || props.pluginVersion || '—'}</div>
      <div className="gwmb-meta">修改立即生效并持久化，无需重启 DSH；配对码有效期仅影响之后生成的配对码。</div>

      <div className="gwmb-form">
        <label className="gwmb-form-row">
          <span>设备会话时长（天）</span>
          <input
            className="gwmb-input"
            type="number"
            min="1"
            max={sessionMaxDays}
            value={form.sessionDays}
            onChange={(event) => update('sessionDays', event.target.value)}
          />
          <span className="gwmb-meta gwmb-muted">最短约 {sessionMinMinutes} 分钟，最长 {sessionMaxDays} 天</span>
        </label>

        <label className="gwmb-form-row">
          <span>配对码有效期（分钟）</span>
          <input
            className="gwmb-input"
            type="number"
            min={pairingMinMinutes}
            max={pairingMaxMinutes}
            value={form.pairingMinutes}
            onChange={(event) => update('pairingMinutes', event.target.value)}
          />
          <span className="gwmb-meta gwmb-muted">{pairingMinMinutes}–{pairingMaxMinutes} 分钟</span>
        </label>

        <label className="gwmb-form-row">
          <span>隧道开关</span>
          <select
            className="gwmb-select"
            value={form.tunnelEnabled ? 'on' : 'off'}
            onChange={(event) => update('tunnelEnabled', event.target.value === 'on')}
          >
            <option value="on">启用（Quick/Named Tunnel）</option>
            <option value="off">禁用（仅回环访问）</option>
          </select>
        </label>

        <label className="gwmb-form-row">
          <span>微信通道</span>
          <select
            className="gwmb-select"
            value={form.weixinEnabled ? 'on' : 'off'}
            onChange={(event) => update('weixinEnabled', event.target.value === 'on')}
          >
            <option value="on">启用</option>
            <option value="off">禁用</option>
          </select>
        </label>

        <label className="gwmb-form-row">
          <span>日志级别</span>
          <select
            className="gwmb-select"
            value={form.logLevel}
            onChange={(event) => update('logLevel', event.target.value)}
          >
            {levels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>

        <label className="gwmb-form-row">
          <span>DSH 代理超时（毫秒）</span>
          <input
            className="gwmb-input"
            type="number"
            min="1000"
            step="1000"
            placeholder="留空使用默认值"
            value={form.proxyTimeoutMs}
            onChange={(event) => update('proxyTimeoutMs', event.target.value)}
          />
        </label>
      </div>

      <div className="gwmb-actions">
        <button className="gwmb-btn" type="button" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存设置'}
        </button>
        <button className="gwmb-btn" type="button" disabled={saving} onClick={() => void load()}>
          放弃修改
        </button>
      </div>

      {message ? <div className="gwmb-meta gwmb-ok">{message}</div> : null}
      {error ? <div className="gwmb-meta gwmb-bad">{error}</div> : null}

      <div className="gwmb-meta gwmb-muted">
        密钥轮换、审计导出、OAuth 白名单等高级维护仍在独立管理台完成。
      </div>
    </section>
  )
}

function WorkbenchPage(): ReactElement {
  const [tab, setTab] = useState<Tab>('overview')
  const [ping, setPing] = useState<PingView | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshedAt, setRefreshedAt] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const payload = await apiGet<PingView>('/api/gateway-mobile/read/ping')
      setPing(payload)
      setError('')
      setRefreshedAt(new Date().toLocaleTimeString())
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      void load()
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [load])

  const bridgeReady = ping !== null && typeof ping.local === 'boolean'
  const local = bridgeReady && ping.local === true

  useEffect(() => {
    if (!local && tab !== 'overview') setTab('overview')
  }, [local, tab])

  // Each tab starts at the top of the content area instead of keeping the
  // previous tab's scroll offset.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [tab])

  const phoneUrl = ping?.gateway.publicBase ? `${ping.gateway.publicBase}/mobile` : ''
  const adminUrl = ping?.gateway.adminUrl ?? ''
  const loopback = isLoopbackPage()

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'overview', label: '概览' },
    ...(local
      ? [
          { id: 'pairing' as Tab, label: '配对' },
          { id: 'devices' as Tab, label: '设备' },
          { id: 'logs' as Tab, label: '日志' },
          { id: 'settings' as Tab, label: '设置' },
        ]
      : []),
  ]

  return (
    <div className="gwmb-page">
      <header className="gwmb-head">
        <div>
          <h2 className="gwmb-title">手机网关</h2>
          <p className="gwmb-sub">
            手机与微信通道的工作台。
            {!bridgeReady
              ? '正在读取宿主桥状态…'
              : local
                ? '本机可查看配对、设备、日志与设置。'
                : '手机端为只读视图。'}
          </p>
        </div>
        <div className="gwmb-grow" />
        <div className="gwmb-actions">
          <button className="gwmb-btn" type="button" onClick={() => void load()} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
          {loopback && adminUrl ? (
            <a className="gwmb-btn" href={adminUrl} target="_blank" rel="noreferrer">
              打开独立管理台
            </a>
          ) : null}
          {phoneUrl ? (
            <a className="gwmb-btn" href={phoneUrl} target="_blank" rel="noreferrer">
              打开手机入口
            </a>
          ) : null}
        </div>
      </header>

      {local ? (
        <div className="gwmb-tabs" role="tablist" aria-label="手机网关分区">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`gwmb-tab ${tab === item.id ? 'gwmb-tab-active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="gwmb-scroll" ref={scrollRef}>
        {error ? (
          <ErrorCard title="宿主桥不可用">
            <div className="gwmb-meta">
              无法读取 <span className="gwmb-code">/api/gateway-mobile/read/ping</span>：{error}
            </div>
            <div className="gwmb-note">
              若刚升级插件，需要重启一次 <span className="gwmb-code">dsh web</span> 让 DSH 载入新的客户端半侧；独立管理台不受影响。
            </div>
          </ErrorCard>
        ) : null}

        {tab === 'overview' ? (
          <OverviewTab
            ping={ping}
            refreshedAt={refreshedAt}
            bridgeReady={bridgeReady}
            local={local}
            onRefresh={() => void load()}
          />
        ) : null}
        {tab === 'pairing' && local ? <PairingTab /> : null}
        {tab === 'devices' && local ? <DevicesTab /> : null}
        {tab === 'logs' && local ? <LogsTab /> : null}
        {tab === 'settings' && local ? <SettingsTab pluginVersion={ping?.version ?? ''} /> : null}
      </div>
    </div>
  )
}

interface PanelIconProps {
  size?: number
  active?: boolean
}

function PanelIcon({ size = 18, active = false }: PanelIconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 1.9 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2.5" y="4" width="19" height="13" rx="2.5" />
      <path d="M8 20.5h8" />
      <path d="M12 17v3.5" />
      <path d="M21 11.5c-1.6 0-2.6 1-2.6 2.4 0 1.3 1 2.3 2.3 2.3" />
    </svg>
  )
}

/**
 * Mount the workbench: one full-page `main` panel plus its sidebar entry.
 * Both registrations wait for the owning slot declarations, so the plugin
 * neither depends on an import of the sidebar/layout packages nor fails when
 * those packages are absent.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(NS, DICTIONARIES),
    'dsh-gateway-mobile: workbench dictionaries',
  )
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, WorkbenchPage),
  )
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 600,
        label: () => t('panel'),
        locale: NS,
      },
      PanelIcon,
    ),
  )
}
