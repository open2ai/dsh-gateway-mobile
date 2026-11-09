import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// Static checks for the admin console information architecture. The page itself
// is plain DOM fed by web/src/admin.ts, so these assertions guard the markup and
// styles that the TypeScript relies on (ids are the contract between the two).

const html = readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8')
const css = readFileSync(new URL('../web/assets/admin.css', import.meta.url), 'utf8')
const ts = readFileSync(new URL('../web/src/admin.ts', import.meta.url), 'utf8')

function has(selector) {
  return new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(html)
}

test('admin tabs include the phase-2 help tab in both navigations', () => {
  assert.ok(has('data-tab="help"'), 'help tab is missing')
  const sidebar = html.match(/<nav class="app-nav"[\s\S]*?<\/nav>/)?.[0] ?? ''
  const bottom = html.match(/<nav class="app-bottom-nav"[\s\S]*?<\/nav>/)?.[0] ?? ''
  assert.match(sidebar, /data-tab="help"/)
  assert.match(bottom, /data-tab="help"/)
  for (const tab of ['overview', 'pair', 'weixin', 'devices', 'logs', 'settings']) {
    assert.ok(sidebar.includes(`data-tab="${tab}"`), `sidebar tab ${tab} missing`)
    assert.ok(bottom.includes(`data-tab="${tab}"`), `bottom tab ${tab} missing`)
  }
})

test('overview shows status chips, hints, KPI cards, quick actions and the chart', () => {
  for (const id of ['overview-status-chips', 'chip-gateway', 'chip-tunnel', 'chip-dsh', 'chip-weixin', 'overview-alert', 'overview-alert-text', 'overview-alert-diagnostics', 'capability-warning', 'capability-warning-text']) {
    assert.ok(has(`id="${id}"`), `overview element ${id} missing`)
  }
  // Activity content is restored directly on the overview (no details/collapse).
  for (const id of ['metric-active', 'metric-active-foot', 'metric-online', 'metric-today', 'go-pair', 'chart-total', 'chart-summary', 'chart-y', 'spark', 'chart-tip', 'spark-labels']) {
    assert.ok(has(`id="${id}"`), `overview activity element ${id} missing`)
  }
  // The gateway version KPI was removed; the overview keeps three KPI cards.
  assert.ok(!has('id="metric-version"'), 'gateway version KPI should be removed')
  // No "活动与统计 / ACTIVITY" section header and no <details> wrapper.
  const overviewStart = html.indexOf('data-panel="overview"')
  const pairStart = html.indexOf('data-panel="pair"')
  const overview = html.slice(overviewStart, pairStart)
  assert.ok(!/网关版本/.test(overview), 'overview should not show a gateway version label')
  assert.ok(!/活动与统计/.test(overview), 'activity section title must be removed')
  assert.ok(!/>ACTIVITY</.test(overview), 'ACTIVITY header must be removed from the overview')
  assert.ok(!/overview-activity-details/.test(overview), 'overview activity must not be collapsible')
  assert.ok(!/<details/.test(overview.split('<div class="kpi-grid">')[0]), 'no details before the KPI grid')
  // The chart keeps its own panel title.
  assert.match(overview, /请求趋势/)
  // Logs and the old four status cards stay gone; capability/deep health live in Help.
  for (const gone of ['log-preview', 'go-logs', 'activity-updated', 'runtime-grid', 'runtime-version']) {
    assert.ok(!has(`id="${gone}"`), `overview should not contain ${gone}`)
  }
  assert.ok(html.indexOf('id="capability-matrix"') > html.indexOf('data-panel="help"'))
  assert.ok(html.indexOf('id="deep-health-list"') > html.indexOf('data-panel="help"'))
})

test('overview loads health and activity together (no click required)', () => {
  const start = ts.indexOf('async function loadOverview')
  assert.ok(start > 0, 'loadOverview not found')
  const loader = ts.slice(start, start + 500)
  assert.match(loader, /loadDeepHealth/)
  assert.match(loader, /loadActivityData/)
  assert.match(ts, /async function loadActivityData\(\)/)
  assert.match(ts, /\/mobile\/api\/v1\/status/)
  assert.match(ts, /function renderSpark/)
  assert.ok(!/overview-activity-details/.test(ts), 'overview activity must not be toggle-driven')
})

