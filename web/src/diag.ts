import { $, api, ApiError, applyI18n, initTheme, setText, t } from './common'

initTheme()
applyI18n()

interface StatusPayload {
  tunnel?: {
    state?: string
    url?: string
  }
}

const logLines: string[] = []

function log(line: unknown): void {
  logLines.push(`${new Date().toLocaleTimeString()} ${String(line)}`)
  const node = $('#log')
  if (node) node.textContent = logLines.join('\n')
}

function setStatus(id: string, value: unknown, ok?: boolean): void {
  const node = $(`#${id}`)
  if (!node) return
  node.textContent = value === null || value === undefined || value === '' ? '-' : String(value)
  node.classList.remove('ok', 'bad')
  if (ok === true) node.classList.add('ok')
  else if (ok === false) node.classList.add('bad')
}

function set(id: string, value: unknown): void {
  setText(`#${id}`, value === null || value === undefined ? '' : String(value))
}

function tunnelLabel(state: string | undefined): { text: string; ok: boolean } {
  if (state === 'connected') return { text: t('connected'), ok: true }
  return { text: t('diagTunnelOff'), ok: false }
}

async function httpCheck(): Promise<void> {
  try {
    const health = await fetch('/health', { credentials: 'same-origin' })
    setStatus('health', String(health.status), health.ok)
  } catch (error) {
    setStatus('health', `${t('diagFail')}: ${error instanceof Error ? error.message : String(error)}`, false)
  }
  try {
    const data = await api<StatusPayload>('/mobile/api/v1/status')
    setStatus('status', t('diagOk'), true)
    const tunnel = tunnelLabel(data.tunnel?.state)
    setStatus('tunnel', tunnel.text, tunnel.ok)
    log(`status: tunnel=${data.tunnel?.state} url=${data.tunnel?.url || '-'}`)
  } catch (error) {
    const code = error instanceof ApiError ? error.code : ''
    setStatus('status', `${t('diagFail')}: ${code} ${error instanceof Error ? error.message : String(error)}`, false)
  }
}

function wsCheck(): Promise<void> {
  return new Promise<void>((resolve) => {
    const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/remote.mux`
    const started = performance.now()
    let opened = false
    let settled = false
    let ws: WebSocket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      try { ws?.close() } catch { /* ignore */ }
      resolve()
    }
    timer = setTimeout(() => {
      set('ws-error', t('diagWsTimeout'))
      log('ws: timeout')
      finish()
    }, 10_000)
    try {
      ws = new WebSocket(url)
    } catch (error) {
      set('ws-error', `${t('diagWsBlocked')}: ${error instanceof Error ? error.message : String(error)}`)
      finish()
      return
    }
    ws.addEventListener('open', () => {
      opened = true
      setStatus('ws-open', t('diagOk'), true)
      log('ws: open')
      try {
        ws?.send(JSON.stringify({ type: 'open', streamId: `diag-${Date.now()}`, endpoint: '$events', payload: { args: {} } }))
      } catch (error) {
        log(`ws send failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    ws.addEventListener('message', (event: MessageEvent<string>) => {
      try {
        const frame = JSON.parse(event.data) as { type?: string; value?: { type?: string } }
        if (frame.type === 'item' && frame.value?.type === 'ready') {
          setStatus('ws-ready', t('diagOk'), true)
          set('ws-time', `${Math.round(performance.now() - started)} ms`)
          log('ws: $events ready')
          finish()
        }
      } catch {
        // ignore non-JSON diagnostics frames
      }
    })
    ws.addEventListener('close', (event: CloseEvent) => {
      set('ws-close', `${event.code}${event.reason ? ` ${event.reason}` : ''}`)
      if (!settled) {
        if (!opened) set('ws-error', t('diagWsCloseFailed'))
        else if (!$('#ws-ready')?.textContent?.includes(t('diagOk'))) set('ws-error', t('diagWsNoReady'))
      }
      log(`ws: close ${event.code} ${event.reason}`)
      finish()
    })
    ws.addEventListener('error', () => {
      set('ws-error', t('diagWsErrorGeneric'))
      log('ws: error')
    })
  })
}

async function run(): Promise<void> {
  logLines.length = 0
  for (const id of ['health', 'status', 'tunnel', 'ws-open', 'ws-ready', 'ws-close', 'ws-time']) setStatus(id, '-')
  set('ws-error', '')
  set('url', location.host)
  setStatus('secure', window.isSecureContext ? t('diagYes') : t('diagNo'), window.isSecureContext)
  set('ua', navigator.userAgent)
  log(`probe ${location.href}`)
  await httpCheck()
  await wsCheck()
  log('done')
}

$('#run')?.addEventListener('click', () => void run())
void run()
