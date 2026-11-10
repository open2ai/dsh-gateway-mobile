/**
 * DSH browser half: the “移动端网关” workbench page and its left-sidebar entry.
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
/** localStorage key: last `urlChangedAt` whose re-pair banner was dismissed. */
const URL_CHANGE_DISMISSED_KEY = 'dsh-gateway-mobile:pairing-url-dismissed'

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
  zh: { panel: '移动端网关' },
  en: { panel: 'Mobile Gateway' },
}

type Tab = 'overview' | 'pairing' | 'weixin' | 'devices' | 'logs' | 'settings'

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
    adminConsoleEnabled?: boolean
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
  repairedSinceChange?: boolean
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
  adminConsoleEnabled?: boolean
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
.gwmb-page { box-sizing: border-box; width: 100%; height: 100%; overflow: hidden; display: flex; flex-direction: column; gap: 18px; padding: 28px clamp(16px, 4vw, 48px) 16px; max-width: 1080px; margin: 0 auto; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); }
.gwmb-page *, .gwmb-page *::before, .gwmb-page *::after { box-sizing: border-box; }
.gwmb-head, .gwmb-tabs { flex: 0 0 auto; }
.gwmb-scroll { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 18px; overflow-y: auto; overflow-x: hidden; padding-bottom: 0; }
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
.gwmb-btn-sm { padding: 3px 8px; font-size: 12px; }
.gwmb-tunnel-actions { flex-wrap: nowrap; width: 100%; gap: 6px; }
.gwmb-tunnel-actions .gwmb-btn { flex: 0 0 auto; min-width: 0; font-size: 12px; line-height: 1.4; white-space: nowrap; display: inline-flex; align-items: center; justify-content: center; }
.gwmb-tunnel-actions .gwmb-tunnel-btn { width: 32px; height: 26px; padding: 0; }
.gwmb-tunnel-btn { min-height: 26px; color: var(--dsw-alias-label-secondary); }
.gwmb-tunnel-btn svg { width: 18px; height: 18px; }
.gwmb-tunnel-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.gwmb-tunnel-btn-danger { color: var(--dsw-alias-state-error-primary); }
.gwmb-tunnel-btn-danger:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); filter: brightness(1.12); }
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
.gwmb-muted { color: var(--dsw-alias-label-secondary); }
.gwmb-note { font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.gwmb-code { font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 12px; overflow-wrap: anywhere; }
.gwmb-error { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }
.gwmb-banner { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); color: var(--dsw-alias-label-primary); border-radius: var(--dsw-radius-md, 10px); padding: 10px 14px; font-size: 13px; }
.gwmb-banner-close { flex: 0 0 auto; appearance: none; border: 0; background: transparent; color: inherit; font-size: 16px; line-height: 1; padding: 2px 6px; border-radius: 6px; cursor: pointer; opacity: .75; }
.gwmb-banner-close:hover { opacity: 1; background: var(--dsw-alias-interactive-bg-hover); }
.gwmb-banner-close:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-link)); outline-offset: 1px; }
.gwmb-qr { display: flex; align-items: center; justify-content: center; background: #fff; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md, 10px); padding: 10px; width: 100%; max-width: 100%; }
.gwmb-qr.gwmb-qr-sm { width: 180px; max-width: 180px; padding: 8px; flex: 0 0 auto; }
.gwmb-divider { height: 1px; background: var(--dsw-alias-border-l1); margin: 4px 0; }
.gwmb-qr svg { width: 100%; height: auto; display: block; }
.gwmb-pairing-grid { display: grid; grid-template-columns: minmax(280px, 340px) minmax(0, 1fr); gap: 12px; align-items: start; }
@media (max-width: 760px) { .gwmb-pairing-grid { grid-template-columns: minmax(0, 1fr); } }
.gwmb-pairing-main { display: flex; flex-direction: column; align-items: stretch; gap: 8px; text-align: center; }
.gwmb-pairing-meta { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.gwmb-link-field { display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); border-radius: var(--dsw-radius-md, 10px); padding: 8px 10px; min-width: 0; }
.gwmb-link-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.gwmb-link-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.gwmb-link-value { font-size: 12px; font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; min-width: 0; }
.gwmb-icon-btn { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; padding: 2px; border-radius: 6px; display: inline-flex; align-items: center; }
.gwmb-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.gwmb-icon-btn:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-link)); outline-offset: 1px; }
.gwmb-link-btn { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-link); font-size: 13px; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
.gwmb-link-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.gwmb-link-btn:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-link)); outline-offset: 1px; }
.gwmb-code-toggle { display: flex; justify-content: center; }
.gwmb-btn-primary { background: var(--dsw-alias-button-primary-fill); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); }
.gwmb-btn-primary:hover { background: var(--dsw-alias-button-primary-hover); }
.gwmb-btn-danger { background: var(--dsw-alias-state-error-primary); border-color: transparent; color: #fff; }
.gwmb-btn-danger:hover { filter: brightness(1.08); }
.gwmb-range-picker { position: relative; display: inline-block; }
.gwmb-range-popover { position: absolute; z-index: 1100; top: calc(100% + 6px); left: 0; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg, 16px); box-shadow: var(--dsw-elevation-prominent); padding: 12px; display: flex; flex-direction: column; gap: 10px; color: var(--dsw-alias-label-primary); }
.gwmb-range-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.gwmb-range-months { display: flex; flex-wrap: wrap; gap: 18px; }
.gwmb-cal { min-width: 196px; }
.gwmb-cal-title { font-size: 13px; font-weight: 600; text-align: center; margin-bottom: 6px; }
.gwmb-cal-grid { display: grid; grid-template-columns: repeat(7, 26px); gap: 2px; }
.gwmb-cal-week { font-size: 11px; text-align: center; color: var(--dsw-alias-label-tertiary); padding: 2px 0; }
.gwmb-cal-day { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px; width: 26px; height: 26px; border-radius: 6px; cursor: pointer; }
.gwmb-cal-day:hover { background: var(--dsw-alias-interactive-bg-hover); }
.gwmb-cal-day-active { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.gwmb-cal-day-active:hover { background: var(--dsw-alias-button-primary-hover); }
.gwmb-cal-day:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-link)); outline-offset: 1px; }
.gwmb-modal-mask { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(0,0,0,.45); }
.gwmb-modal { box-sizing: border-box; width: min(420px, 100%); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg, 16px); box-shadow: var(--dsw-elevation-prominent); padding: 18px; display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary); }
.gwmb-modal h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); text-transform: none; letter-spacing: 0; }
.gwmb-modal-message { font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.gwmb-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
/* Interaction polish: DSH focus ring, hover border lift and input focus ring. */
.gwmb-btn, .gwmb-tab, .gwmb-icon-btn, .gwmb-cal-day, .gwmb-link-field, .gwmb-input, .gwmb-select, .gwmb-textarea { transition: background-color .12s ease, border-color .12s ease, color .12s ease, box-shadow .12s ease; }
.gwmb-btn:focus-visible, .gwmb-tab:focus-visible, .gwmb-icon-btn:focus-visible, .gwmb-cal-day:focus-visible, .gwmb-banner-close:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 2px; }
.gwmb-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3); }
.gwmb-link-field:hover { border-color: var(--dsw-alias-border-l3); }
.gwmb-input:hover:not(:disabled), .gwmb-select:hover:not(:disabled), .gwmb-textarea:hover { border-color: var(--dsw-alias-border-l3); }
.gwmb-input:focus, .gwmb-select:focus, .gwmb-textarea:focus { outline: none; border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 24%, transparent); }
.gwmb-code-big { font-size: 30px; letter-spacing: .18em; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
.gwmb-row { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; }
.gwmb-table { width: 100%; border-collapse: collapse; font-size: 13px; color: var(--dsw-alias-label-primary); }
.gwmb-table th, .gwmb-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
.gwmb-table th { font-size: 12px; color: var(--dsw-alias-label-tertiary); font-weight: 500; white-space: nowrap; }
.gwmb-table-wrap { width: 100%; overflow-x: auto; }
.gwmb-devices-table { table-layout: fixed; min-width: 960px; }
.gwmb-devices-table td { vertical-align: middle; }
.gwmb-devices-table th:nth-child(1), .gwmb-devices-table td:nth-child(1) { width: 32%; }
.gwmb-devices-table th:nth-child(2), .gwmb-devices-table td:nth-child(2) { width: 100px; }
.gwmb-devices-table th:nth-child(3), .gwmb-devices-table td:nth-child(3) { width: 140px; }
.gwmb-devices-table th:nth-child(4), .gwmb-devices-table td:nth-child(4) { width: 140px; }
.gwmb-devices-table th:nth-child(5), .gwmb-devices-table td:nth-child(5) { width: 110px; }
.gwmb-devices-table th:nth-child(6), .gwmb-devices-table td:nth-child(6) { width: 176px; }
.gwmb-nowrap { white-space: nowrap; }
.gwmb-device-name, .gwmb-device-ua { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwmb-device-name { color: var(--dsw-alias-label-primary); }
.gwmb-device-ua { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.gwmb-log { display: grid; grid-template-columns: 148px 60px minmax(0, 1fr); gap: 10px; font-size: 12px; padding: 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); min-width: 0; }
.gwmb-log-list { padding-bottom: 16px; }
.gwmb-log-time { color: var(--dsw-alias-label-caption); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gwmb-log-msg { min-width: 0; overflow-wrap: anywhere; word-break: break-word; color: var(--dsw-alias-label-secondary); }
.gwmb-select { font-size: 13px; padding: 5px 8px; border-radius: var(--dsw-radius-md, 10px); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.gwmb-select-sm { font-size: 12px; padding: 3px 6px; }
.gwmb-kv { display: grid; grid-template-columns: minmax(140px, 220px) 1fr; gap: 6px 16px; font-size: 13px; }
.gwmb-kv dt { color: var(--dsw-alias-label-tertiary); }
.gwmb-kv dd { margin: 0; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.gwmb-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px 18px; }
.gwmb-form-wide { grid-column: 1 / -1; }
.gwmb-form-row { display: flex; flex-direction: column; gap: 5px; font-size: 13px; min-width: 0; }
.gwmb-form-row > span:first-child { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.gwmb-input { box-sizing: border-box; width: 100%; font-size: 13px; font-family: inherit; padding: 6px 9px; border-radius: var(--dsw-radius-md, 10px); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.gwmb-input:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-link)); outline-offset: 1px; }
.gwmb-textarea { box-sizing: border-box; width: 100%; min-height: 84px; resize: vertical; font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 12px; padding: 8px 10px; border-radius: var(--dsw-radius-md, 10px); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.gwmb-textarea:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-link)); outline-offset: 1px; }
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

interface ConfirmState {
  title: string
  message: string
  confirmText: string
  danger: boolean
  action: () => void
}

function Modal(props: { title: string; children: ReactNode; actions: ReactNode; onClose: () => void }): ReactElement {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])

  return (
    <div className="gwmb-modal-mask" onClick={props.onClose}>
      <div
        className="gwmb-modal"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(event) => event.stopPropagation()}
      >
        <h3>{props.title}</h3>
        {props.children}
        <div className="gwmb-modal-actions">{props.actions}</div>
      </div>
    </div>
  )
}

