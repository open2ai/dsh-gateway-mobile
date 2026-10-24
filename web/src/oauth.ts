import { $, api, ApiError, applyI18n, el, initTheme, safeNext, t, toast } from './common'

initTheme()
applyI18n()

interface OAuthBinding {
  provider: string
  username: string
}

interface MePayload {
  requireOAuth?: boolean
  device?: {
    deviceId?: string
    oauthBindings?: OAuthBinding[]
  }
}

interface ProvidersPayload {
  providers?: string[]
}

interface AuthorizePayload {
  authorizeUrl: string
}

let me: MePayload | null = null
let providers: string[] = []
let popup: Window | null = null

function render(): void {
  const container = $('#providers')
  if (container) {
    container.replaceChildren()
    const bindings = me?.device?.oauthBindings ?? []
    for (const provider of providers) {
      const bound = bindings.find((binding) => binding.provider === provider)
      const title = el('div', { class: 'title' }, [
        el('span', { text: provider === 'github' ? 'GitHub' : 'Gitee' }),
        bound ? el('span', { class: 'badge ok', text: `@${bound.username}` }) : null,
      ])
      const ops = el('div', { class: 'ops' }, [
        bound
          ? el('button', {
              class: 'btn small danger',
              text: t('unbind'),
              onclick: async () => {
                try {
                  await api('/mobile/api/v1/oauth/unbind', { method: 'POST', body: { provider } })
                  await load()
                } catch (error) {
                  toast(error instanceof Error ? error.message : t('networkError'))
                }
              },
            })
          : el('button', { class: 'btn small', text: t('bind'), onclick: () => void bind(provider) }),
      ])
      container.append(el('div', { class: 'item' }, [title, ops]))
    }
  }
  const empty = $('#empty')
  if (empty) {
    empty.hidden = providers.length > 0
    empty.textContent = providers.length === 0 ? t('noProviders') : ''
  }
  const skip = $('#skip')
  if (skip) skip.hidden = Boolean(me?.requireOAuth)
  const error = $('#error')
  if (error) error.textContent = me?.requireOAuth && (me.device?.oauthBindings?.length ?? 0) === 0 ? t('bindRequired') : ''
}

async function load(): Promise<void> {
  try {
    me = await api<MePayload>('/mobile/api/v1/me', { redirectOnAuth: false })
    const data = await api<ProvidersPayload>('/mobile/api/v1/oauth/providers')
    providers = data.providers ?? []
    render()
  } catch (error) {
    if (error instanceof ApiError && (error.code === 2001 || error.code === 3001)) location.replace('/mobile/pair')
    else toast(error instanceof Error ? error.message : t('networkError'))
  }
}

async function bind(provider: string): Promise<void> {
  try {
    const deviceId = me?.device?.deviceId
    if (!deviceId) return
    const data = await api<AuthorizePayload>(`/mobile/api/v1/oauth/authorize?provider=${encodeURIComponent(provider)}&deviceId=${encodeURIComponent(deviceId)}`)
    popup = window.open(data.authorizeUrl, 'dsh-oauth', 'width=520,height=680')
    if (!popup) {
      location.href = data.authorizeUrl
      return
    }
    const started = Date.now()
    const poll = setInterval(async () => {
      if (Date.now() - started > 120_000) {
        clearInterval(poll)
        popup?.close()
        return
      }
      try {
        const latest = await api<MePayload>('/mobile/api/v1/me', { redirectOnAuth: false })
        if ((latest.device?.oauthBindings?.length ?? 0) > (me?.device?.oauthBindings?.length ?? 0)) {
          clearInterval(poll)
          popup?.close()
          me = latest
          render()
          toast(t('bound'), 'ok')
        }
      } catch {
        // keep polling
      }
    }, 2000)
  } catch (error) {
    toast(error instanceof Error ? error.message : t('networkError'))
  }
}

window.addEventListener('message', (event: MessageEvent<{ type?: string; ok?: boolean }>) => {
  if (event.data?.type !== 'dsh-oauth') return
  if (event.data.ok) {
    toast(t('bound'), 'ok')
    void load()
  } else {
    toast(t('pairFailed'))
  }
})

$('#skip')?.addEventListener('click', () => {
  location.replace(safeNext())
})

void load()
