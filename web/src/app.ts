import { $, api, ApiError, applyI18n, initTheme, onConnectionChange, setText, t, toast } from './common'
import type { ConnectionState } from './common'

initTheme()
applyI18n()

interface MePayload {
  device?: {
    deviceName?: string
    oauthBindings?: unknown[]
  }
  requireOAuth?: boolean
}

interface StatusPayload {
  gateway?: {
    version?: string
    publicBase?: string
  }
  tunnel?: {
    connected?: boolean
  }
}

let lastSyncAt = 0
let failures = 0
let loading = false
let lastConnectionState: ConnectionState = 'online'

function syncTimeLabel(): string {
  return lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString() : t('syncNever')
}

/** Update the phone status card with connection quality and last successful sync. */
function renderSyncState(state: ConnectionState): void {
  const node = $('#sync-state')
  if (!node) return
  const label = state === 'offline' ? t('syncOffline') : state === 'degraded' ? t('syncDegraded') : t('syncOnline')
  const last = lastSyncAt ? `${t('lastSync')} ${syncTimeLabel()}` : ''
  node.textContent = state === 'online' ? (last || label) : last ? `${label} · ${last}` : label
  node.classList.toggle('ok', state === 'online')
  node.classList.toggle('bad', state !== 'online')
}

async function load(): Promise<void> {
  if (loading) return
  loading = true
  try {
    const [me, status] = await Promise.all([api<MePayload>('/mobile/api/v1/me'), api<StatusPayload>('/mobile/api/v1/status')])
    setText('#device-name', me.device?.deviceName || '-')
    const connected = Boolean(status.tunnel?.connected)
    setText('#tunnel-state', connected ? t('connected') : t('disconnected'))
    const tunnelNode = $('#tunnel-state')
    tunnelNode?.classList.toggle('ok', connected)
    tunnelNode?.classList.toggle('bad', !connected)
    const dot = $('#tunnel-dot')
    dot?.classList.toggle('ok', connected)
    dot?.classList.toggle('bad', !connected)
    setText('#gateway-state', t('connected'))
    const publicUrl = status.gateway?.publicBase || ''
    const external = connected && /^https:\/\//i.test(publicUrl)
    const urlNode = $('#public-url')
    if (urlNode) urlNode.textContent = external ? `${t('tunnelAccess')} · ${publicUrl}` : t('urlLocalOnly')
    const version = status.gateway?.version
    setText('#version-foot', version ? `${t('footer')} · v${version}` : t('footer'))
    if (me.requireOAuth && (me.device?.oauthBindings?.length ?? 0) === 0) {
      location.replace('/mobile/oauth')
      return
    }
    lastSyncAt = Date.now()
    failures = 0
    renderSyncState('online')
  } catch (error) {
    if (error instanceof ApiError && error.code === 3004) {
      location.replace('/mobile/oauth')
      return
    }
    failures += 1
    const message = error instanceof Error ? error.message : t('networkError')
    setText('#tunnel-state', '-')
    setText('#gateway-state', '-')
    const urlNode = $('#public-url')
    // A single inline message replaces repeated toasts while the network is unstable.
    if (urlNode) urlNode.textContent = failures === 1 ? message : ''
    renderSyncState(navigator.onLine === false ? 'offline' : 'degraded')
    if (failures === 1) toast(message)
  } finally {
    loading = false
  }
}

onConnectionChange((state) => {
  const previous = lastConnectionState
  lastConnectionState = state
  renderSyncState(state)
  if (state === 'online' && previous !== 'online') void load()
})

$('#open-dsh')?.addEventListener('click', () => {
  location.href = '/mobile/shell'
})

$('#logout')?.addEventListener('click', async () => {
  try {
    await api('/mobile/api/v1/logout', { method: 'POST' })
  } catch {
    // ignore: the cookie is cleared server-side on success only
  }
  location.replace('/mobile/pair')
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void load()
})

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/mobile/sw.js').catch(() => {})
}

void load()
setInterval(load, 15_000)
