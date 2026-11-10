/**
 * DSH browser half: the “手机网关” workbench page and its left-sidebar entry.
 *
 * The DSH client module system loads this file as a lazy-CJS factory
 * (`window.__ModuleLoader__.load({ id, factory })`) and mounts it on the root
 * loader row whose specifier is the bare package name. Runtime imports are
 * limited to React and its JSX runtime: everything else (slots, locale,
 * layout) is a Cordis client service injected through `apply`.
 *
 * UI surface, matching the official Plugins/Schedules pages:
 * - `main` keyed panel `gateway-mobile-workbench` renders the page;
 * - `sidebar.panellist` entry with the same id adds the left-rail icon.
 *
 * Phase 0 shows a read-only status overview backed by the host bridge route
 * `/api/gateway-mobile/read/ping`; management actions arrive in Phase 1/2.
 *
 * @module dsh-gateway-mobile/lib/client
 */

import { useCallback, useEffect, useState } from 'react'
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

/** Keep the workbench page readable on a phone as well as on the desktop. */
const STYLE = `
.gwmb-page { display: flex; flex-direction: column; gap: 18px; padding: 28px clamp(16px, 4vw, 48px); max-width: 1080px; margin: 0 auto; color: var(--dsw-alias-text-primary, #16181d); }
.gwmb-head { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 20px; }
.gwmb-title { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: 0.01em; }
.gwmb-sub { margin: 2px 0 0; font-size: 13px; opacity: 0.65; }
.gwmb-grow { flex: 1 1 auto; }
.gwmb-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.gwmb-btn { appearance: none; border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.28)); background: var(--dsw-alias-bg-secondary, rgba(127,127,127,.07)); color: inherit; border-radius: 8px; padding: 6px 12px; font-size: 13px; line-height: 1.4; cursor: pointer; text-decoration: none; }
.gwmb-btn:hover { background: var(--dsw-alias-bg-tertiary, rgba(127,127,127,.14)); }
.gwmb-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
.gwmb-card { border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.22)); border-radius: 12px; padding: 14px 16px; background: var(--dsw-alias-bg-secondary, rgba(127,127,127,.05)); display: flex; flex-direction: column; gap: 6px; }
.gwmb-card h3 { margin: 0; font-size: 12px; font-weight: 500; opacity: .6; letter-spacing: .04em; text-transform: uppercase; }
.gwmb-value { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.gwmb-meta { font-size: 12px; opacity: .65; word-break: break-all; }
.gwmb-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.28)); }
.gwmb-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.gwmb-ok { color: #1a7f37; }
.gwmb-warn { color: #b26a00; }
.gwmb-bad { color: #c62828; }
.gwmb-muted { opacity: .55; }
.gwmb-note { font-size: 13px; line-height: 1.6; opacity: .72; }
.gwmb-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.gwmb-error { border-color: rgba(198,40,40,.5); }
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

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.floor(seconds)
  if (total < 60) return `${total}s`
  if (total < 3600) return `${Math.floor(total / 60)}m`
  if (total < 86400) return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`
  return `${Math.floor(total / 86400)}d ${Math.floor((total % 86400) / 3600)}h`
}

function statusTone(ok: boolean): string {
  return ok ? 'gwmb-ok' : 'gwmb-bad'
}

function StatusCard(props: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="gwmb-card">
      <h3>{props.title}</h3>
      {props.children}
    </section>
  )
}

function WorkbenchPage(): ReactElement {
  const [data, setData] = useState<PingView | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshedAt, setRefreshedAt] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const response = await fetch('/api/gateway-mobile/read/ping', {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as PingView
      setData(payload)
      setError('')
      setRefreshedAt(new Date().toLocaleTimeString())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
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

  const online = data?.tunnel.connected === true
  const loopback = isLoopbackPage()
  const phoneUrl = data?.gateway.publicBase ? `${data.gateway.publicBase}/mobile` : ''
  const adminUrl = data?.gateway.adminUrl ?? ''

  return (
    <div className="gwmb-page">
      <header className="gwmb-head">
        <div>
          <h2 className="gwmb-title">手机网关</h2>
          <p className="gwmb-sub">
            手机与微信通道的工作台。配对、隧道和微信连接在下方汇总；独立管理台仍可继续使用。
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

      {error ? (
        <section className="gwmb-card gwmb-error">
          <h3>宿主桥不可用</h3>
          <div className="gwmb-meta">
            无法读取 <span className="gwmb-code">/api/gateway-mobile/read/ping</span>：{error}
          </div>
          <div className="gwmb-note">
            若刚升级插件，需要重启一次 <span className="gwmb-code">dsh web</span> 让 DSH 载入新的客户端半侧；独立管理台不受影响。
          </div>
        </section>
      ) : null}

      <div className="gwmb-grid">
        <StatusCard title="网关">
          <div className={`gwmb-value ${data ? statusTone(true) : 'gwmb-muted'}`}>
            {data ? `127.0.0.1:${data.gateway.port}` : '—'}
          </div>
          <div className="gwmb-meta">
            版本 {data?.version ?? '—'} · 运行 {data ? formatUptime(data.gateway.uptime) : '—'}
          </div>
          <div className="gwmb-meta">{refreshedAt ? `上次读取 ${refreshedAt}` : '正在读取…'}</div>
        </StatusCard>

        <StatusCard title="隧道">
          <div className={`gwmb-value ${online ? 'gwmb-ok' : data ? 'gwmb-warn' : 'gwmb-muted'}`}>
            {data ? `${data.tunnel.state}${online ? '' : '（未连接）'}` : '—'}
          </div>
          <div className="gwmb-meta">
            {data ? `${data.tunnel.mode} · ${data.tunnel.protocol}` : '—'}
          </div>
          {data?.tunnel.url ? (
            <div className="gwmb-meta gwmb-code">{data.tunnel.url}</div>
          ) : null}
        </StatusCard>

        <StatusCard title="设备">
          <div className="gwmb-value">{data ? data.devices.active : '—'}</div>
          <div className="gwmb-meta">
            在线 {data ? data.devices.online : '—'} · 已配对 {data ? data.devices.active : '—'}
          </div>
          <div className="gwmb-meta gwmb-muted">手机端工作台为只读视图</div>
        </StatusCard>

        <StatusCard title="能力">
          <div className="gwmb-meta">
            DSH 控制器 {data?.capabilities.controller ? '可用' : '不可用'} · 工作区{' '}
            {data?.capabilities.workspaceRegistry ? '可用' : '不可用'}
          </div>
          <div className="gwmb-meta">
            用户提问 {data?.capabilities.userQuestions ? '可用' : '不可用'} · 微信{' '}
            {data?.capabilities.weixin ? '已启用' : '未启用'}
          </div>
        </StatusCard>
      </div>

      <section className="gwmb-card">
        <h3>下一步</h3>
        <p className="gwmb-note">
          配对二维码、配对码、设备列表和微信扫码登录会在后续版本加入本页；在此之前可点击“打开独立管理台”完成这些操作。
          本页在手机上与桌面端共用同一份 UI，手机端不会展示可复用的配对码。
        </p>
      </section>
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
