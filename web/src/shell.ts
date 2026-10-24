import { $, api, ApiError, applyI18n, initTheme, t } from './common'

initTheme()
applyI18n()

interface StatusPayload {
  tunnel?: { connected?: boolean }
}

const status = $('#status')
const frame = $<HTMLIFrameElement>('#frame')
const loading = $('#loading')

function setStatus(text: string, ok: boolean): void {
  if (!status) return
  status.textContent = text
  status.classList.toggle('ok', ok)
  status.classList.toggle('bad', !ok)
}

function hideLoading(): void {
  if (loading) loading.hidden = true
}

frame?.addEventListener('load', hideLoading)
window.setTimeout(hideLoading, 12_000)

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
    setStatus(t('disconnected'), false)
  }
}

void check()
setInterval(check, 15_000)
