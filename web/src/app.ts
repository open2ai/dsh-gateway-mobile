import { $, api, ApiError, applyI18n, initTheme, setText, t, toast } from './common'

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

async function load(): Promise<void> {
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
    }
  } catch (error) {
    if (error instanceof ApiError && error.code === 3004) {
      location.replace('/mobile/oauth')
      return
    }
    const message = error instanceof Error ? error.message : t('networkError')
    setText('#tunnel-state', '-')
    setText('#gateway-state', '-')
    const urlNode = $('#public-url')
    if (urlNode) urlNode.textContent = message
    toast(message)
  }
}

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

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/mobile/sw.js').catch(() => {})
}

void load()
setInterval(load, 15_000)