test('logs tab keeps the log list, filters and refresh controls', () => {
  const logsStart = html.indexOf('data-panel="logs"')
  const settingsStart = html.indexOf('data-panel="settings"')
  assert.ok(logsStart > 0 && settingsStart > logsStart)
  const logsMarkup = html.slice(logsStart, settingsStart)
  for (const id of ['log-list', 'log-meta', 'log-filters', 'log-search', 'log-auto', 'refresh-logs', 'audit-action', 'audit-since', 'export-audit']) {
    assert.ok(logsMarkup.includes(`id="${id}"`), `logs tab element ${id} missing`)
  }
})

test('activity content is displayed directly without a collapsible header', () => {
  for (const id of ['metric-active', 'metric-online', 'metric-today', 'chart-total', 'spark', 'go-pair']) {
    assert.ok(has(`id="${id}"`), `${id} should be on the overview`)
  }
  assert.ok(!has('id="metric-version"'), 'gateway version KPI should be removed')
  assert.ok(!/活动与统计/.test(html), 'activity section title should be removed')
  assert.ok(!has('id="overview-activity-details"'), 'no activity details element')
})

test('tunnel and quick actions share a two-column row below KPI, above the chart', () => {
  const kpiStart = html.indexOf('class="kpi-grid"')
  const duoStart = html.indexOf('class="overview-duo"')
  const chartStart = html.indexOf('class="panel-head chart-head"')
  assert.ok(kpiStart > 0, 'KPI grid missing')
  assert.ok(duoStart > 0, 'overview-duo container missing')
  assert.ok(chartStart > 0, 'chart panel missing')
  assert.ok(kpiStart < duoStart, 'overview-duo should come after the KPI grid')
  assert.ok(duoStart < chartStart, 'overview-duo should come before the traffic chart')
  const duo = html.slice(duoStart, chartStart)
  assert.ok(duo.includes('id="tunnel-chip"'), 'tunnel panel should be inside overview-duo')
  assert.ok(duo.includes('class="panel quick-panel overview-quick"'), 'quick actions panel should be inside overview-duo')
  assert.ok(duo.includes('id="go-pair"'), 'quick action buttons should be inside overview-duo')
  // Tunnel comes before quick actions inside the duo row (left/right columns).
  assert.ok(duo.indexOf('TUNNEL') < duo.indexOf('QUICK ACTIONS'), 'tunnel panel should be the left column')
  // KPI stays above; the traffic chart stays below.
  assert.ok(html.indexOf('id="metric-active"') > kpiStart && html.indexOf('id="metric-active"') < duoStart)
  assert.ok(html.indexOf('id="spark"') > duoStart)
  // Responsive: two columns by default (tunnel column wider so the URL fits), single at <=860px.
  assert.match(css, /\.overview-duo\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1\.28fr\)\s*minmax\(0,\s*\.9fr\)/)
  assert.match(css, /@media \(max-width: 860px\)\s*\{[^}]*\.overview-duo\s*\{[^}]*grid-template-columns:\s*1fr/)
  assert.match(css, /\.overview-duo\s*\{[^}]*align-items:\s*stretch/)
  // The tunnel URL stays on one line on desktop.
  assert.match(css, /@media \(min-width: 861px\)\s*\{[^}]*\.overview-duo \.url-line \.mono\s*\{[^}]*white-space:\s*nowrap/)
})

