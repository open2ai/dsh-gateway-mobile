import { $, api, ApiError, applyI18n, initTheme, safeNext, t } from './common'

initTheme()
applyI18n()

const input = $<HTMLInputElement>('#pairing-code')!
const nameInput = $<HTMLInputElement>('#device-name')
const expiry = $<HTMLElement>('#expiry')!
const error = $<HTMLElement>('#error')!
const confirm = $<HTMLButtonElement>('#confirm')!
const success = $('#pair-success')

interface PairingStatus {
  valid?: boolean
  expiresIn?: number
}

interface PairingResult {
  requireOAuth?: boolean
}

interface PairingErrorData {
  retryAfter?: number
  remainingAttempts?: number
}

function showSuccess(): void {
  if (success) success.hidden = false
  confirm.disabled = true
}

function normalize(value: unknown): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
}

function format(value: unknown): string {
  const clean = normalize(value)
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean
}

function showError(message: string): void {
  error.textContent = message
}

function setExpiry(text: string): void {
  expiry.textContent = text
  expiry.closest('.pair-expiry')?.classList.toggle('empty', !text)
}

function readFragmentCode(): string {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : ''
  const params = new URLSearchParams(hash)
  return normalize(params.get('pairing') ?? '')
}

let expiresAt = 0

async function refreshStatus(): Promise<void> {
  try {
    const data = await api<PairingStatus>('/mobile/api/v1/pairing/status', { redirectOnAuth: false })
    expiresAt = (data.expiresIn ?? 0) > 0 ? Date.now() + (data.expiresIn ?? 0) * 1000 : 0
    if (!data.valid) {
      setExpiry(t('pairExpired'))
      confirm.disabled = true
    } else {
      confirm.disabled = false
    }
  } catch (errorObject) {
    setExpiry(errorObject instanceof Error ? errorObject.message : t('networkError'))
  }
}

function tick(): void {
  if (!expiresAt) return
  const left = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  const minutes = String(Math.floor(left / 60)).padStart(2, '0')
  const seconds = String(left % 60).padStart(2, '0')
  setExpiry(`${t('pairExpires')} ${minutes}:${seconds}`)
  if (left === 0) {
    setExpiry(t('pairExpired'))
    confirm.disabled = true
  }
}

input.addEventListener('input', () => {
  const formatted = format(input.value)
  if (input.value !== formatted) input.value = formatted
  showError('')
})

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void submit()
})

confirm.addEventListener('click', () => void submit())

async function submit(): Promise<void> {
  const code = normalize(input.value)
  if (code.length !== 8) {
    showError(t('pairInvalid'))
    return
  }
  confirm.disabled = true
  showError('')
  try {
    const data = await api<PairingResult>('/mobile/api/v1/pairing/verify', {
      method: 'POST',
      body: {
        pairingToken: code,
        deviceName: nameInput?.value.trim() || '',
      },
    })
    showSuccess()
    const next = safeNext()
    const target = data.requireOAuth ? `/mobile/oauth?next=${encodeURIComponent(next)}` : next
    window.setTimeout(() => location.replace(target), 950)
  } catch (errorObject) {
    let message = errorObject instanceof Error ? errorObject.message : t('pairFailed')
    const detail = errorObject instanceof ApiError && errorObject.data && typeof errorObject.data === 'object'
      ? errorObject.data as PairingErrorData
      : null
    if (detail?.retryAfter) message += ` (${detail.retryAfter}s)`
    else if (typeof detail?.remainingAttempts === 'number') message += ` (${detail.remainingAttempts})`
    showError(message)
    confirm.disabled = false
    await refreshStatus()
  }
}

const fragmentCode = readFragmentCode()
if (fragmentCode) {
  input.value = format(fragmentCode)
  input.dispatchEvent(new Event('input'))
}

void refreshStatus()
setInterval(tick, 1000)
setInterval(refreshStatus, 30_000)
tick()
