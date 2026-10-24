#!/usr/bin/env node
/**
 * Real-DSH integration check.
 *
 * Creates an isolated DSH_HOME, initializes a `gwtest` profile from the shipped
 * web template, installs this plugin, disables the tunnel, starts dsh web on a
 * free port, then exercises: health, local admin bootstrap, pairing, proxied
 * HTML, and the DSH Remote mux over the gateway's WebSocket proxy.
 *
 * Usage: npm run test:integration
 * Env: DSH_BIN (optional), KEEP=1 to keep the temp DSH_HOME.
 */

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const node = process.execPath
const dshBin =
  process.env.DSH_BIN ||
  path.join(path.dirname(node), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

if (!fs.existsSync(dshBin)) {
  console.error(`Cannot find DSH CLI at ${dshBin}; set DSH_BIN to .../@deepseek-ai/dsh/lib/bin.js`)
  process.exit(2)
}

const dshHome = path.join(root, '.dsh-it-check')
const profile = 'gwtest-check'
await fsp.rm(dshHome, { recursive: true, force: true })
await fsp.mkdir(dshHome, { recursive: true })
const env = { ...process.env, DSH_HOME: dshHome }

function run(args, options = {}) {
  const result = spawnSync(node, [dshBin, ...args], { env, stdio: 'ignore', timeout: options.timeout ?? 120000 })
  if (result.status !== 0) {
    throw new Error(`dsh ${args.join(' ')} failed with status ${result.status}`)
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(300)
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`)
}

function sessionCookie(response) {
  const raw = response.headers.getSetCookie?.()[0] || response.headers.get('set-cookie') || ''
  const match = /dsh_session=[^;]+/.exec(raw)
  return match ? match[0] : ''
}

let child
let passed = false
try {
  console.log(`DSH CLI: ${dshBin}`)
  console.log(`temp DSH_HOME: ${dshHome}`)
  run(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
  run(['plugin', '--profile', profile, 'add', root])
  console.log('profile initialized and plugin linked')

  const dshPort = await freePort()
  const gatewayPort = await freePort()
  const patchFile = path.join(dshHome, 'profiles', profile, 'cordis.patch.yml')
  await fsp.writeFile(
    patchFile,
    `# integration-check\n- id: gateway-mobile\n  config:\n    gateway:\n      host: '127.0.0.1'\n      port: ${gatewayPort}\n    tunnel:\n      enabled: false\n    auth:\n      pairingTokenExpiry: 300\n      sessionMaxAge: 3600\n    log:\n      level: 'warn'\n`,
    'utf8',
  )

  child = spawn(node, [dshBin, '--profile', profile, '--no-open', '--port', String(dshPort)], {
    env,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.once('exit', (code) => {
    if (!passed) console.error(`dsh exited early with code ${code}`)
  })

  const base = `http://127.0.0.1:${gatewayPort}`
  await waitFor(async () => (await fetch(`${base}/health`)).ok, 60000, 'gateway health')
  console.log('gateway health ok')

  const admin = await (await fetch(`${base}/mobile/api/v1/admin/pairing`)).json()
  if (admin.code !== 0 || !admin.data?.codeRaw) throw new Error(`admin pairing failed: ${JSON.stringify(admin)}`)
  console.log('local admin bootstrap ok (qr:', Boolean(admin.data.qrSvg), ')')

  const pair = await fetch(`${base}/mobile/api/v1/pairing/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingToken: admin.data.codeRaw, deviceName: 'Integration Phone' }),
  })
  const pairBody = await pair.json()
  const cookie = sessionCookie(pair)
  if (pairBody.code !== 0 || !cookie) throw new Error(`pairing failed: ${JSON.stringify(pairBody)}`)
  console.log('pairing ok:', pairBody.data.deviceId)

  const me = await (await fetch(`${base}/mobile/api/v1/me`, { headers: { cookie } })).json()
  if (me.code !== 0) throw new Error(`me failed: ${JSON.stringify(me)}`)
  console.log('session ok')

  const page = await fetch(`${base}/`, { headers: { cookie } })
  const html = await page.text()
  if (!page.ok || !/dsh|deepseek/i.test(html)) throw new Error(`proxied page failed: HTTP ${page.status}`)
  console.log('proxied DSH HTML ok:', html.length, 'bytes')

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/api/remote.mux`, { headers: { cookie } })
    const streamId = crypto.randomUUID()
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('remote mux timeout'))
    }, 10000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } })))
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString())
      if (frame.type === 'item' && frame.value?.type === 'ready') {
        clearTimeout(timer)
        ws.close()
        resolve()
      }
    })
    ws.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  console.log('DSH Remote mux through gateway ok')

  passed = true
  console.log('\nINTEGRATION CHECK PASSED')
} finally {
  if (child && !child.killed) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill('SIGTERM')
    }
  }
  await sleep(500)
  if (!process.env.KEEP) {
    await fsp.rm(dshHome, { recursive: true, force: true }).catch(() => {})
  } else {
    console.log(`kept ${dshHome}`)
  }
  if (!passed) process.exitCode = 1
}