test('overview KPI grid has exactly three cards and a three-column layout', () => {
  const overviewStart = html.indexOf('data-panel="overview"')
  const pairStart = html.indexOf('data-panel="pair"')
  const overview = html.slice(overviewStart, pairStart)
  const kpiCards = overview.match(/class="kpi"/g) ?? []
  assert.equal(kpiCards.length, 3, 'overview should render three KPI cards')
  assert.match(css, /\.kpi-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/)
  // Narrow screens fall back to two columns.
  assert.match(css, /@media \(max-width: 1080px\)\s*\{[^}]*\.kpi-grid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
})

test('7-day chart dots are HTML overlays so they stay circular', () => {
  // Dedicated absolutely-positioned layer inside the chart wrapper.
  assert.ok(has('class="chart-points"'))
  assert.ok(has('id="chart-points"'))
  const wrap = html.match(/<div class="chart-wrap">[\s\S]*?<\/div>\s*<\/div>/) ?? []
  assert.ok(wrap[0]?.includes('id="chart-points"'), 'chart-points layer must live inside chart-wrap')
  // CSS: fixed 6px round dots with a larger active state.
  assert.match(css, /\.chart-points\s*\{[^}]*position:\s*absolute/)
  assert.match(css, /\.chart-dot\s*\{[^}]*width:\s*6px;[^}]*height:\s*6px;[^}]*border-radius:\s*50%/)
  assert.match(css, /\.chart-dot\.active\s*\{[^}]*width:\s*8px;[^}]*height:\s*8px/)
  // SVG keeps the line/area but no longer draws the data circles.
  assert.ok(!/circle class="chart-point"/.test(ts), 'SVG circles should be removed')
  assert.match(ts, /chart-dot/)
  assert.match(ts, /pointsLayer/)
  assert.match(ts, /\.style\.left/)
})

