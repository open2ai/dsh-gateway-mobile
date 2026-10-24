import { $, api, ApiError, applyI18n, el, formatTime, initTheme, openDialog, t, toast } from './common'

initTheme()
applyI18n()

interface OAuthBinding {
  provider: string
  username: string
}

interface Device {
  deviceId: string
  deviceName?: string
  displayName?: string
  userAgent?: string
  isOnline?: boolean
  isCurrent?: boolean
  lastIp?: string
  lastActiveAt?: string
  oauthBindings?: OAuthBinding[]
}

const list = $('#device-list')
const empty = $('#empty')

function renderSkeleton(): void {
  if (!list) return
  list.replaceChildren()
  for (let index = 0; index < 3; index += 1) {
    list.append(el('div', { class: 'skeleton-card' }, [
      el('div', { class: 'skeleton' }),
      el('div', { class: 'skeleton' }),
      el('div', { class: 'skeleton' }),
    ]))
  }
}

function renderError(message: string): void {
  if (!list) return
  list.replaceChildren()
  list.append(el('div', { class: 'card' }, [
    el('p', { class: 'muted', text: message }),
    el('div', { class: 'actions' }, [
      el('button', { class: 'btn secondary', text: t('retry'), onclick: () => void load() }),
    ]),
  ]))
}

function render(devices: Device[]): void {
  if (!list || !empty) return
  list.replaceChildren()
  empty.hidden = devices.length > 0
  for (const device of devices) {
    const activeTime = device.lastActiveAt ? new Date(device.lastActiveAt) : null
    const oauth = (device.oauthBindings ?? [])
      .map((binding) => `${binding.provider}: @${binding.username}`)
      .join(' · ')
    const meta = el('div', { class: 'meta' }, [
      el('div', { text: `${t('id')}: ${device.deviceId}` }),
      el('div', { text: `${t('ip')}: ${device.lastIp || '-'}` }),
      el('div', {
        text: `${t('lastActive')}: ${formatTime(device.lastActiveAt)}`,
        title: activeTime && !Number.isNaN(activeTime.getTime()) ? activeTime.toLocaleString() : '',
      }),
      oauth ? el('div', { text: oauth }) : null,
    ])
    const title = el('div', { class: 'title' }, [
      el('span', { class: `dot ${device.isOnline ? 'ok' : ''}`.trim() }),
      el('span', { text: device.displayName || device.deviceName || device.deviceId }),
      device.isCurrent ? el('span', { class: 'badge current', text: t('current') }) : null,
    ])
    const ops = el('div', { class: 'ops' }, [
      el('button', { class: 'btn small secondary', text: t('rename'), onclick: () => void rename(device) }),
      el('button', { class: 'btn small danger', text: t('revoke'), onclick: () => void revoke(device) }),
    ])
    list.append(el('div', { class: 'item' }, [title, meta, ops]))
  }
}

async function load(): Promise<void> {
  renderSkeleton()
  try {
    const data = await api<{ devices?: Device[] }>('/mobile/api/v1/devices')
    render(data.devices ?? [])
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === 3004) {
        location.replace('/mobile/oauth')
        return
      }
      if ([2001, 2002, 2003, 3001].includes(error.code)) {
        location.replace('/mobile/pair')
        return
      }
    }
    renderError(error instanceof Error ? error.message : t('networkError'))
  }
}

async function rename(device: Device): Promise<void> {
  const input = el('input', {
    type: 'text',
    value: device.deviceName || '',
    maxlength: '48',
    placeholder: t('deviceNameLabel'),
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement
  const field = el('label', { class: 'field' }, [el('span', { text: t('deviceNameLabel') }), input])
  await openDialog({
    title: t('rename'),
    body: field,
    confirmText: t('save'),
    onConfirm: async () => {
      const name = input.value.trim()
      if (!name) {
        toast(t('deviceNameRequired'))
        return false
      }
      await api(`/mobile/api/v1/devices/${encodeURIComponent(device.deviceId)}`, {
        method: 'PATCH',
        body: { deviceName: name },
      })
      toast(`${t('rename')} ✓`, 'ok')
      await load()
      return true
    },
  })
}

async function revoke(device: Device): Promise<void> {
  const body = el('div', {}, [
    el('p', { text: t('revokeConfirm') }),
    device.isCurrent ? el('p', { text: t('revokeSelf') }) : null,
  ])
  await openDialog({
    title: t('revoke'),
    body,
    confirmText: t('revoke'),
    danger: true,
    onConfirm: async () => {
      await api(`/mobile/api/v1/devices/${encodeURIComponent(device.deviceId)}/revoke`, { method: 'POST' })
      toast(`${t('revoke')} ✓`, 'ok')
      if (device.isCurrent) location.replace('/mobile/pair')
      else await load()
      return true
    },
  })
}

$('#refresh')?.addEventListener('click', () => void load())

$('#revoke-all')?.addEventListener('click', async () => {
  await openDialog({
    title: t('revokeAll'),
    body: el('p', { text: t('revokeAllConfirm') }),
    confirmText: t('revokeAll'),
    danger: true,
    onConfirm: async () => {
      await api('/mobile/api/v1/devices/revoke-all', { method: 'POST', body: { confirmText: 'REVOKE ALL' } })
      location.replace('/mobile/pair')
      return true
    },
  })
})

void load()
