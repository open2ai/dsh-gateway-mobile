#!/usr/bin/env node
/**
 * Open the local DSH Gateway admin console in the default browser.
 *
 * Default: http://127.0.0.1:3081/admin (falls back to /mobile/admin on an
 * older running gateway that does not have the short alias yet).
 * Override: DSH_GATEWAY_ADMIN_URL=http://127.0.0.1:3081/admin npm run admin
 */
import { spawn } from 'node:child_process'

const configured = process.env.DSH_GATEWAY_ADMIN_URL
const origin = process.env.DSH_GATEWAY_ORIGIN || 'http://127.0.0.1:3081'

async function resolveAdminUrl() {
  if (configured) return configured
  try {
    const response = await fetch(`${origin}/admin`, { redirect: 'manual', signal: AbortSignal.timeout(2500) })
    if (response.status === 302 || response.status === 200) return `${origin}/admin`
  } catch {
    // Gateway not running (or older build); fall through to the stable path.
  }
  return `${origin}/mobile/admin`
}

const url = await resolveAdminUrl()
const platform = process.platform

let command
let args
if (platform === 'win32') {
  command = 'cmd.exe'
  args = ['/c', 'start', '', url]
} else if (platform === 'darwin') {
  command = 'open'
  args = [url]
} else {
  command = 'xdg-open'
  args = [url]
}

const child = spawn(command, args, { detached: true, stdio: 'ignore' })
child.on('error', (error) => {
  console.error(`Could not open ${url}: ${error.message}`)
  process.exitCode = 1
})
child.unref()
console.log(`Opening ${url}`)