test('chart supports 7/14/30-day range switching', () => {
  const select = html.match(/<select[^>]*id="chart-range"[^>]*>[\s\S]*?<\/select>/)?.[0] ?? ''
  assert.ok(select.length > 0, 'chart-range select missing')
  assert.match(select, /aria-label="图表统计范围"/)
  for (const days of ['7', '14', '30']) {
    assert.match(select, new RegExp(`value="${days}"`), `chart range option ${days} missing`)
  }
  assert.match(select, /value="7" selected/, 'chart defaults to 7 days')
  assert.ok(has('id="chart-sub"'), 'range-aware chart subtitle missing')
  // JS: persisted range, /admin/stats request for longer ranges, change wiring.
  assert.match(ts, /dsh-admin-chart-days/)
  assert.match(ts, /admin\/stats\?days=\$\{chartDays\}/)
  assert.match(ts, /#chart-range/)
  assert.match(ts, /setChartDays/)
  assert.match(ts, /localStorage\.setItem\(CHART_DAYS_KEY/)
  // Labels are thinned for 14/30 points and the hover tip includes the date.
  assert.match(ts, /labelEvery/)
  assert.match(ts, /point\.day\.date\?\.slice\(5\)/)
  assert.match(css, /\.chart-range\s*\{/)
  assert.match(css, /\.chart-range-label/)
})

test('help tab hosts a collapsed diagnostics area with unique ids', () => {
  assert.ok(has('id="help-diagnostics-details"'))
  const tag = html.match(/<details[^>]*id="help-diagnostics-details"[^>]*>/)?.[0] ?? ''
  assert.ok(tag.length > 0)
  assert.ok(!/\bopen\b/.test(tag), 'diagnostics details must start collapsed')
  assert.match(html, /诊断/)
  const helpIndex = html.indexOf('data-panel="help"')
  for (const id of ['deep-health-list', 'deep-health-meta', 'deep-health-chip', 'deep-health-refresh', 'capability-matrix', 'capability-refresh']) {
    assert.ok(has(`id="${id}"`), `diagnostics element ${id} missing`)
    assert.ok(html.indexOf(`id="${id}"`) > helpIndex, `${id} should live in the help tab`)
  }
})

test('tunnel controls live on the overview, not in settings or help', () => {
  const overviewStart = html.indexOf('data-panel="overview"')
  const pairStart = html.indexOf('data-panel="pair"')
  const settingsStart = html.indexOf('data-panel="settings"')
  const weixinStart = html.indexOf('data-panel="weixin"')
  assert.ok(overviewStart > 0 && pairStart > overviewStart)
  const overview = html.slice(overviewStart, pairStart)
  const settings = html.slice(settingsStart, weixinStart)
  for (const id of ['tunnel-chip', 'tunnel-url', 'copy-url', 'tunnel-meta', 'tunnel-health', 'tunnel-uptime', 'tunnel-start', 'tunnel-stop', 'tunnel-restart', 'tunnel-hint']) {
    assert.ok(overview.includes(`id="${id}"`), `tunnel control ${id} should be on the overview`)
    assert.ok(!settings.includes(`id="${id}"`), `tunnel control ${id} should not be in settings`)
  }
  // Settings still owns the enable/disable runtime switch.
  assert.ok(settings.includes('id="runtime-tunnel-enabled"'), 'runtime tunnel switch should stay in settings')
  // Help diagnostics keeps only deep health + capability matrix.
  const helpStart = html.indexOf('data-panel="help"')
  const help = html.slice(helpStart, html.indexOf('</main>'))
  for (const id of ['tunnel-chip', 'tunnel-url', 'tunnel-start', 'tunnel-stop', 'tunnel-restart', 'copy-url']) {
    assert.ok(!help.includes(`id="${id}"`), `tunnel control ${id} should not be in help diagnostics`)
  }
  assert.ok(help.includes('id="deep-health-list"'))
  assert.ok(help.includes('id="capability-matrix"'))
})

test('weixin tab has connection, push and approval sections with runtime fields', () => {
  for (const section of ['connect', 'push', 'approve']) {
    assert.ok(has(`data-wx-section="${section}"`), `weixin sub-tab ${section} missing`)
    assert.ok(has(`data-wx-panel="${section}"`), `weixin section ${section} missing`)
  }
  for (const id of ['weixin-state-label', 'weixin-last-poll', 'weixin-last-ok', 'weixin-failures', 'weixin-context-age', 'weixin-owner', 'weixin-allow-others', 'weixin-owner-alert', 'weixin-notify-enabled', 'weixin-approval-history']) {
    assert.ok(has(`id="${id}"`), `weixin field ${id} missing`)
  }
  // The push policy now lives in the WeChat tab, not the settings tab.
  const settingsStart = html.indexOf('data-panel="settings"')
  const weixinStart = html.indexOf('data-panel="weixin"')
  const helpStart = html.indexOf('data-panel="help"')
  const notifyIndex = html.indexOf('weixin-notify-enabled')
  assert.ok(notifyIndex > weixinStart && notifyIndex < helpStart, 'push policy moved out of the WeChat tab')
  assert.ok(!html.slice(settingsStart, weixinStart).includes('weixin-notify-enabled'), 'push policy must not stay in settings')
})

test('logs tab exposes a compact audit export toolbar', () => {
  for (const id of ['audit-action', 'audit-since', 'export-audit', 'audit-export-status']) {
    assert.ok(has(`id="${id}"`), `audit control ${id} missing`)
  }
  assert.match(html, /导出审计 JSON/)
  // Single-line text input, not a textarea or the log search box (whose flex
  // sizing caused the 220px-tall input bug inside the column flex field).
  const inputTag = html.match(/<input[^>]*id="audit-action"[^>]*>/)?.[0] ?? ''
  assert.ok(inputTag.length > 0, 'audit-action input missing')
  assert.match(inputTag, /type="text"/)
  assert.ok(!/textarea/i.test(inputTag))
  assert.ok(!inputTag.includes('log-search'))
  // The toolbar lives in the log panel body and the three controls share it.
  const toolbarIndex = html.indexOf('class="audit-toolbar"')
  const logsIndex = html.indexOf('data-panel="logs"')
  assert.ok(toolbarIndex > logsIndex)
  assert.ok(html.indexOf('id="audit-since"') > toolbarIndex)
  assert.ok(html.indexOf('id="export-audit"') > toolbarIndex)
  // Compact one-row layout in CSS: controls keep their own height and the
  // field owns the width instead of giving the input a vertical flex-basis.
  const auditCss = css.slice(css.indexOf('/* Audit export toolbar'), css.indexOf('/* WeChat sub-sections'))
  assert.match(auditCss, /\.audit-toolbar\s*\{[^}]*display:\s*flex/)
  assert.match(auditCss, /\.audit-field\s*\{[^}]*flex:\s*0 1 240px/)
  assert.match(auditCss, /\.audit-input\s*\{[^}]*flex:\s*none;[^}]*width:\s*100%;[^}]*height:\s*34px/)
  assert.match(auditCss, /\.audit-select\s*\{[^}]*height:\s*34px/)
  assert.match(auditCss, /\.audit-toolbar \.button\s*\{[^}]*height:\s*34px/)
  assert.match(auditCss, /@media \(max-width: 720px\)/)
})

test('settings tab exposes key rotation with a second confirmation', () => {
  assert.ok(has('id="rotate-key"'))
  assert.ok(has('id="key-active-kid"'))
  assert.ok(has('id="key-id-list"'))
  assert.ok(has('id="key-rotate-notice"'))
  assert.match(html, /轮换密钥/)
  assert.match(html, /重新配对/)
})

test('settings tab exposes the runtime switches panel', () => {
  for (const id of ['runtime-tunnel-enabled', 'runtime-weixin-enabled', 'runtime-log-level', 'runtime-proxy-timeout', 'save-runtime-settings', 'runtime-settings-notice', 'runtime-settings-status', 'runtime-restart-hint']) {
    assert.ok(has(`id="${id}"`), `runtime control ${id} missing`)
  }
  const settingsStart = html.indexOf('data-panel="settings"')
  const runtimeIndex = html.indexOf('id="runtime-tunnel-enabled"')
  assert.ok(runtimeIndex > settingsStart, 'runtime switches must live in the settings tab')
  assert.match(html, /立即生效/)
  assert.match(html, /下次启动仍生效/)
  for (const level of ['debug', 'info', 'warn', 'error']) {
    assert.ok(html.includes(`value="${level}"`), `log level option ${level} missing`)
  }
})

test('help tab lists common failures and version info without documentation links', () => {
  assert.ok(has('data-panel="help"'))
  const help = html.slice(html.indexOf('data-panel="help"'))
  assert.match(help, /常见故障/)
  assert.match(help, /配对码过期/)
  assert.match(help, /微信无 context/)
  assert.match(help, /轮换密钥/)
  assert.ok(has('id="help-version"'))
  assert.ok(has('id="help-capabilities"'))
  assert.ok(!/文档入口/.test(help), 'documentation entry panel must be removed')
  assert.ok(!/docs\/DETAIL\.zh\.md/.test(help), 'repository doc links must not be rendered')
})

test('tunnel URL change banner exists and starts hidden', () => {
  assert.match(html, /id="tunnel-change-banner"[^>]*hidden/)
  assert.match(html, /公网地址已变化/)
  assert.ok(has('id="tunnel-change-dismiss"'))
})

test('weak-network connection banner exists and starts hidden', () => {
  assert.match(html, /id="connection-banner"[^>]*hidden/)
  assert.ok(has('id="connection-title"'))
  assert.ok(has('id="connection-text"'))
  assert.ok(has('id="connection-retry"'))
  assert.match(html, /网络连接中断/)
})

test('element ids stay unique', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
  const seen = new Set()
  for (const id of ids) {
    assert.ok(!seen.has(id), `duplicate id: ${id}`)
    seen.add(id)
  }
})

test('stylesheet defines the overview and phase-2 building blocks', () => {
  for (const selector of ['.kpi-grid', '.kpi-value', '.quick-action', '.overview-quick', '.callout', '.spark', '.chart-body', '.chart-points', '.chart-dot', '.chart-tip', '.status-chip', '.overview-status', '.overview-alert', '.overview-capability-warning', '.diagnostics-details', '.diagnostics-title', '.diagnostics-hint', '.cap-row', '.health-check', '.audit-toolbar', '.weixin-subnav', '.wx-section', '.weixin-owner-alert', '.banner', '.faq', '.key-chip', '.runtime-settings-grid', '.runtime-setting', '.runtime-select', '.conn-banner']) {
    assert.ok(css.includes(selector), `${selector} missing from admin.css`)
  }
})