function ConfirmDialog(props: { state: ConfirmState; busy?: boolean; onClose: () => void }): ReactElement {
  const { state } = props
  return (
    <Modal
      title={state.title}
      onClose={props.onClose}
      actions={
        <>
          <button className="gwmb-btn" type="button" disabled={props.busy === true} onClick={props.onClose}>
            取消
          </button>
          <button
            className={`gwmb-btn ${state.danger ? 'gwmb-btn-danger' : 'gwmb-btn-primary'}`}
            type="button"
            disabled={props.busy === true}
            onClick={() => {
              state.action()
              props.onClose()
            }}
          >
            {props.busy === true ? '处理中…' : state.confirmText}
          </button>
        </>
      }
    >
      <div className="gwmb-modal-message">{state.message}</div>
    </Modal>
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

function PlayIcon(props: { size?: number }): ReactElement {
  return (
    <svg width={props.size ?? 16} height={props.size ?? 16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M8 5.2v13.6L19 12 8 5.2Z" />
    </svg>
  )
}

function StopIcon(props: { size?: number }): ReactElement {
  return (
    <svg width={props.size ?? 16} height={props.size ?? 16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
    </svg>
  )
}

function RefreshIcon(props: { size?: number }): ReactElement {
  return (
    <svg
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4.5V11h-6.5" />
    </svg>
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
          {props.local ? (
            <div className="gwmb-actions gwmb-tunnel-actions">
              <button
                className="gwmb-btn gwmb-tunnel-btn"
                type="button"
                title="启动隧道"
                aria-label="启动隧道"
                disabled={tunnelBusy !== '' || !ping}
                onClick={() => void controlTunnel('start')}
              >
                <PlayIcon />
              </button>
              <button
                className="gwmb-btn gwmb-tunnel-btn gwmb-tunnel-btn-danger"
                type="button"
                title="停止隧道"
                aria-label="停止隧道"
                disabled={tunnelBusy !== '' || !ping}
                onClick={() => void controlTunnel('stop')}
              >
                <StopIcon />
              </button>
              <button
                className="gwmb-btn gwmb-tunnel-btn"
                type="button"
                title="重连隧道"
                aria-label="重连隧道"
                disabled={tunnelBusy !== '' || !ping}
                onClick={() => void controlTunnel('restart')}
              >
                <RefreshIcon />
              </button>
            </div>
          ) : null}
          {tunnelBusy !== '' ? (
            <div className="gwmb-meta">
              {tunnelBusy === 'start' ? '正在启动隧道…' : tunnelBusy === 'stop' ? '正在停止隧道…' : '正在重连隧道…'}
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
      </div>

      <section className="gwmb-card">
        <h3>能力</h3>
        <dl className="gwmb-kv">
          <dt>DSH 控制器</dt>
          <dd>{ping?.capabilities.controller ? '可用' : '不可用'}</dd>
          <dt>工作区</dt>
          <dd>{ping?.capabilities.workspaceRegistry ? '可用' : '不可用'}</dd>
          <dt>用户提问</dt>
          <dd>{ping?.capabilities.userQuestions ? '可用' : '不可用'}</dd>
          <dt>微信</dt>
          <dd>{ping?.capabilities.weixin ? '已启用' : '未启用'}</dd>
        </dl>
      </section>

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
            当前页面经移动端网关打开，按安全策略仅展示只读概览。配对码、设备、日志与设置请在本机 DSH UI 或独立管理台查看。
          </p>
        </section>
      ) : null}
    </>
  )
}

function EyeIcon(props: { size?: number }): ReactElement {
  return (
    <svg
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  )
}

function EyeOffIcon(props: { size?: number }): ReactElement {
  return (
    <svg
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M4 20 20 4" />
    </svg>
  )
}

function PairingTab(): ReactElement {
  const [data, setData] = useState<PairingView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [tick, setTick] = useState(Date.now())
  const [showEntry, setShowEntry] = useState(true)
  const [showPairingLink, setShowPairingLink] = useState(false)
  const [showCode, setShowCode] = useState(false)
  const [dismissedUrlChangedAt, setDismissedUrlChangedAt] = useState<number | null>(null)

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

  useEffect(() => {
    const changedAt = data?.urlChangedAt
    if (!changedAt) {
      setDismissedUrlChangedAt(null)
      return
    }
    try {
      const stored = window.localStorage.getItem(URL_CHANGE_DISMISSED_KEY)
      setDismissedUrlChangedAt(stored === String(changedAt) ? changedAt : null)
    } catch {
      setDismissedUrlChangedAt(null)
    }
  }, [data?.urlChangedAt])

  const dismissUrlChange = (): void => {
    if (!data?.urlChangedAt) return
    try {
      window.localStorage.setItem(URL_CHANGE_DISMISSED_KEY, String(data.urlChangedAt))
    } catch {
      // local storage unavailable: hide for this session only
    }
    setDismissedUrlChangedAt(data.urlChangedAt)
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
      {data?.previousUrl &&
      data.urlChangedAt > 0 &&
      data.repairedSinceChange !== true &&
      dismissedUrlChangedAt !== data.urlChangedAt ? (
        <div className="gwmb-banner">
          <span>隧道地址已变化：旧地址 {data.previousUrl} 已失效，手机需要重新配对。</span>
          <button
            className="gwmb-banner-close"
            type="button"
            aria-label="关闭提示"
            title="关闭提示"
            onClick={dismissUrlChange}
          >
            ×
          </button>
        </div>
      ) : null}

      <div className="gwmb-pairing-grid">
        <section className="gwmb-card" aria-label="扫码配对">
          {data ? (
            <div className="gwmb-pairing-main">
              <div className="gwmb-qr" dangerouslySetInnerHTML={{ __html: data.qrSvg }} />
              <div className="gwmb-code-toggle">
                <button
                  className="gwmb-link-btn"
                  type="button"
                  aria-expanded={showCode}
                  onClick={() => setShowCode((value) => !value)}
                >
                  {showCode ? '隐藏配对码' : '查看配对码'}
                </button>
              </div>
              {showCode ? (
                <>
                  <div className="gwmb-code-big">{data.code}</div>
                  <div className="gwmb-meta gwmb-muted">在手机配对页输入这 8 位字符；扫码会自动带入</div>
                </>
              ) : null}
            </div>
          ) : (
            <div className="gwmb-meta">正在读取配对信息…</div>
          )}
          {error ? <div className="gwmb-meta gwmb-bad">{error}</div> : null}
        </section>

        <section className="gwmb-card" aria-label="手机入口与链接">
          {data ? (
            <div className="gwmb-pairing-meta">
              <div className="gwmb-link-field">
                <div className="gwmb-link-head">
                  <span className="gwmb-link-label">手机入口</span>
                  <button
                    className="gwmb-icon-btn"
                    type="button"
                    aria-label={showEntry ? '隐藏手机入口' : '显示手机入口'}
                    title={showEntry ? '隐藏手机入口' : '显示手机入口'}
                    onClick={() => setShowEntry((value) => !value)}
                  >
                    {showEntry ? <EyeIcon /> : <EyeOffIcon />}
                  </button>
                </div>
                <div className="gwmb-link-value">
                  {data.tunnel.url
                    ? showEntry
                      ? data.tunnel.url
                      : '••••••••••••••••••••••••'
                    : '隧道未连接'}
                </div>
              </div>

              <div className="gwmb-link-field">
                <div className="gwmb-link-head">
                  <span className="gwmb-link-label">配对链接</span>
                  <button
                    className="gwmb-icon-btn"
                    type="button"
                    aria-label={showPairingLink ? '隐藏配对链接' : '显示配对链接'}
                    title={showPairingLink ? '隐藏配对链接' : '显示配对链接'}
                    onClick={() => setShowPairingLink((value) => !value)}
                  >
                    {showPairingLink ? <EyeIcon /> : <EyeOffIcon />}
                  </button>
                </div>
                <div className="gwmb-link-value">
                  {showPairingLink ? data.pairingUrl : '••••••••••••••••••••••••'}
                </div>
              </div>

              <div className={`gwmb-meta ${data.status.valid ? 'gwmb-ok' : 'gwmb-warn'}`}>
                有效期 {formatDuration(remaining)} ·{' '}
                {data.status.valid ? '当前配对码有效' : data.status.used ? '配对码已使用' : '配对码已过期'}
              </div>
              <div className="gwmb-actions">
                <button className="gwmb-btn gwmb-btn-primary" type="button" onClick={() => void copy()}>
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
  const [actionError, setActionError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState('')
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ device: DeviceView; value: string } | null>(null)

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

  const applyAction = async (
    deviceId: string,
    action: 'rename' | 'revoke' | 'delete',
    body: Record<string, unknown>,
  ): Promise<void> => {
    setBusy(deviceId)
    setActionError('')
    setMessage('')
    try {
      const payload = await apiPost<{ devices: DeviceView[] }>(`/api/gateway-mobile/admin/devices/${action}`, body)
      setDevices(payload.devices)
      setMessage(action === 'rename' ? '设备已重命名' : action === 'revoke' ? '设备已撤销' : '设备记录已删除')
    } catch (cause) {
      setActionError(messageOf(cause))
    } finally {
      setBusy('')
    }
  }

  const rename = (device: DeviceView): void => {
    setRenameTarget({ device, value: device.displayName || device.deviceName })
  }

  const submitRename = (): void => {
    if (!renameTarget) return
    const name = renameTarget.value.trim()
    if (name === '') return
    const deviceId = renameTarget.device.deviceId
    setRenameTarget(null)
    void applyAction(deviceId, 'rename', { deviceId, deviceName: name })
  }

  const revoke = (device: DeviceView): void => {
    const name = device.displayName || device.deviceName
    setConfirmState({
      title: '撤销设备',
      message: `撤销「${name}」？该设备会立即失效，需要重新配对才能再次访问。`,
      confirmText: '撤销',
      danger: true,
      action: () => void applyAction(device.deviceId, 'revoke', { deviceId: device.deviceId }),
    })
  }

  const remove = (device: DeviceView): void => {
    setConfirmState({
      title: '删除设备记录',
      message: '永久删除该设备记录？只有已撤销或已过期的记录可以删除，此操作不可恢复。',
      confirmText: '删除',
      danger: true,
      action: () => void applyAction(device.deviceId, 'delete', { deviceId: device.deviceId }),
    })
  }

  const runPurge = async (): Promise<void> => {
    setBusy('purge')
    setActionError('')
    setMessage('')
    try {
      const payload = await apiPost<{ deleted: number; devices: DeviceView[] }>(
        '/api/gateway-mobile/admin/devices/purge',
        { confirmText: 'DELETE REVOKED' },
      )
      setDevices(payload.devices)
      setMessage(`已清理 ${payload.deleted} 条记录`)
    } catch (cause) {
      setActionError(messageOf(cause))
    } finally {
      setBusy('')
    }
  }

  const purge = (): void => {
    setConfirmState({
      title: '清理设备记录',
      message: '删除所有已撤销 / 已过期的设备记录？此操作不可恢复。',
      confirmText: '清理',
      danger: true,
      action: () => void runPurge(),
    })
  }

  if (error) {
    return (
      <ErrorCard title="设备列表不可用">
        <div className="gwmb-meta">{error}</div>
      </ErrorCard>
    )
  }

  return (
    <>
      <section className="gwmb-card">
        <div className="gwmb-row" style={{ justifyContent: 'space-between' }}>
          <h3>已配对设备（{devices?.length ?? 0}）</h3>
        <div className="gwmb-actions">
          <button className="gwmb-btn gwmb-btn-sm" type="button" disabled={busy !== ''} onClick={() => void purge()}>
            {busy === 'purge' ? '清理中…' : '清理已撤销/过期'}
          </button>
        </div>
      </div>
      <div className="gwmb-meta" style={{ marginBottom: 8 }}>
        重命名、撤销与清理直接在这里操作；手机端设备页不显示这些按钮。
      </div>
      {message ? <div className="gwmb-meta gwmb-ok">{message}</div> : null}
      {actionError ? <div className="gwmb-meta gwmb-bad">{actionError}</div> : null}
      <div className="gwmb-table-wrap">
        <table className="gwmb-table gwmb-devices-table">
          <thead>
            <tr>
              <th>设备</th>
              <th>状态</th>
              <th>最近活动</th>
              <th>创建时间</th>
              <th>IP</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {(devices ?? []).map((device) => {
              const tone = device.revoked || device.expired ? 'gwmb-bad' : device.isOnline ? 'gwmb-ok' : 'gwmb-warn'
              const state = device.revoked ? '已撤销' : device.expired ? '已过期' : device.isOnline ? '在线' : '离线'
              const name = device.displayName || device.deviceName
              const removable = device.revoked || device.expired
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
                  <td className="gwmb-nowrap">
                    <div className="gwmb-actions">
                      <button
                        className="gwmb-btn gwmb-btn-sm"
                        type="button"
                        disabled={busy !== ''}
                        onClick={() => rename(device)}
                      >
                        重命名
                      </button>
                      {!device.revoked ? (
                        <button
                          className="gwmb-btn gwmb-btn-sm"
                          type="button"
                          disabled={busy !== ''}
                          onClick={() => revoke(device)}
                        >
                          撤销
                        </button>
                      ) : null}
                      {removable ? (
                        <button
                          className="gwmb-btn gwmb-btn-sm"
                          type="button"
                          disabled={busy !== ''}
                          onClick={() => remove(device)}
                        >
                          删除
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              )
            })}
            {devices !== null && devices.length === 0 ? (
              <tr>
                <td colSpan={6} className="gwmb-muted">
                  还没有已配对设备。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {devices === null ? <div className="gwmb-meta">正在读取设备…</div> : null}
      </section>

      {renameTarget ? (
        <Modal
          title="重命名设备"
          onClose={() => setRenameTarget(null)}
          actions={
            <>
              <button className="gwmb-btn" type="button" onClick={() => setRenameTarget(null)}>
                取消
              </button>
              <button
                className="gwmb-btn gwmb-btn-primary"
                type="button"
                disabled={renameTarget.value.trim() === ''}
                onClick={submitRename}
              >
                保存
              </button>
            </>
          }
        >
          <div className="gwmb-modal-message">
            给「{renameTarget.device.displayName || renameTarget.device.deviceName}」设置一个新名称
          </div>
          <input
            className="gwmb-input"
            value={renameTarget.value}
            autoFocus
            onChange={(event) => setRenameTarget({ ...renameTarget, value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitRename()
            }}
          />
        </Modal>
      ) : null}

      {confirmState ? (
        <ConfirmDialog state={confirmState} busy={busy !== ''} onClose={() => setConfirmState(null)} />
      ) : null}
    </>
  )
}

interface DateRangeValue {
  start: number
  end: number
}

function dayStart(ms: number): number {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function dayEnd(ms: number): number {
  const date = new Date(ms)
  date.setHours(23, 59, 59, 999)
  return date.getTime()
}

function formatDay(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Two-month range picker: press on the start day and drag/click to the end day. */
function DateRangePicker(props: {
  value: DateRangeValue | null
  onChange: (value: DateRangeValue | null) => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState(() => new Date())
  const [draft, setDraft] = useState<{ anchor: number; end: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!dragging) return
    const finish = (): void => {
      setDragging(false)
      setDraft((current) => {
        if (current === null) return null
        props.onChange({ start: dayStart(Math.min(current.anchor, current.end)), end: dayEnd(Math.max(current.anchor, current.end)) })
        setOpen(false)
        return null
      })
    }
    window.addEventListener('mouseup', finish)
    return () => window.removeEventListener('mouseup', finish)
  }, [dragging, props])

  const label = props.value ? `${formatDay(props.value.start)} ~ ${formatDay(props.value.end)}` : '选择时间范围'

  const range =
    draft === null ? null : [dayStart(Math.min(draft.anchor, draft.end)), dayStart(Math.max(draft.anchor, draft.end))]

  const renderMonth = (base: Date): ReactElement => {
    const first = new Date(base.getFullYear(), base.getMonth(), 1)
    const offset = (first.getDay() + 6) % 7
    const count = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate()
    const cells: Array<Date | null> = []
    for (let index = 0; index < offset; index += 1) cells.push(null)
    for (let day = 1; day <= count; day += 1) cells.push(new Date(base.getFullYear(), base.getMonth(), day))
    return (
      <div className="gwmb-cal" key={base.getTime()}>
        <div className="gwmb-cal-title">{`${base.getFullYear()}年${base.getMonth() + 1}月`}</div>
        <div className="gwmb-cal-grid">
          {['一', '二', '三', '四', '五', '六', '日'].map((weekday) => (
            <div key={weekday} className="gwmb-cal-week">
              {weekday}
            </div>
          ))}
          {cells.map((date, index) => {
            if (date === null) return <div key={`empty-${index}`} />
            const ms = date.getTime()
            const active = range !== null && ms >= range[0]! && ms <= range[1]!
            return (
              <button
                key={ms}
                type="button"
                className={`gwmb-cal-day ${active ? 'gwmb-cal-day-active' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault()
                  setDraft({ anchor: ms, end: ms })
                  setDragging(true)
                }}
                onMouseEnter={() => {
                  if (dragging && draft !== null) setDraft({ anchor: draft.anchor, end: ms })
                }}
              >
                {date.getDate()}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="gwmb-range-picker">
      <button
        className="gwmb-btn gwmb-btn-sm"
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value)
          setDraft(null)
        }}
      >
        {label}
      </button>
      {open ? (
        <div className="gwmb-range-popover">
          <div className="gwmb-range-head">
            <button
              className="gwmb-icon-btn"
              type="button"
              aria-label="上个月"
              onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}
            >
              ‹
            </button>
            <span className="gwmb-meta">按住并拖到结束日期，或依次点击两天</span>
            <button
              className="gwmb-icon-btn"
              type="button"
              aria-label="下个月"
              onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}
            >
              ›
            </button>
          </div>
          <div className="gwmb-range-months">
            {renderMonth(view)}
            {renderMonth(new Date(view.getFullYear(), view.getMonth() + 1, 1))}
          </div>
          <div className="gwmb-actions">
            <button
              className="gwmb-btn gwmb-btn-sm"
              type="button"
              onClick={() => {
                props.onChange(null)
                setOpen(false)
              }}
            >
              清除
            </button>
            <button className="gwmb-btn gwmb-btn-sm" type="button" onClick={() => setOpen(false)}>
              关闭
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function LogsTab(): ReactElement {
  const [view, setView] = useState<'runtime' | 'weixin'>('runtime')
  const [logs, setLogs] = useState<LogItem[] | null>(null)
  const [level, setLevel] = useState('all')
  const [error, setError] = useState('')
  const [approvals, setApprovals] = useState<unknown[] | null>(null)
  const [approvalsError, setApprovalsError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportRange, setExportRange] = useState<'24h' | '7d' | '30d' | '90d' | 'custom' | 'all'>('24h')
  const [customRange, setCustomRange] = useState<DateRangeValue | null>(null)
  const [exportMessage, setExportMessage] = useState('')
  const [exportError, setExportError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiGet<{ logs: LogItem[] }>('/api/gateway-mobile/read/logs?limit=200')
      setLogs(payload.logs)
      setError('')
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [])

  const loadApprovals = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiGet<{ items: unknown[] }>('/api/gateway-mobile/read/weixin/approvals')
      setApprovals(payload.items)
      setApprovalsError('')
    } catch (cause) {
      setApprovalsError(messageOf(cause))
    }
  }, [])

  useEffect(() => {
    void load()
    void loadApprovals()
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [load, loadApprovals])

  const exportAudit = async (): Promise<void> => {
    setExporting(true)
    setExportMessage('')
    setExportError('')
    try {
      const dayMs = 86_400_000
      const presets: Record<string, number> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }
      let sinceMs: number | undefined
      let untilMs: number | undefined
      if (exportRange === 'custom') {
        if (customRange === null) throw new Error('请先在日历里拖选时间范围')
        sinceMs = dayStart(customRange.start)
        untilMs = dayEnd(customRange.end)
      } else if (exportRange !== 'all') {
        sinceMs = Date.now() - presets[exportRange]! * dayMs
      }
      const params = new URLSearchParams()
      if (sinceMs !== undefined) params.set('since', String(sinceMs))
      if (untilMs !== undefined) params.set('until', String(untilMs))
      if (sinceMs === undefined && untilMs === undefined) params.set('limit', '500')
      const query = params.toString() === '' ? '' : `?${params.toString()}`
      const payload = await apiGet<Record<string, unknown>>(`/api/gateway-mobile/read/audit${query}`)
      const rangeLabel = exportRange
      const rangeText =
        exportRange === '24h'
          ? '最近 24 小时'
          : exportRange === '7d'
            ? '最近 7 天'
            : exportRange === '30d'
              ? '最近 30 天'
              : exportRange === '90d'
                ? '最近 90 天'
                : exportRange === 'custom'
                  ? customRange
                    ? `${formatDay(customRange.start)} ~ ${formatDay(customRange.end)}`
                    : '自定义范围'
                  : '全部，最多 500 条'
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `gateway-mobile-audit-${rangeLabel}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      setExportMessage(`审计日志已导出（${rangeText}）`)
    } catch (cause) {
      setExportError(messageOf(cause))
    } finally {
      setExporting(false)
    }
  }

  if (error && view === 'runtime') {
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
        <h3>日志</h3>
        <div className="gwmb-actions">
          <button
            className={`gwmb-btn gwmb-btn-sm ${view === 'runtime' ? 'gwmb-btn-primary' : ''}`}
            type="button"
            onClick={() => setView('runtime')}
          >
            运行日志
          </button>
          <button
            className={`gwmb-btn gwmb-btn-sm ${view === 'weixin' ? 'gwmb-btn-primary' : ''}`}
            type="button"
            onClick={() => setView('weixin')}
          >
            微信审批历史（{approvals?.length ?? 0}）
          </button>
          <select
            className="gwmb-select gwmb-select-sm"
            value={exportRange}
            disabled={exporting}
            aria-label="审计导出范围"
            onChange={(event) => setExportRange(event.target.value as '24h' | '7d' | 'all')}
          >
            <option value="24h">最近 24 小时（不限条数）</option>
            <option value="7d">最近 7 天（不限条数）</option>
            <option value="30d">最近 30 天（不限条数）</option>
            <option value="90d">最近 90 天（不限条数）</option>
            <option value="custom">自定义时间段（不限条数）</option>
            <option value="all">全部（最多 500 条）</option>
          </select>
          <button className="gwmb-btn gwmb-btn-sm" type="button" disabled={exporting} onClick={() => void exportAudit()}>
            {exporting ? '导出中…' : '导出审计日志'}
          </button>
        </div>
      </div>

      {exportRange === 'custom' ? (
        <div className="gwmb-row">
          <DateRangePicker value={customRange} onChange={setCustomRange} />
        </div>
      ) : null}

      {exportMessage ? <div className="gwmb-meta gwmb-ok">{exportMessage}</div> : null}
      {exportError ? <div className="gwmb-meta gwmb-bad">{exportError}</div> : null}

      {view === 'runtime' ? (
        <>
          <div className="gwmb-row" style={{ justifyContent: 'flex-end' }}>
            <select className="gwmb-select" value={level} onChange={(event) => setLevel(event.target.value)}>
              {levels.map((item) => (
                <option key={item} value={item}>
                  {item === 'all' ? '全部级别' : item}
                </option>
              ))}
            </select>
          </div>
          <div className="gwmb-log-list">
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
        </>
      ) : (
        <>
          <div className="gwmb-row" style={{ justifyContent: 'flex-end' }}>
            <button className="gwmb-btn gwmb-btn-sm" type="button" onClick={() => void loadApprovals()}>
              刷新
            </button>
          </div>
          {approvalsError ? <div className="gwmb-meta gwmb-bad">{approvalsError}</div> : null}
          <div className="gwmb-code" style={{ maxHeight: 420, overflowY: 'auto' }}>
            {approvals === null
              ? '正在读取审批历史…'
              : approvals.length === 0
                ? '暂无审批记录'
                : approvals.map((item, index) => <div key={index}>{JSON.stringify(item)}</div>)}
          </div>
          <div className="gwmb-meta gwmb-muted">审批历史与微信审批、提问、计划审核相关；手机端不显示。</div>
        </>
      )}
    </section>
  )
}

function WeixinTab(): ReactElement {
  const [status, setStatus] = useState<WeixinView | null>(null)
  const [form, setForm] = useState<WeixinForm | null>(null)
  const [login, setLogin] = useState<WeixinLoginView | null>(null)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiGet<WeixinView>('/api/gateway-mobile/read/weixin')
      setStatus(payload)
      setForm(toWeixinForm(payload))
      setError('')
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const loginState = login?.state ?? ''
  useEffect(() => {
    if (!['wait', 'scaned', 'pending'].includes(loginState)) return
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const next = await apiGet<WeixinLoginView>('/api/gateway-mobile/admin/weixin/login')
          setLogin(next)
          if (next.state === 'confirmed') {
            setMessage('微信已连接')
            await load()
          }
        } catch (cause) {
          setError(messageOf(cause))
        }
      })()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [loginState, load])

  const update = <K extends keyof WeixinForm,>(key: K, value: WeixinForm[K]): void => {
    setForm((current) => (current === null ? current : { ...current, [key]: value }))
    setMessage('')
  }

  const startLogin = async (): Promise<void> => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      setLogin(await apiPost<WeixinLoginView>('/api/gateway-mobile/admin/weixin/login'))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const approveLogin = async (approve: boolean): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const next = await apiPost<WeixinLoginView>('/api/gateway-mobile/admin/weixin/approve', { approve })
      setLogin(next)
      setMessage(approve ? '已允许连接' : '已拒绝连接')
      await load()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const doLogout = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await apiPost('/api/gateway-mobile/admin/weixin/logout')
      setLogin(null)
      setMessage('微信已断开')
      await load()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const logout = (): void => {
    setConfirmState({
      title: '断开微信连接',
      message: '断开后需要重新扫码登录，才能继续转发审批、提问和完成通知。',
      confirmText: '断开',
      danger: true,
      action: () => void doLogout(),
    })
  }

  const save = async (): Promise<void> => {
    if (!form) return
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const payload = await apiPost<WeixinView>('/api/gateway-mobile/admin/weixin', {
        enabled: form.enabled,
        notifyEnabled: form.notifyEnabled,
        debounceMs: Math.round(Number(form.debounceSeconds) * 1000),
        perSessionIntervalMs: Math.round(Number(form.perSessionSeconds) * 1000),
        globalIntervalMs: Math.round(Number(form.globalSeconds) * 1000),
        maxPerHour: Math.round(Number(form.maxPerHour)),
      })
      setStatus(payload)
      setForm(toWeixinForm(payload))
      setMessage('微信设置已保存')
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setSaving(false)
    }
  }

  if (error && status === null) {
    return (
      <ErrorCard title="微信不可用">
        <div className="gwmb-meta">{error}</div>
      </ErrorCard>
    )
  }
  if (status === null || form === null) return <div className="gwmb-meta">正在读取微信状态…</div>

  return (
    <>
      <section className="gwmb-card">
        <div className="gwmb-row" style={{ justifyContent: 'space-between' }}>
          <h3>微信连接</h3>
          <div className="gwmb-actions">
            {status.weixin?.connected ? (
              <button className="gwmb-btn" type="button" disabled={busy} onClick={logout}>
                退出登录
              </button>
            ) : (
              <button
                className="gwmb-btn gwmb-btn-primary"
                type="button"
                disabled={busy}
                onClick={() => void startLogin()}
              >
                {busy ? '生成中…' : '生成登录二维码'}
              </button>
            )}
          </div>
        </div>
        <div className="gwmb-meta">
          状态 {status.weixin?.state ?? (status.weixin?.connected ? 'connected' : '未连接')}
          {status.weixin?.owner?.masked ? ` · 绑定账号 ${status.weixin.owner.masked}` : ''}
          {status.weixin?.lastError ? ` · ${status.weixin.lastError}` : ''}
        </div>
        {login ? (
          <div className="gwmb-row">
            {login.qrSvg ? (
              <div className="gwmb-qr gwmb-qr-sm" dangerouslySetInnerHTML={{ __html: login.qrSvg }} />
            ) : null}
            <div className="gwmb-pairing-meta">
              <div className="gwmb-meta">
                状态 {login.state}
                {login.pendingUserId ? ' · 等待本机确认' : ''}
                {login.lastError ? ` · ${login.lastError}` : ''}
              </div>
              {login.state === 'pending' ? (
                <div className="gwmb-actions">
                  <button
                    className="gwmb-btn gwmb-btn-primary"
                    type="button"
                    disabled={busy}
                    onClick={() => void approveLogin(true)}
                  >
                    允许连接
                  </button>
                  <button className="gwmb-btn" type="button" disabled={busy} onClick={() => void approveLogin(false)}>
                    拒绝
                  </button>
                </div>
              ) : null}
              {login.state === 'expired' || login.state === 'error' ? (
                <button className="gwmb-btn" type="button" disabled={busy} onClick={() => void startLogin()}>
                  重新生成二维码
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="gwmb-meta gwmb-muted">
          扫码完成后需在本机点「允许连接」；审批历史在「日志」页签查看。
        </div>
      </section>

      <section className="gwmb-card">
        <h3>通知设置</h3>
        <div className="gwmb-form">
          <label className="gwmb-form-row">
            <span>微信通道</span>
            <select
              className="gwmb-select"
              value={form.enabled ? 'on' : 'off'}
              onChange={(event) => update('enabled', event.target.value === 'on')}
            >
              <option value="on">启用</option>
              <option value="off">禁用</option>
            </select>
          </label>
          <label className="gwmb-form-row">
            <span>完成通知</span>
            <select
              className="gwmb-select"
              value={form.notifyEnabled ? 'on' : 'off'}
              onChange={(event) => update('notifyEnabled', event.target.value === 'on')}
            >
              <option value="on">启用</option>
              <option value="off">禁用</option>
            </select>
          </label>
          <label className="gwmb-form-row">
            <span>合并窗口（秒）</span>
            <input
              className="gwmb-input"
              type="number"
              min="1"
              value={form.debounceSeconds}
              onChange={(event) => update('debounceSeconds', event.target.value)}
            />
          </label>
          <label className="gwmb-form-row">
            <span>单会话冷却（秒）</span>
            <input
              className="gwmb-input"
              type="number"
              min="0"
              value={form.perSessionSeconds}
              onChange={(event) => update('perSessionSeconds', event.target.value)}
            />
          </label>
          <label className="gwmb-form-row">
            <span>全局间隔（秒）</span>
            <input
              className="gwmb-input"
              type="number"
              min="0"
              value={form.globalSeconds}
              onChange={(event) => update('globalSeconds', event.target.value)}
            />
          </label>
          <label className="gwmb-form-row">
            <span>每小时上限（条）</span>
            <input
              className="gwmb-input"
              type="number"
              min="1"
              value={form.maxPerHour}
              onChange={(event) => update('maxPerHour', event.target.value)}
            />
          </label>
        </div>
        <div className="gwmb-actions">
          <button className="gwmb-btn gwmb-btn-primary" type="button" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存设置'}
          </button>
        </div>
      </section>

      {message ? <div className="gwmb-meta gwmb-ok">{message}</div> : null}
      {error ? <div className="gwmb-meta gwmb-bad">{error}</div> : null}

      {confirmState ? (
        <ConfirmDialog state={confirmState} busy={busy} onClose={() => setConfirmState(null)} />
      ) : null}
    </>
  )
}

interface SettingsForm {
  sessionDays: string
  pairingMinutes: string
  tunnelEnabled: boolean
  weixinEnabled: boolean
  logLevel: string
  proxyTimeoutMs: string
  adminConsoleEnabled: boolean
}

function toSettingsForm(settings: SettingsView): SettingsForm {
  return {
    sessionDays: settings.sessionMaxAge ? String(Math.round(settings.sessionMaxAge / 86400)) : '1',
    pairingMinutes: settings.pairingTokenExpiry ? String(Math.round(settings.pairingTokenExpiry / 60)) : '15',
    tunnelEnabled: settings.runtime?.tunnelEnabled !== false,
    weixinEnabled: settings.runtime?.weixinEnabled !== false,
    logLevel: settings.runtime?.logLevel ?? 'info',
    proxyTimeoutMs: settings.runtime?.proxyRequestTimeoutMs ? String(settings.runtime.proxyRequestTimeoutMs) : '',
    adminConsoleEnabled: settings.adminConsoleEnabled !== false,
  }
}

interface WeixinNotifyView {
  enabled: boolean
  debounceMs: number
  perSessionIntervalMs: number
  globalIntervalMs: number
  maxPerHour: number
}

interface WeixinView {
  weixin: {
    enabled?: boolean
    connected?: boolean
    state?: string
    owner?: { masked?: string; boundAt?: number }
    lastError?: string
  } | null
  notify: WeixinNotifyView | null
}

interface WeixinForm {
  enabled: boolean
  notifyEnabled: boolean
  debounceSeconds: string
  perSessionSeconds: string
  globalSeconds: string
  maxPerHour: string
}

function toWeixinForm(payload: WeixinView): WeixinForm {
  const notify = payload.notify
  return {
    enabled: payload.weixin?.enabled !== false,
    notifyEnabled: notify?.enabled ?? true,
    debounceSeconds: notify ? String(Math.round(notify.debounceMs / 1000)) : '5',
    perSessionSeconds: notify ? String(Math.round(notify.perSessionIntervalMs / 1000)) : '60',
    globalSeconds: notify ? String(Math.round(notify.globalIntervalMs / 1000)) : '15',
    maxPerHour: notify ? String(notify.maxPerHour) : '30',
  }
}

interface KeyView {
  available: boolean
  activeKid: string
  keyIds: string[]
}

interface OAuthView {
  providers: string[]
  requireOAuth: boolean
  allowedUsers: string[]
}

interface WeixinLoginView {
  enabled: boolean
  connected: boolean
  state: string
  qrcode?: string
  qrUrl?: string
  qrSvg?: string
  accountId?: string
  pendingUserId?: string
  lastError?: string
}

function SettingsTab(props: { pluginVersion: string }): ReactElement {
  const [form, setForm] = useState<SettingsForm | null>(null)
  const [weixinForm, setWeixinForm] = useState<WeixinForm | null>(null)
  const [weixinStatus, setWeixinStatus] = useState<WeixinView | null>(null)
  const [keys, setKeys] = useState<KeyView | null>(null)
  const [oauth, setOAuth] = useState<OAuthView | null>(null)
  const [oauthText, setOAuthText] = useState('')
  const [maintenanceBusy, setMaintenanceBusy] = useState('')
  const [loginStatus, setLoginStatus] = useState<WeixinLoginView | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)
  const [limits, setLimits] = useState<SettingsView['limits']>(undefined)
  const [version, setVersion] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const settingsPayload = await apiGet<SettingsView>('/api/gateway-mobile/read/settings')
      setForm(toSettingsForm(settingsPayload))
      setLimits(settingsPayload.limits)
      setVersion(settingsPayload.version ?? '')
      try {
        const [keyPayload, oauthResult] = await Promise.all([
          apiGet<KeyView>('/api/gateway-mobile/read/keys'),
          apiGet<OAuthView>('/api/gateway-mobile/read/oauth'),
        ])
        setKeys(keyPayload)
        setOAuth(oauthResult)
        setOAuthText(oauthResult.allowedUsers.join('\n'))
      } catch {
        setKeys(null)
        setOAuth(null)
        setOAuthText('')
      }
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

  const updateWeixin = <K extends keyof WeixinForm,>(key: K, value: WeixinForm[K]): void => {
    setWeixinForm((current) => (current === null ? current : { ...current, [key]: value }))
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
        adminConsoleEnabled: form.adminConsoleEnabled,
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

  const doRotateKey = async (): Promise<void> => {
    setMaintenanceBusy('key')
    setError('')
    setMessage('')
    try {
      setKeys(await apiPost<KeyView>('/api/gateway-mobile/admin/key/rotate'))
      setMessage('密钥已轮换')
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setMaintenanceBusy('')
    }
  }

  const rotateKey = (): void => {
    setConfirmState({
      title: '轮换密钥',
      message: '轮换后新会话使用新密钥，旧会话仍可验证。确定继续？',
      confirmText: '轮换',
      danger: false,
      action: () => void doRotateKey(),
    })
  }

  const saveOAuth = async (): Promise<void> => {
    setMaintenanceBusy('oauth')
    setError('')
    setMessage('')
    try {
      const allowedUsers = oauthText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
      const next = await apiPost<OAuthView>('/api/gateway-mobile/admin/oauth', { allowedUsers })
      setOAuth(next)
      setOAuthText(next.allowedUsers.join('\n'))
      setMessage('OAuth 白名单已保存')
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setMaintenanceBusy('')
    }
  }

  const startWeixinLogin = async (): Promise<void> => {
    setLoginBusy(true)
    setError('')
    setMessage('')
    try {
      setLoginStatus(await apiPost<WeixinLoginView>('/api/gateway-mobile/admin/weixin/login'))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setLoginBusy(false)
    }
  }

  const approveWeixinLogin = async (approve: boolean): Promise<void> => {
    setLoginBusy(true)
    setError('')
    try {
      const next = await apiPost<WeixinLoginView>('/api/gateway-mobile/admin/weixin/approve', { approve })
      setLoginStatus(next)
      setMessage(approve ? '已允许连接' : '已拒绝连接')
      try {
        setWeixinStatus(await apiGet<WeixinView>('/api/gateway-mobile/read/weixin'))
      } catch {
        // keep the last known channel state
      }
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setLoginBusy(false)
    }
  }

  const doLogoutWeixin = async (): Promise<void> => {
    setLoginBusy(true)
    setError('')
    try {
      await apiPost('/api/gateway-mobile/admin/weixin/logout')
      setLoginStatus(null)
      setMessage('微信已断开')
      try {
        setWeixinStatus(await apiGet<WeixinView>('/api/gateway-mobile/read/weixin'))
      } catch {
        // keep the last known channel state
      }
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setLoginBusy(false)
    }
  }

  const logoutWeixin = (): void => {
    setConfirmState({
      title: '断开微信连接',
      message: '断开后需要重新扫码登录，才能继续转发审批、提问和完成通知。',
      confirmText: '断开',
      danger: true,
      action: () => void doLogoutWeixin(),
    })
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
    <>
      <section className="gwmb-card">
        <div className="gwmb-inline">
          <h3>插件版本</h3>
          <span className="gwmb-inline-value">{version || props.pluginVersion || '—'}</span>
        </div>
        <div className="gwmb-meta">dsh-gateway-mobile · DSH Web UI 工作台</div>
      </section>

      <section className="gwmb-card">
        <h3>隧道与配对</h3>
        <div className="gwmb-form">
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
        </div>
      </section>

      <section className="gwmb-card">
        <h3>日志</h3>
        <div className="gwmb-form">
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
        </div>
      </section>

      <section className="gwmb-card">
        <h3>安全与维护</h3>
        <div className="gwmb-form">
          <div className="gwmb-form-row">
            <span>密钥</span>
            <div className="gwmb-meta">
              {keys?.available
                ? `活动 ${keys.activeKid || '—'} · 全部 ${keys.keyIds.join(', ') || '—'}`
                : '密钥状态不可用'}
            </div>
            <div className="gwmb-actions">
              <button
                className="gwmb-btn"
                type="button"
                disabled={maintenanceBusy !== '' || !keys?.available}
                onClick={() => void rotateKey()}
              >
                {maintenanceBusy === 'key' ? '轮换中…' : '轮换密钥'}
              </button>
            </div>
          </div>

          <div className="gwmb-form-row">
            <span>独立管理台（兼容模式）</span>
            <select
              className="gwmb-select"
              value={form.adminConsoleEnabled ? 'on' : 'off'}
              onChange={(event) => update('adminConsoleEnabled', event.target.value === 'on')}
            >
              <option value="on">启用（本机可打开 /mobile/admin）</option>
              <option value="off">禁用（只用工作台）</option>
            </select>
            <span className="gwmb-meta gwmb-muted">
              禁用后独立页面与 /admin 跳转返回 404，回环 API 仍保留；工作台成为唯一管理入口。
            </span>
          </div>

          <div className="gwmb-form-row gwmb-form-wide">
            <span>OAuth 白名单</span>
            <textarea
              className="gwmb-textarea"
              rows={3}
              value={oauthText}
              placeholder={'github:your-login\ngitee:your-login'}
              onChange={(event) => {
                setOAuthText(event.target.value)
                setMessage('')
              }}
            />
            <span className="gwmb-meta gwmb-muted">
              每行一条 `github:login` 或 `gitee:login`；留空表示不限制，仅影响之后绑定的身份。
            </span>
            <div className="gwmb-actions">
              <button
                className="gwmb-btn"
                type="button"
                disabled={maintenanceBusy !== '' || oauth === null}
                onClick={() => void saveOAuth()}
              >
                {maintenanceBusy === 'oauth' ? '保存中…' : '保存白名单'}
              </button>
            </div>
          </div>
        </div>

        <div className="gwmb-meta">
          {oauth
            ? `已启用 provider：${oauth.providers.join(', ') || '无'}${oauth.requireOAuth ? ' · 强制绑定' : ''}`
            : 'OAuth 状态不可用'}
        </div>
      </section>

      <div className="gwmb-actions">
        <button className="gwmb-btn gwmb-btn-primary" type="button" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存设置'}
        </button>
        <button className="gwmb-btn" type="button" disabled={saving} onClick={() => void load()}>
          放弃修改
        </button>
      </div>

      {message ? <div className="gwmb-meta gwmb-ok">{message}</div> : null}
      {error ? <div className="gwmb-meta gwmb-bad">{error}</div> : null}

      <div className="gwmb-meta gwmb-muted">
        修改立即生效并持久化，无需重启 DSH；配对码有效期仅影响之后生成的配对码。独立管理台可在「安全与维护」中关闭，之后工作台即为唯一管理入口。
      </div>

      {confirmState ? (
        <ConfirmDialog
          state={confirmState}
          busy={maintenanceBusy !== '' || loginBusy}
          onClose={() => setConfirmState(null)}
        />
      ) : null}
    </>
  )
}

function WorkbenchPage(): ReactElement {
  const [tab, setTab] = useState<Tab>('overview')
  const [ping, setPing] = useState<PingView | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshedAt, setRefreshedAt] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (options?: { silent?: boolean }): Promise<void> => {
    const silent = options?.silent === true
    if (!silent) setLoading(true)
    try {
      const payload = await apiGet<PingView>('/api/gateway-mobile/read/ping')
      setPing(payload)
      setError('')
      setRefreshedAt(new Date().toLocaleTimeString())
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      void load({ silent: true })
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
          { id: 'weixin' as Tab, label: '微信' },
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
          <h2 className="gwmb-title">移动端网关</h2>
          <p className="gwmb-sub">
            手机与微信通道的工作台。
            {!bridgeReady
              ? '正在读取宿主桥状态…'
              : local
                ? '本机可查看配对、微信、设备、日志与设置。'
                : '手机端为只读视图。'}
          </p>
        </div>
        <div className="gwmb-grow" />
        <div className="gwmb-actions">
          <button className="gwmb-btn" type="button" onClick={() => void load()} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
          {loopback && adminUrl && ping?.gateway.adminConsoleEnabled !== false ? (
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
        <div className="gwmb-tabs" role="tablist" aria-label="移动端网关分区">
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
            onRefresh={() => void load({ silent: true })}
          />
        ) : null}
        {tab === 'pairing' && local ? <PairingTab /> : null}
        {tab === 'weixin' && local ? <WeixinTab /> : null}
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
