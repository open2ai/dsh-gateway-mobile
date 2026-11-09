import { $, api, ApiError, applyI18n, connectionState, initTheme, onConnectionChange, t } from './common'

initTheme()
applyI18n()

interface StatusPayload {
  tunnel?: { connected?: boolean }
}

const status = $('#status')
const frame = $<HTMLIFrameElement>('#frame')
const loading = $('#loading')
const spinner = $('#shell-spinner')
const timeoutPanel = $('#shell-timeout')
const retryButton = $<HTMLButtonElement>('#shell-retry')

let loadTimer: ReturnType<typeof setTimeout> | undefined

function setStatus(text: string, ok: boolean): void {
  if (!status) return
  status.textContent = text
  status.classList.toggle('ok', ok)
  status.classList.toggle('bad', !ok)
}

function clearLoadTimer(): void {
  if (loadTimer !== undefined) {
    clearTimeout(loadTimer)
    loadTimer = undefined
  }
}

function hideLoading(): void {
  clearLoadTimer()
  if (loading) loading.hidden = true
}

/** After the iframe timeout, keep the overlay up but offer retry / diagnostics. */
function showTimeout(): void {
  if (!loading || loading.hidden) return
  if (spinner) spinner.hidden = true
  const label = loading.querySelector<HTMLElement>('[data-i18n="loading"]')
  if (label) label.hidden = true
  if (timeoutPanel) timeoutPanel.hidden = false
}

function restartLoad(): void {
  if (!frame) return
  clearLoadTimer()
  if (loading) loading.hidden = false
  if (spinner) spinner.hidden = false
  const label = loading?.querySelector<HTMLElement>('[data-i18n="loading"]')
  if (label) label.hidden = false
  if (timeoutPanel) timeoutPanel.hidden = true
  setStatus(t('loading'), false)
  frame.src = `/?_=${Date.now()}`
  loadTimer = setTimeout(showTimeout, 12_000)
}

frame?.addEventListener('load', hideLoading)
retryButton?.addEventListener('click', restartLoad)
loadTimer = setTimeout(showTimeout, 12_000)

async function check(): Promise<void> {
  try {
    const data = await api<StatusPayload>('/mobile/api/v1/status')
    const connected = Boolean(data.tunnel?.connected)
    setStatus(connected ? t('connected') : t('disconnected'), connected)
  } catch (error) {
    if (error instanceof ApiError && [2001, 3001, 2002, 2003].includes(error.code)) {
      location.replace('/mobile/pair?next=/mobile/shell')
      return
    }
    setStatus(connectionState() === 'offline' ? t('syncOffline') : t('disconnected'), false)
  }
}

onConnectionChange((state) => {
  if (state === 'offline') setStatus(t('syncOffline'), false)
})

void check()
setInterval(check, 15_000)
