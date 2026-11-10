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

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
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

type Tab = 'overview' | 'pairing' | 'weixin' | 'devices' | 'logs' | 'settings' | 'help'

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
  oauthBindings?: Array<{ provider: string; username: string; boundAt?: string }>
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

interface HealthCheckView {
  name: string
  ok: boolean
  optional?: boolean
  detail?: string
  data?: Record<string, unknown>
}

interface HealthView {
  ok: boolean
  version: string
  startedAt: string
  uptime: number
  serverTime: string
  checks: HealthCheckView[]
}

/** One WeChat approval-history entry (`weixin-approval-history.json`). */
interface ApprovalItem {
  at: number
  id: string
  sessionId: string
  toolName: string
  reason: string
  status: string
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
.gwmb-page { box-sizing: border-box; width: 100%; height: 100%; overflow: hidden; display: flex; flex-direction: column; gap: 18px; padding: 28px clamp(16px, 4vw, 48px) 16px; max-width: 1200px; margin: 0 auto; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); }
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
.gwmb-range-inline { display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md, 10px); background: var(--dsw-alias-bg-layer-2); padding: 12px; }
.gwmb-range-nav { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.gwmb-range-nav .gwmb-icon-btn { width: 28px; height: 28px; justify-content: center; font-size: 18px; }
.gwmb-range-months { display: flex; flex-wrap: wrap; gap: 18px; }
.gwmb-cal { min-width: 196px; }
.gwmb-cal-title { font-size: 13px; font-weight: 600; text-align: center; margin-bottom: 6px; color: var(--dsw-alias-label-primary); }
.gwmb-cal-grid { display: grid; grid-template-columns: repeat(7, 28px); gap: 2px; }
.gwmb-cal-week { font-size: 11px; text-align: center; color: var(--dsw-alias-label-tertiary); padding: 2px 0; }
.gwmb-cal-day { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px; width: 28px; height: 28px; border-radius: var(--dsw-radius-sm, 6px); cursor: pointer; font-variant-numeric: tabular-nums; }
.gwmb-cal-day:hover { background: var(--dsw-alias-interactive-bg-hover); }
.gwmb-cal-day-edge { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.gwmb-cal-day-edge:hover { background: var(--dsw-alias-button-primary-hover); }
.gwmb-cal-day-inrange { background: color-mix(in srgb, var(--dsw-alias-button-primary-fill) 14%, transparent); border-radius: 0; }
.gwmb-cal-day-inrange:hover { background: color-mix(in srgb, var(--dsw-alias-button-primary-fill) 22%, transparent); }
.gwmb-cal-day-today { box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l3); }
.gwmb-cal-day:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-link)); outline-offset: 1px; }
.gwmb-modal-mask { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(0,0,0,.45); }
.gwmb-modal { box-sizing: border-box; width: min(420px, 100%); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg, 16px); box-shadow: var(--dsw-elevation-prominent); padding: 18px; display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary); }
.gwmb-modal h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); text-transform: none; letter-spacing: 0; }
.gwmb-modal-message { font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.gwmb-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
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
.gwmb-faq { display: flex; flex-direction: column; gap: 3px; padding: 10px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.gwmb-faq:last-of-type { border-bottom: none; padding-bottom: 0; }
.gwmb-faq-q { font-size: 13px; color: var(--dsw-alias-label-primary); }
.gwmb-filter-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.gwmb-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.gwmb-toolbar > h3 { margin: 0; flex: 0 0 auto; }
.gwmb-toolbar-end { margin-left: auto; flex: 0 0 auto; }
.gwmb-btn.gwmb-btn-icon { width: 30px; padding: 0; justify-content: center; }
/* Icon button that stays pressed/tinted while its option is enabled. */
.gwmb-btn.gwmb-btn-icon-on { color: var(--dsw-alias-link); border-color: color-mix(in srgb, var(--dsw-alias-link) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-link) 12%, transparent); }
.gwmb-btn.gwmb-btn-icon-on:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-link) 18%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-link) 50%, transparent); }
/* Press feedback for every action that is not a toggle. */
.gwmb-btn:active:not(:disabled), .gwmb-icon-btn:active:not(:disabled) { transform: translateY(1px); background: var(--dsw-alias-interactive-bg-active); }
.gwmb-refresh-note { animation: gwmb-fade-in .18s ease-out; }
@keyframes gwmb-fade-in { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
.gwmb-spin { animation: gwmb-spin .9s linear infinite; }
@keyframes gwmb-spin { to { transform: rotate(360deg); } }
.gwmb-input.gwmb-search { flex: 1 1 160px; width: 160px; min-width: 140px; max-width: 300px; box-sizing: border-box; }
.gwmb-check-list { display: flex; flex-direction: column; }
.gwmb-check-row { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 13px; }
.gwmb-check-row:last-child { border-bottom: none; }
.gwmb-check-name { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.gwmb-check-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.gwmb-check-state { font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.gwmb-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.gwmb-dot-ok { background: var(--dsw-alias-state-success-primary); }
.gwmb-dot-bad { background: var(--dsw-alias-state-error-primary); }
.gwmb-approval-list { display: flex; flex-direction: column; }
.gwmb-approval { display: flex; flex-direction: column; gap: 3px; padding: 9px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.gwmb-approval:last-child { border-bottom: none; }
.gwmb-approval-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.gwmb-approval-tool { font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 12px; color: var(--dsw-alias-label-primary); }
.gwmb-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px 18px; }
.gwmb-form-wide { grid-column: 1 / -1; }
.gwmb-form-row { display: flex; flex-direction: column; gap: 5px; font-size: 13px; min-width: 0; }
.gwmb-form-row > span:first-child { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.gwmb-setting { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 8px 16px; align-items: center; }
.gwmb-setting > .gwmb-select { justify-self: start; width: 160px; max-width: 100%; }
.gwmb-setting-label { font-size: 13px; color: var(--dsw-alias-label-secondary); }
.gwmb-input { box-sizing: border-box; width: 100%; font-size: 13px; font-family: inherit; padding: 6px 9px; border-radius: var(--dsw-radius-md, 10px); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.gwmb-input:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-link)); outline-offset: 1px; }
.gwmb-textarea { box-sizing: border-box; width: 100%; min-height: 84px; resize: vertical; font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 12px; padding: 8px 10px; border-radius: var(--dsw-radius-md, 10px); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.gwmb-textarea:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-link)); outline-offset: 1px; }
/* ---- visual polish pass: spacing, pills, surfaces, tables ---- */
.gwmb-page { padding: 24px clamp(16px, 4vw, 40px) 16px; gap: 16px; }
.gwmb-title { font-size: 24px; letter-spacing: -0.01em; }
.gwmb-sub { margin-top: 4px; }
.gwmb-head { align-items: center; }
.gwmb-btn { height: 30px; padding: 0 12px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-size: 13px; border-radius: var(--dsw-radius-md, 10px); border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.gwmb-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l2); }
.gwmb-btn:disabled { opacity: .45; }
.gwmb-btn-sm { height: 26px; padding: 0 10px; font-size: 12px; }
.gwmb-btn-primary { background: var(--dsw-alias-button-primary-fill); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); }
.gwmb-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.gwmb-btn-danger { background: var(--dsw-alias-state-error-primary); border-color: transparent; color: #fff; }
.gwmb-btn-danger:hover:not(:disabled) { filter: brightness(1.08); }
/* Destructive but secondary: a tinted red outline keeps 断开/拒绝 visible without
   competing with the primary action. */
.gwmb-btn-danger-soft { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 32%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.gwmb-btn-danger-soft:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 44%, transparent); }
.gwmb-tabs { display: inline-flex; align-self: flex-start; gap: 2px; padding: 3px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg, 16px); background: var(--dsw-alias-bg-layer-1); }
.gwmb-tab { height: 28px; padding: 0 14px; border-radius: var(--dsw-radius-md, 10px); font-size: 13px; color: var(--dsw-alias-label-secondary); display: inline-flex; align-items: center; }
.gwmb-tab:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.gwmb-tab-active, .gwmb-tab-active:hover { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-weight: 600; }
.gwmb-card { padding: 16px 18px; gap: 8px; }
.gwmb-card h3 { letter-spacing: .05em; }
.gwmb-inline-value { font-size: 20px; }
.gwmb-input, .gwmb-select, .gwmb-textarea { min-height: 32px; border-color: var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.gwmb-input:hover:not(:disabled), .gwmb-select:hover:not(:disabled), .gwmb-textarea:hover { border-color: var(--dsw-alias-border-l2); }
.gwmb-table th { padding: 9px 12px; background: var(--dsw-alias-bg-layer-2); }
.gwmb-table td { padding: 10px 12px; }
.gwmb-table tbody tr:hover td { background: var(--dsw-alias-interactive-bg-hover); }
.gwmb-log { padding: 6px 8px; border-radius: var(--dsw-radius-sm, 6px); }
.gwmb-log:hover { background: var(--dsw-alias-interactive-bg-hover); }
.gwmb-link-field { padding: 10px 12px; gap: 6px; }
.gwmb-modal { padding: 20px; gap: 14px; width: min(440px, 100%); }
.gwmb-modal-wide { width: min(600px, 100%); }
.gwmb-status { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 18px; }
.gwmb-status-ok { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); }
.gwmb-status-warn { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent); }
.gwmb-status-bad { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); }
.gwmb-access-row { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 10px; align-items: start; }
.gwmb-access-name { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
/* ---- alignment, spacing and hierarchy ---- */
.gwmb-card > h3 { font-size: 13px; font-weight: 600; letter-spacing: 0; color: var(--dsw-alias-label-primary); margin: 0 0 2px; }
.gwmb-info-head { justify-content: space-between; align-items: center; width: 100%; }
.gwmb-info-head h3 { margin: 0; }
.gwmb-form { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 24px; align-items: start; }
@media (max-width: 720px) { .gwmb-form { grid-template-columns: minmax(0, 1fr); } }
.gwmb-form-row > span:first-child { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.gwmb-form-row > .gwmb-meta { line-height: 1.5; }
.gwmb-form-row > .gwmb-input, .gwmb-form-row > .gwmb-select, .gwmb-form-row > .gwmb-textarea { width: 100%; }
.gwmb-footer-actions { margin-top: 2px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); }
.gwmb-grid { align-items: stretch; }
.gwmb-inline { align-items: center; }
.gwmb-card { gap: 10px; }
.gwmb-row { gap: 10px; }
.gwmb-note { line-height: 1.6; }
.gwmb-switch-row { display: flex; align-items: center; gap: 10px; min-height: 32px; }
/* Mirrors the DSH settings switch geometry: 36x20 track, 2px inset padding,
   16px thumb, border-radius 999px and corner-shape round. Only the checked
   color differs (theme blue instead of the host brand fill). Geometry uses a
   doubled class so host button rules cannot re-round or resize the track. */
button.gwmb-switch.gwmb-switch { box-sizing: border-box; position: relative; display: inline-flex; align-items: center; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; corner-shape: round; cursor: pointer; }
.gwmb-switch-knob { display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-switch-thumb); transition: transform .12s ease; }
.gwmb-switch { background: var(--dsw-alias-border-l3); }
.gwmb-switch:hover, .gwmb-switch:focus, .gwmb-switch:active { background: var(--dsw-alias-border-l3); }
.gwmb-switch-on { background: var(--dsw-static-blue-600, #2563eb); }
.gwmb-switch-on:hover, .gwmb-switch-on:focus, .gwmb-switch-on:active { background: var(--dsw-static-blue-600, #2563eb); }
body[data-ds-dark-theme] .gwmb-switch-on, body[data-ds-dark-theme] .gwmb-switch-on:hover, body[data-ds-dark-theme] .gwmb-switch-on:focus, body[data-ds-dark-theme] .gwmb-switch-on:active { background: var(--dsw-static-deepseek-400, #7aaaff); }
.gwmb-switch-on .gwmb-switch-knob { transform: translateX(16px); background: var(--dsw-static-neutral-bluish-00, #fff); }
body[data-ds-dark-theme] .gwmb-switch-on .gwmb-switch-knob { background: var(--dsw-static-neutral-bluish-1000, #0f1115); }
.gwmb-switch:disabled { cursor: default; opacity: .5; }
.gwmb-switch:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-link))); outline-offset: 2px; }
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
      <div className="gwmb-inline gwmb-info-head">
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

function Modal(props: {
  title: string
  children: ReactNode
  actions: ReactNode
  onClose: () => void
  wide?: boolean
}): ReactElement {
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
        className={`gwmb-modal ${props.wide === true ? 'gwmb-modal-wide' : ''}`}
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

function Toggle(props: { checked: boolean; disabled?: boolean; label?: string; onChange: (value: boolean) => void }): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      className={`gwmb-switch ${props.checked ? 'gwmb-switch-on' : ''}`}
      disabled={props.disabled === true}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="gwmb-switch-knob" />
    </button>
  )
}

function ConfirmDialog(props: { state: ConfirmState; busy?: boolean; onClose: () => void }): ReactElement {  const { state } = props
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

function RefreshIcon(props: { size?: number; spinning?: boolean }): ReactElement {
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
      className={props.spinning === true ? 'gwmb-spin' : undefined}
    >
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4.5V11h-6.5" />
    </svg>
  )
}

/** Two-arrow loop glyph for the auto-refresh toggle. */
function AutoRefreshIcon(props: { size?: number }): ReactElement {
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
      <path d="M4.5 9.5A8 8 0 0 1 18 6.5" />
      <path d="M18 2.8v3.9h-3.9" />
      <path d="M19.5 14.5A8 8 0 0 1 6 17.5" />
      <path d="M6 21.2v-3.9h3.9" />
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
          <h3>远程访问</h3>
          <div className="gwmb-access-row">
            <span className="gwmb-access-name">隧道配对</span>
            <span className="gwmb-meta">
              用手机扫码或打开配对链接，经公网隧道访问本工作台；手机端按安全策略只读，可查看概览与设备状态，不能管理。
            </span>
          </div>
          <div className="gwmb-access-row">
            <span className="gwmb-access-name">微信通道</span>
            <span className="gwmb-meta">
              在「微信」页签扫码登录并在本机点「允许连接」后，可通过微信接收审批、提问与完成通知，并在微信里直接处理。
            </span>
          </div>
          <div className="gwmb-meta gwmb-muted">
            配对码、设备、日志与设置等管理操作仅在本机 DSH UI 完成；独立管理台可通过页头按钮打开，关闭兼容模式后隐藏。
          </div>
        </section>
      ) : null}
      {props.bridgeReady && ping && !ping.local ? (
        <section className="gwmb-card">
          <h3>只读视图</h3>
          <p className="gwmb-note">
            当前页面经移动端网关打开，按安全策略仅展示只读概览。配对码、设备、日志与设置等管理操作请在本机 DSH UI 完成。
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

interface PairingSettingsForm {
  tunnelEnabled: boolean
  proxyTimeoutMs: string
  sessionDays: string
  pairingMinutes: string
}

function toPairingSettingsForm(view: SettingsView): PairingSettingsForm {
  return {
    tunnelEnabled: view.runtime?.tunnelEnabled !== false,
    proxyTimeoutMs: view.runtime?.proxyRequestTimeoutMs ? String(view.runtime.proxyRequestTimeoutMs) : '',
    sessionDays: view.sessionMaxAge ? String(Math.round(view.sessionMaxAge / 86400)) : '1',
    pairingMinutes: view.pairingTokenExpiry ? String(Math.round(view.pairingTokenExpiry / 60)) : '15',
  }
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
  const [settings, setSettings] = useState<PairingSettingsForm | null>(null)
  const [limits, setLimits] = useState<SettingsView['limits']>(undefined)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settingsMessage, setSettingsMessage] = useState('')
  const [settingsError, setSettingsError] = useState('')

  const loadSettings = useCallback(async (): Promise<void> => {
    try {
      const view = await apiGet<SettingsView>('/api/gateway-mobile/read/settings')
      setSettings(toPairingSettingsForm(view))
      setLimits(view.limits)
      setSettingsError('')
    } catch (cause) {
      setSettingsError(messageOf(cause))
    }
  }, [])

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
    void loadSettings()
    const timer = window.setInterval(() => setTick(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [load, loadSettings])

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

  const updateSetting = <K extends keyof PairingSettingsForm,>(key: K, value: PairingSettingsForm[K]): void => {
    setSettings((current) => (current === null ? current : { ...current, [key]: value }))
    setSettingsMessage('')
  }

  const saveSettings = async (): Promise<void> => {
    if (!settings) return
    setSettingsBusy(true)
    setSettingsMessage('')
    setSettingsError('')
    try {
      const patch: Record<string, unknown> = {
        tunnelEnabled: settings.tunnelEnabled,
        sessionMaxAge: Math.round(Number(settings.sessionDays) * 86400),
        pairingTokenExpiry: Math.round(Number(settings.pairingMinutes) * 60),
      }
      if (settings.proxyTimeoutMs.trim() !== '') {
        patch.proxyRequestTimeoutMs = Math.round(Number(settings.proxyTimeoutMs))
      }
      const view = await apiPost<SettingsView>('/api/gateway-mobile/admin/settings', patch)
      setSettings(toPairingSettingsForm(view))
      setLimits(view.limits)
      setSettingsMessage('设置已保存并生效')
    } catch (cause) {
      setSettingsError(messageOf(cause))
    } finally {
      setSettingsBusy(false)
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

      <section className="gwmb-card">
        <h3>隧道与配对设置</h3>
        <div className="gwmb-meta gwmb-muted">
          这些配置决定手机如何连上本机、登录状态保持多久，以及配对码能使用多长时间。
        </div>
        {settings ? (
          <div className="gwmb-form">
            <div className="gwmb-form-row">
              <span>隧道开关</span>
              <div className="gwmb-switch-row">
                <Toggle
                  checked={settings.tunnelEnabled}
                  label="隧道开关"
                  onChange={(value) => updateSetting('tunnelEnabled', value)}
                />
                <span className="gwmb-meta">{settings.tunnelEnabled ? '已启用' : '已关闭'}</span>
              </div>
              <span className="gwmb-meta gwmb-muted">启用后手机可通过公网隧道访问；关闭后仅本机可访问。</span>
            </div>
            <label className="gwmb-form-row">
              <span>DSH 代理超时（毫秒）</span>
              <input
                className="gwmb-input"
                type="number"
                min="1000"
                placeholder="留空使用默认值"
                value={settings.proxyTimeoutMs}
                onChange={(event) => updateSetting('proxyTimeoutMs', event.target.value)}
              />
              <span className="gwmb-meta gwmb-muted">手机经隧道请求 DSH 时最多等待多久；超时会显示网关错误。留空沿用默认值。</span>
            </label>
            <label className="gwmb-form-row">
              <span>设备会话时长（天）</span>
              <input
                className="gwmb-input"
                type="number"
                min="1"
                value={settings.sessionDays}
                onChange={(event) => updateSetting('sessionDays', event.target.value)}
              />
              <span className="gwmb-meta gwmb-muted">
                手机配对后保持登录的有效期，到期需重新配对。最短约 5 分钟，最长{' '}
                {limits?.sessionMax ? Math.round(limits.sessionMax / 86400) : 90} 天。
              </span>
            </label>
            <label className="gwmb-form-row">
              <span>配对码有效期（分钟）</span>
              <input
                className="gwmb-input"
                type="number"
                min="1"
                value={settings.pairingMinutes}
                onChange={(event) => updateSetting('pairingMinutes', event.target.value)}
              />
              <span className="gwmb-meta gwmb-muted">
                配对二维码 / 配对链接的可用时间，过期后需重新生成。允许{' '}
                {limits?.pairingMin ? Math.max(1, Math.round(limits.pairingMin / 60)) : 1}–
                {limits?.pairingMax ? Math.round(limits.pairingMax / 60) : 1440} 分钟。
              </span>
            </label>
          </div>
        ) : (
          <div className="gwmb-meta">正在读取设置…</div>
        )}
        <div className="gwmb-actions">
          <button
            className="gwmb-btn gwmb-btn-primary"
            type="button"
            disabled={settingsBusy || settings === null}
            onClick={() => void saveSettings()}
          >
            {settingsBusy ? '保存中…' : '保存设置'}
          </button>
        </div>
        {settingsMessage ? <div className="gwmb-meta gwmb-ok">{settingsMessage}</div> : null}
        {settingsError ? <div className="gwmb-meta gwmb-bad">{settingsError}</div> : null}
        <div className="gwmb-meta gwmb-muted">
          修改立即生效并持久化，无需重启 DSH；配对码有效期仅影响之后生成的配对码。
        </div>
      </section>
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
  const [filter, setFilter] = useState<'all' | 'online' | 'inactive'>('all')

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

  const runRevokeAll = async (): Promise<void> => {
    setBusy('revoke-all')
    setActionError('')
    setMessage('')
    try {
      const payload = await apiPost<{ revoked: number; devices: DeviceView[] }>(
        '/api/gateway-mobile/admin/devices/revoke-all',
        { confirmText: 'REVOKE ALL' },
      )
      setDevices(payload.devices)
      setMessage(`已撤销 ${payload.revoked} 台设备`)
    } catch (cause) {
      setActionError(messageOf(cause))
    } finally {
      setBusy('')
    }
  }

  const revokeAll = (): void => {
    setConfirmState({
      title: '撤销全部设备',
      message: '撤销所有尚未撤销的设备？包括本机在内，所有已配对设备都会立即失效，需要重新配对才能访问。',
      confirmText: '全部撤销',
      danger: true,
      action: () => void runRevokeAll(),
    })
  }

  if (error) {
    return (
      <ErrorCard title="设备列表不可用">
        <div className="gwmb-meta">{error}</div>
      </ErrorCard>
    )
  }

  const total = devices?.length ?? 0
  const activeCount = (devices ?? []).filter((device) => !device.revoked && !device.expired).length
  const filteredDevices = (devices ?? []).filter((device) => {
    if (filter === 'online') return device.isOnline && !device.revoked && !device.expired
    if (filter === 'inactive') return device.revoked || device.expired
    return true
  })

  return (
    <>
      <section className="gwmb-card">
        <div className="gwmb-row" style={{ justifyContent: 'space-between' }}>
          <h3>已配对设备（{total}）</h3>
          <div className="gwmb-actions">
            <button
              className="gwmb-btn gwmb-btn-sm"
              type="button"
              disabled={busy !== '' || activeCount === 0}
              onClick={() => void revokeAll()}
            >
              {busy === 'revoke-all' ? '撤销中…' : '撤销全部设备'}
            </button>
            <button
              className="gwmb-btn gwmb-btn-sm"
              type="button"
              disabled={busy !== '' || total - activeCount === 0}
              onClick={() => void purge()}
            >
              {busy === 'purge' ? '清理中…' : '清理已撤销/过期'}
            </button>
          </div>
        </div>
        <div className="gwmb-filter-bar">
          <button
            className={`gwmb-btn gwmb-btn-sm ${filter === 'all' ? 'gwmb-btn-primary' : ''}`}
            type="button"
            onClick={() => setFilter('all')}
          >
            全部（{total}）
          </button>
          <button
            className={`gwmb-btn gwmb-btn-sm ${filter === 'online' ? 'gwmb-btn-primary' : ''}`}
            type="button"
            onClick={() => setFilter('online')}
          >
            在线（{(devices ?? []).filter((device) => device.isOnline && !device.revoked && !device.expired).length}）
          </button>
          <button
            className={`gwmb-btn gwmb-btn-sm ${filter === 'inactive' ? 'gwmb-btn-primary' : ''}`}
            type="button"
            onClick={() => setFilter('inactive')}
          >
            已撤销/过期（{total - activeCount}）
          </button>
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
            {(devices ?? []).length > 0 && filteredDevices.length === 0 ? (
              <tr>
                <td colSpan={6} className="gwmb-muted">
                  当前筛选下没有设备。
                </td>
              </tr>
            ) : null}
            {filteredDevices.map((device) => {
              const tone = device.revoked || device.expired ? 'gwmb-status-bad' : device.isOnline ? 'gwmb-status-ok' : 'gwmb-status-warn'
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
                    {device.oauthBindings && device.oauthBindings.length > 0 ? (
                      <div className="gwmb-device-ua">
                        {device.oauthBindings.map((binding) => `${binding.provider}: @${binding.username}`).join(' · ')}
                      </div>
                    ) : null}
                  </td>
                  <td className="gwmb-nowrap">
                    <span className={`gwmb-status ${tone}`}>{state}</span>
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

/** Inline two-month range picker: drag or click two days to select a range. */
function DateRangePicker(props: {
  value: DateRangeValue | null
  onChange: (value: DateRangeValue | null) => void
}): ReactElement {
  const [view, setView] = useState(() => (props.value ? new Date(props.value.start) : new Date()))
  const [preview, setPreview] = useState<{ anchor: number; end: number } | null>(null)
  const anchorRef = useRef<number | null>(null)
  const previewRef = useRef<{ anchor: number; end: number } | null>(null)

  const setPreviewBoth = (value: { anchor: number; end: number } | null): void => {
    previewRef.current = value
    setPreview(value)
  }

  useEffect(() => {
    const finish = (): void => {
      const anchor = anchorRef.current
      if (anchor === null) return
      const end = previewRef.current?.end ?? anchor
      anchorRef.current = null
      setPreviewBoth(null)
      props.onChange({ start: dayStart(Math.min(anchor, end)), end: dayEnd(Math.max(anchor, end)) })
    }
    window.addEventListener('mouseup', finish)
    return () => window.removeEventListener('mouseup', finish)
  }, [props])

  const activeRange: [number, number] | null = preview
    ? [dayStart(Math.min(preview.anchor, preview.end)), dayStart(Math.max(preview.anchor, preview.end))]
    : props.value
      ? [dayStart(props.value.start), dayStart(props.value.end)]
      : null

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
            const isStart = activeRange !== null && ms === activeRange[0]
            const isEnd = activeRange !== null && ms === activeRange[1]
            const inRange = activeRange !== null && ms > activeRange[0] && ms < activeRange[1]
            const today = ms === dayStart(Date.now())
            const classes = [
              'gwmb-cal-day',
              isStart || isEnd ? 'gwmb-cal-day-edge' : '',
              inRange ? 'gwmb-cal-day-inrange' : '',
              today ? 'gwmb-cal-day-today' : '',
            ]
              .filter(Boolean)
              .join(' ')
            return (
              <button
                key={ms}
                type="button"
                className={classes}
                onMouseDown={(event) => {
                  event.preventDefault()
                  anchorRef.current = ms
                  setPreviewBoth({ anchor: ms, end: ms })
                }}
                onMouseEnter={() => {
                  const anchor = anchorRef.current
                  if (anchor === null) return
                  setPreviewBoth({ anchor, end: ms })
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
    <div className="gwmb-range-inline">
      <div className="gwmb-range-nav">
        <button
          className="gwmb-icon-btn"
          type="button"
          title="上个月"
          aria-label="上个月"
          onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}
        >
          ‹
        </button>
        <span className="gwmb-meta">
          {props.value
            ? `已选 ${formatDay(props.value.start)} ~ ${formatDay(props.value.end)}`
            : '按住开始日期拖到结束日期，或依次点击两天'}
        </span>
        <button
          className="gwmb-icon-btn"
          type="button"
          title="下个月"
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
            setPreviewBoth(null)
            props.onChange(null)
          }}
        >
          清除选择
        </button>
      </div>
    </div>
  )
}
const HEALTH_LABELS: Record<string, string> = {
  gateway: '网关',
  storage: '存储',
  'dsh-upstream': 'DSH 上游',
  tunnel: '公网隧道',
  weixin: '微信 Bot',
  capabilities: '能力矩阵',
}

function healthStateText(check: HealthCheckView): string {
  if (check.optional === true && check.detail === 'disabled') return '未启用'
  return check.ok ? '正常' : '异常'
}

function saveJsonFile(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function HelpTab(props: { ping: PingView | null }): ReactElement {
  const { ping } = props
  const tunnel = ping?.tunnel
  const [health, setHealth] = useState<HealthView | null>(null)
  const [healthError, setHealthError] = useState('')
  const [checking, setChecking] = useState(false)
  const [latency, setLatency] = useState<number | null>(null)
  const [notice, setNotice] = useState('')

  const runChecks = useCallback(async (): Promise<void> => {
    setChecking(true)
    setNotice('')
    setHealthError('')
    const started = performance.now()
    try {
      const payload = await apiGet<HealthView>('/api/gateway-mobile/read/health')
      setHealth(payload)
      setLatency(Math.max(1, Math.round(performance.now() - started)))
    } catch (cause) {
      setHealth(null)
      setHealthError(messageOf(cause))
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void runChecks()
  }, [runChecks])

  const checks = health?.checks ?? []
  const failed = checks.filter((check) => !check.ok && !(check.optional === true && check.detail === 'disabled'))
  const healthy = health !== null && health.ok && failed.length === 0
  const overview: Array<[string, string]> = [
    ['网关地址', ping ? `127.0.0.1:${ping.gateway.port}` : '—'],
    ['运行时长', formatUptime(health?.uptime ?? ping?.gateway.uptime ?? 0)],
    ['服务器时间', health?.serverTime ?? ping?.serverTime ?? '—'],
    ['隧道状态', tunnel ? `${tunnel.state} · ${tunnel.mode} · ${tunnel.protocol}` : '—'],
    ['公网地址', tunnel?.publicBase || '隧道未连接'],
    ['本机往返延迟', latency === null ? '—' : `${latency} ms`],
    ['浏览器安全上下文', window.isSecureContext ? '是' : '否'],
  ]
  const capabilityRows: Array<[string, string, boolean]> = [
    ['DSH 控制器', '会话 / 审批 / 提问接口', ping?.capabilities.controller === true],
    ['工作区注册', '多工作区会话与状态', ping?.capabilities.workspaceRegistry === true],
    ['用户提问', 'ask_user_question 桥接', ping?.capabilities.userQuestions === true],
    ['微信通道', 'ClawBot / iLink 消息桥', ping?.capabilities.weixin === true],
    ['公网隧道', 'Quick / Named Tunnel', ping?.capabilities.tunnel?.enabled === true],
  ]
  const faq: Array<[string, string]> = [
    ['手机打不开工作台？', '先看概览里的隧道状态；地址变化后旧链接会失效，需要重新配对。隧道未连接时手机无法访问。'],
    ['扫码后提示配对码无效或过期？', '配对码有有效期，过期后请在「配对」页重新生成，再让手机扫描新的二维码。'],
    ['微信收不到审批或完成通知？', '确认「微信」页签已连接、通知设置里通道与完成通知均已开启，并检查频率限制是否把消息合并了。'],
    ['独立管理台打不开？', '可能是兼容模式被关闭；在「设置 → 独立管理台」重新启用即可，回环 API 不受影响。'],
    ['如何彻底停用远程访问？', '在「配对」页关闭隧道开关，并在「设备」页撤销全部设备，手机端将立即失效。'],
  ]

  const diagnosticsPayload = (): unknown => ({
    generatedAt: new Date().toISOString(),
    health,
    ping,
    latencyMs: latency,
    browser: { userAgent: navigator.userAgent, secureContext: window.isSecureContext },
  })

  const copyDiagnostics = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnosticsPayload(), null, 2))
      setNotice('诊断信息已复制到剪贴板')
    } catch {
      setNotice('浏览器不允许写剪贴板，请改用「下载 JSON」')
    }
  }

  const downloadDiagnostics = (): void => {
    saveJsonFile(
      `gateway-mobile-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      diagnosticsPayload(),
    )
    setNotice('诊断 JSON 已下载')
  }

  return (
    <>
      <section className="gwmb-card">
        <div className="gwmb-row" style={{ justifyContent: 'space-between' }}>
          <h3>诊断信息</h3>
          <span
            className={`gwmb-status ${healthError ? 'gwmb-status-bad' : healthy ? 'gwmb-status-ok' : 'gwmb-status-warn'}`}
          >
            {checking ? '检查中…' : healthError ? '不可用' : healthy ? '全部正常' : '存在异常'}
          </span>
        </div>
        <dl className="gwmb-kv">
          {overview.map(([label, value]) => (
            <Fragment key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
        </dl>
        <div className="gwmb-actions">
          <button className="gwmb-btn gwmb-btn-sm" type="button" disabled={checking} onClick={() => void runChecks()}>
            {checking ? '检查中…' : '重新检查'}
          </button>
          <button className="gwmb-btn gwmb-btn-sm" type="button" onClick={() => void copyDiagnostics()}>
            复制诊断
          </button>
          <button className="gwmb-btn gwmb-btn-sm" type="button" onClick={downloadDiagnostics}>
            下载 JSON
          </button>
        </div>
        {healthError ? <div className="gwmb-meta gwmb-bad">深度健康检查不可用：{healthError}</div> : null}
        {notice ? <div className="gwmb-meta gwmb-ok">{notice}</div> : null}
      </section>

      <section className="gwmb-card">
        <h3>深度健康检查</h3>
        {health === null && !healthError ? <div className="gwmb-meta">正在检查…</div> : null}
        {health !== null && checks.length === 0 ? <div className="gwmb-meta">网关未返回检查项。</div> : null}
        <div className="gwmb-check-list">
          {checks.map((check) => (
            <div className="gwmb-check-row" key={check.name}>
              <span className={`gwmb-dot ${check.ok ? 'gwmb-dot-ok' : 'gwmb-dot-bad'}`} />
              <span className="gwmb-check-name">
                <span>{HEALTH_LABELS[check.name] ?? check.name}</span>
                {check.detail ? (
                  <span className="gwmb-check-detail" title={check.detail}>
                    {check.detail}
                  </span>
                ) : null}
              </span>
              <span className="gwmb-check-state">{healthStateText(check)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="gwmb-card">
        <h3>能力矩阵</h3>
        <div className="gwmb-check-list">
          {capabilityRows.map(([name, hint, available]) => (
            <div className="gwmb-check-row" key={name}>
              <span className={`gwmb-dot ${available ? 'gwmb-dot-ok' : 'gwmb-dot-bad'}`} />
              <span className="gwmb-check-name">
                <span>{name}</span>
                <span className="gwmb-check-detail">{hint}</span>
              </span>
              <span className="gwmb-check-state">{available ? '可用' : '不可用'}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="gwmb-card">
        <h3>手机端连通性</h3>
        <div className="gwmb-meta gwmb-muted">
          这里检查的是 DSH 本机回环；手机经公网隧道访问时，可用手机浏览器打开独立诊断页做 HTTP / WebSocket
          自检（需要本机兼容模式开启）。
        </div>
        {ping?.gateway.adminConsoleEnabled !== false ? (
          <div className="gwmb-actions">
            <a
              className="gwmb-btn"
              href={`${ping ? ping.gateway.adminUrl.replace(/\/admin\/?$/, '/diag') : '#'}`}
              target="_blank"
              rel="noreferrer"
            >
              打开独立诊断页
            </a>
          </div>
        ) : (
          <div className="gwmb-meta gwmb-muted">兼容模式已关闭；重新启用后可打开独立诊断页。</div>
        )}
      </section>

      <section className="gwmb-card">
        <h3>常见问题</h3>
        {faq.map(([question, answer]) => (
          <div className="gwmb-faq" key={question}>
            <div className="gwmb-faq-q">{question}</div>
            <div className="gwmb-meta gwmb-muted">{answer}</div>
          </div>
        ))}
      </section>
    </>
  )
}

const APPROVAL_LABELS: Record<string, string> = {
  pending: '待处理',
  allowed: '已允许',
  rejected: '已拒绝',
  timeout: '超时',
  cancelled: '已取消',
  unavailable: '不可用',
}

const APPROVAL_TONES: Record<string, string> = {
  allowed: 'gwmb-status-ok',
  rejected: 'gwmb-status-bad',
  pending: 'gwmb-status-warn',
  timeout: 'gwmb-status-warn',
  cancelled: 'gwmb-status-warn',
  unavailable: 'gwmb-status-warn',
}

function LogsTab(): ReactElement {
  const [view, setView] = useState<'runtime' | 'weixin'>('runtime')
  const [logs, setLogs] = useState<LogItem[] | null>(null)
  const [level, setLevel] = useState('all')
  const [query, setQuery] = useState('')
  const [auto, setAuto] = useState(true)
  const [error, setError] = useState('')
  const [approvals, setApprovals] = useState<ApprovalItem[] | null>(null)
  const [approvalsError, setApprovalsError] = useState('')
  const [approvalsBusy, setApprovalsBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportRange, setExportRange] = useState<'24h' | '7d' | '30d' | '90d' | 'custom' | 'all'>('24h')
  const [customRange, setCustomRange] = useState<DateRangeValue | null>(null)
  const [exportMessage, setExportMessage] = useState('')
  const [exportError, setExportError] = useState('')
  const [exportOpen, setExportOpen] = useState(false)

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
      const payload = await apiGet<{ items: ApprovalItem[] }>('/api/gateway-mobile/read/weixin/approvals')
      setApprovals(payload.items)
      setApprovalsError('')
    } catch (cause) {
      setApprovalsError(messageOf(cause))
    }
  }, [])

  useEffect(() => {
    void loadApprovals()
  }, [loadApprovals])

  const refreshApprovals = async (): Promise<void> => {
    setApprovalsBusy(true)
    try {
      await loadApprovals()
    } finally {
      setApprovalsBusy(false)
    }
  }

  useEffect(() => {
    void load()
    if (!auto) return undefined
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [load, auto])

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
  const keyword = query.trim().toLowerCase()
  const filtered = (logs ?? []).filter((item) => {
    if (level !== 'all' && item.level !== level) return false
    if (keyword === '') return true
    return item.message.toLowerCase().includes(keyword)
  })
  const newestFirst = [...filtered].sort((left, right) => {
    const a = Date.parse(left.timestamp)
    const b = Date.parse(right.timestamp)
    if (Number.isNaN(a) || Number.isNaN(b)) return 0
    return b - a
  })

  return (
    <>
      <section className="gwmb-card">
        <div className="gwmb-toolbar">
          <h3>日志</h3>
          {view === 'runtime' ? (
            <>
              <input
                className="gwmb-input gwmb-search"
                type="search"
                value={query}
                placeholder="搜索日志内容"
                aria-label="搜索日志内容"
                onChange={(event) => setQuery(event.target.value)}
              />
              <select
                className="gwmb-select gwmb-select-sm"
                aria-label="日志级别"
                value={level}
                onChange={(event) => setLevel(event.target.value)}
              >
                {levels.map((item) => (
                  <option key={item} value={item}>
                    {item === 'all' ? '全部级别' : item}
                  </option>
                ))}
              </select>
              <span className="gwmb-meta gwmb-muted gwmb-nowrap">
                {newestFirst.length === (logs?.length ?? 0)
                  ? `共 ${logs?.length ?? 0} 条`
                  : `共 ${logs?.length ?? 0} 条 · 显示 ${newestFirst.length} 条`}
              </span>
            </>
          ) : null}
          <div className="gwmb-actions gwmb-toolbar-end">
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
            <button className="gwmb-btn gwmb-btn-sm" type="button" onClick={() => setExportOpen(true)}>
              导出审计
            </button>
            <button
              className={`gwmb-btn gwmb-btn-icon ${auto ? 'gwmb-btn-icon-on' : ''}`}
              type="button"
              onClick={() => setAuto(!auto)}
              title={auto ? '自动刷新：已开启' : '自动刷新：已关闭'}
              aria-label="自动刷新"
              aria-pressed={auto}
            >
              <AutoRefreshIcon />
            </button>
          </div>
        </div>

        {view === 'runtime' ? (
          <div className="gwmb-log-list">
            {newestFirst.map((item, index) => (
              <div className="gwmb-log" key={`${item.timestamp}-${index}`}>
                <span className="gwmb-log-time">{formatTime(item.timestamp)}</span>
                <span className={item.level === 'error' ? 'gwmb-bad' : item.level === 'warn' ? 'gwmb-warn' : 'gwmb-muted'}>
                  {item.level}
                </span>
                <span className="gwmb-log-msg">{item.message}</span>
              </div>
            ))}
            {logs !== null && newestFirst.length === 0 ? (
              <div className="gwmb-meta">{keyword ? '没有匹配的日志。' : '暂无日志。'}</div>
            ) : null}
            {logs === null ? <div className="gwmb-meta">正在读取日志…</div> : null}
          </div>
        ) : (
          <>
            <div className="gwmb-row" style={{ justifyContent: 'flex-end' }}>
              <button
                className="gwmb-btn gwmb-btn-sm"
                type="button"
                disabled={approvalsBusy}
                onClick={() => void refreshApprovals()}
              >
                {approvalsBusy ? '刷新中…' : '刷新'}
              </button>
            </div>
            {approvalsError ? <div className="gwmb-meta gwmb-bad">{approvalsError}</div> : null}
            {approvals === null ? <div className="gwmb-meta">正在读取审批历史…</div> : null}
            {approvals !== null && approvals.length === 0 ? <div className="gwmb-meta">暂无审批记录</div> : null}
            <div className="gwmb-approval-list">
              {(approvals ?? []).map((item, index) => (
                <div className="gwmb-approval" key={`${item.id}-${index}`}>
                  <div className="gwmb-approval-head">
                    <span className="gwmb-meta gwmb-muted">
                      {Number.isFinite(item.at) ? new Date(item.at).toLocaleString() : '—'}
                    </span>
                    <span className={`gwmb-status ${APPROVAL_TONES[item.status] ?? 'gwmb-status-warn'}`}>
                      {APPROVAL_LABELS[item.status] ?? item.status}
                    </span>
                    <span className="gwmb-approval-tool">{item.toolName || '—'}</span>
                    <span className="gwmb-meta gwmb-muted">
                      {item.sessionId ? item.sessionId.slice(0, 8) : ''}
                    </span>
                  </div>
                  {item.reason ? <div className="gwmb-meta gwmb-muted">{item.reason}</div> : null}
                </div>
              ))}
            </div>
            <div className="gwmb-meta gwmb-muted">审批历史与微信审批、提问、计划审核相关；手机端不显示。</div>
          </>
        )}
      </section>

      {exportOpen ? (
        <Modal
          title="导出审计日志"
          wide={exportRange === 'custom'}
          onClose={() => setExportOpen(false)}
          actions={
            <>
              <button className="gwmb-btn" type="button" onClick={() => setExportOpen(false)}>
                关闭
              </button>
              <button
                className="gwmb-btn gwmb-btn-primary"
                type="button"
                disabled={exporting}
                onClick={() => void exportAudit()}
              >
                {exporting ? '导出中…' : '导出审计日志'}
              </button>
            </>
          }
        >
          <div className="gwmb-row">
            <span className="gwmb-setting-label">导出范围</span>
            <select
              className="gwmb-select"
              value={exportRange}
              disabled={exporting}
              aria-label="审计导出范围"
              onChange={(event) => {
                setExportRange(event.target.value as '24h' | '7d' | '30d' | '90d' | 'custom' | 'all')
                setExportMessage('')
                setExportError('')
              }}
            >
              <option value="24h">最近 24 小时</option>
              <option value="7d">最近 7 天</option>
              <option value="30d">最近 30 天</option>
              <option value="90d">最近 90 天</option>
              <option value="custom">自定义时间段</option>
              <option value="all">全部（最多 500 条）</option>
            </select>
          </div>
          {exportRange === 'custom' ? <DateRangePicker value={customRange} onChange={setCustomRange} /> : null}
          <div className="gwmb-meta gwmb-muted">
            导出为 JSON 文件，包含所选时间范围内的审计记录；自定义范围在日历里拖选起始/结束日期。
          </div>
          {exportMessage ? <div className="gwmb-meta gwmb-ok">{exportMessage}</div> : null}
          {exportError ? <div className="gwmb-meta gwmb-bad">{exportError}</div> : null}
        </Modal>
      ) : null}
    </>
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

  // 页签切走会卸载组件、丢掉本地扫码状态；回到微信页时向网关恢复进行中的
  // 扫码会话（等待扫码 / 已扫码 / 待本机确认），二维码和允许/拒绝按钮随之复原。
  useEffect(() => {
    void (async () => {
      try {
        const session = await apiGet<WeixinLoginView>('/api/gateway-mobile/admin/weixin/login')
        if (session.qrSvg && ['wait', 'scaned', 'pending'].includes(session.state)) setLogin(session)
      } catch {
        // 没有进行中的扫码会话：保持当前页面即可
      }
    })()
  }, [])

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

  const doRebind = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      // 换绑 = 断开当前凭证，再请求一张新的登录二维码。
      await apiPost('/api/gateway-mobile/admin/weixin/logout')
      const next = await apiPost<WeixinLoginView>('/api/gateway-mobile/admin/weixin/login')
      setLogin(next)
      setMessage('请用新的微信扫码，并在本机点「允许连接」')
      await load()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const rebind = (): void => {
    setConfirmState({
      title: '换绑微信',
      message:
        '换绑会断开当前微信，并重置微信专用的 DSH 会话。旧微信号之后不会再收到 DSH 回复；新号扫码确认后会自动连接。',
      confirmText: '继续换绑',
      danger: true,
      action: () => void doRebind(),
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
              <div className="gwmb-actions">
                <button className="gwmb-btn" type="button" disabled={busy} onClick={rebind}>
                  换绑微信
                </button>
                <button className="gwmb-btn gwmb-btn-danger-soft" type="button" disabled={busy} onClick={logout}>
                  断开微信
                </button>
              </div>
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
        <div className="gwmb-meta gwmb-muted">
          决定微信是否作为通知通道，以及完成通知的合并与发送频率。
        </div>
        <div className="gwmb-form">
          <div className="gwmb-form-row">
            <span>微信通道</span>
            <div className="gwmb-switch-row">
              <Toggle checked={form.enabled} label="微信通道" onChange={(value) => update('enabled', value)} />
              <span className="gwmb-meta">{form.enabled ? '已启用' : '已禁用'}</span>
            </div>
            <span className="gwmb-meta gwmb-muted">启用后微信可作为远程通知与审批通道；禁用后不再转发任何消息。</span>
          </div>
          <div className="gwmb-form-row">
            <span>完成通知</span>
            <div className="gwmb-switch-row">
              <Toggle
                checked={form.notifyEnabled}
                label="完成通知"
                onChange={(value) => update('notifyEnabled', value)}
              />
              <span className="gwmb-meta">{form.notifyEnabled ? '已启用' : '已禁用'}</span>
            </div>
            <span className="gwmb-meta gwmb-muted">智能体完成任务时推送通知；关闭后只保留审批与提问消息。</span>
          </div>
          <label className="gwmb-form-row">
            <span>合并窗口（秒）</span>
            <input
              className="gwmb-input"
              type="number"
              min="1"
              value={form.debounceSeconds}
              onChange={(event) => update('debounceSeconds', event.target.value)}
            />
            <span className="gwmb-meta gwmb-muted">窗口内的连续完成消息合并为一条推送。</span>
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
            <span className="gwmb-meta gwmb-muted">同一会话两次推送之间的最小间隔。</span>
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
            <span className="gwmb-meta gwmb-muted">不同会话之间推送的最小间隔。</span>
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
            <span className="gwmb-meta gwmb-muted">每小时最多推送的完成通知条数。</span>
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
  logLevel: string
  adminConsoleEnabled: boolean
}

function toSettingsForm(settings: SettingsView): SettingsForm {
  return {
    logLevel: settings.runtime?.logLevel ?? 'info',
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
  const [keys, setKeys] = useState<KeyView | null>(null)
  const [oauth, setOAuth] = useState<OAuthView | null>(null)
  const [oauthText, setOAuthText] = useState('')
  const [maintenanceBusy, setMaintenanceBusy] = useState('')
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)
  const [version, setVersion] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const settingsPayload = await apiGet<SettingsView>('/api/gateway-mobile/read/settings')
      setForm(toSettingsForm(settingsPayload))
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

  const save = async (): Promise<void> => {
    if (!form) return
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const patch: Record<string, unknown> = {
        logLevel: form.logLevel,
        adminConsoleEnabled: form.adminConsoleEnabled,
      }
      const payload = await apiPost<SettingsView>('/api/gateway-mobile/admin/settings', patch)
      setForm(toSettingsForm(payload))
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

  if (error && form === null) {
    return (
      <ErrorCard title="设置不可用">
        <div className="gwmb-meta">{error}</div>
        <div className="gwmb-note">只读与设置修改都需要本机 DSH UI；手机端为只读视图。</div>
      </ErrorCard>
    )
  }
  if (form === null) return <div className="gwmb-meta">正在读取设置…</div>

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
        <h3>日志级别</h3>
        <div className="gwmb-setting">
          <span className="gwmb-setting-label">运行日志级别</span>
          <select className="gwmb-select" value={form.logLevel} onChange={(event) => update('logLevel', event.target.value)}>
            {levels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </div>
        <div className="gwmb-meta gwmb-muted">修改后立即生效，用于控制服务端与控制台输出的详细程度。</div>
      </section>

      <section className="gwmb-card">
        <h3>密钥</h3>
        <div className="gwmb-inline">
          <span className="gwmb-meta">
            {keys?.available
              ? `活动 ${keys.activeKid || '—'} · 全部 ${keys.keyIds.join(', ') || '—'}`
              : '密钥状态不可用'}
          </span>
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
        <div className="gwmb-meta gwmb-muted">轮换后新会话使用新密钥，旧会话仍可验证。</div>
      </section>

      <section className="gwmb-card">
        <h3>OAuth 白名单</h3>
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
        <div className="gwmb-meta">
          {oauth
            ? `已启用 provider：${oauth.providers.join(', ') || '无'}${oauth.requireOAuth ? ' · 强制绑定' : ''}`
            : 'OAuth 状态不可用'}
        </div>
      </section>

      <section className="gwmb-card">
        <h3>独立管理台</h3>
        <div className="gwmb-form-row">
          <span>兼容模式</span>
          <div className="gwmb-switch-row">
            <Toggle
              checked={form.adminConsoleEnabled}
              label="兼容模式"
              onChange={(value) => update('adminConsoleEnabled', value)}
            />
            <span className="gwmb-meta">{form.adminConsoleEnabled ? '已启用' : '已禁用'}</span>
          </div>
          <span className="gwmb-meta gwmb-muted">
            启用后本机可打开 /mobile/admin 独立管理台；禁用后独立页面与 /admin 跳转返回 404，回环 API 仍保留，工作台成为唯一管理入口。
          </span>
        </div>
      </section>

      <div className="gwmb-actions gwmb-footer-actions">
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
        修改立即生效并持久化，无需重启 DSH；独立管理台关闭后，工作台即为唯一管理入口。
      </div>

      {confirmState ? (
        <ConfirmDialog
          state={confirmState}
          busy={maintenanceBusy !== ''}
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
  const [refreshNotice, setRefreshNotice] = useState('')
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

  // Manual refresh: keep the spinner visible long enough to register, then
  // confirm the result in the header so a fast round-trip still feels handled.
  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setRefreshNotice('')
    const started = performance.now()
    await load({ silent: true })
    const elapsed = performance.now() - started
    if (elapsed < 400) await new Promise((resolve) => window.setTimeout(resolve, 400 - elapsed))
    setLoading(false)
    setRefreshNotice('已刷新')
  }, [load])

  useEffect(() => {
    if (refreshNotice === '') return undefined
    const timer = window.setTimeout(() => setRefreshNotice(''), 1600)
    return () => window.clearTimeout(timer)
  }, [refreshNotice])

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
          { id: 'help' as Tab, label: '帮助' },
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
          {refreshNotice ? (
            <span className="gwmb-meta gwmb-ok gwmb-refresh-note" role="status">
              {refreshNotice}
            </span>
          ) : null}
          <button
            className="gwmb-btn gwmb-btn-icon"
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            title="刷新"
            aria-label="刷新"
          >
            <RefreshIcon spinning={loading} />
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
        {tab === 'help' && local ? <HelpTab ping={ping} /> : null}
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
