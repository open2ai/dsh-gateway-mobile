#!/usr/bin/env node
/**
 * Hot-reload smoke test for the DSH host plugin.
 *
 * Creates a throwaway DSH_HOME, links this repository into a temporary profile
 * with the tunnel disabled, starts `dsh web` on free loopback ports, waits for
 * the gateway `/health`, touches `lib/index.js`, and verifies the gateway comes
 * back healthy after the host reloads the plugin. Cleans up the whole process
 * tree on exit (Windows: taskkill /T /F).
 *
 * Usage: node scripts/hmr-check.mjs [--strict]
 *   --strict  exit 1 when `dsh` is missing (otherwise it is a skip)
 *
 * Requires `dsh` on PATH or DSH_BIN pointing at the DSH CLI, and a completed
 * `npm run build` (lib/ must exist).
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const strict = process.argv.includes('--strict')
const dshHome = path.join(root, '.dsh-hmr-check')
const profile = 'gwtest-hmr'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isExecutableFile(file) {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() && stat.size > 1024
  } catch {
    return false
  }
}

function findOnPath(command) {
  const pathEnv = process.env.PATH ?? ''
  const names =
    process.platform === 'win32'
      ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
      : [command]
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    for (const candidate of names) {
      const file = path.join(dir, candidate)
      if (isExecutableFile(file)) return file
    }
  }
  return ''
}

function resolveDsh() {
  const explicit = process.env.DSH_BIN
  if (explicit && fs.existsSync(explicit)) return explicit
  return findOnPath('dsh')
}

function dshCommand() {
  const dshBin = resolveDsh()
  if (!dshBin) return null
  if (/\.(js|mjs|cjs)$/i.test(dshBin)) return { command: process.execPath, prefix: [dshBin] }
  return { command: dshBin, prefix: [] }
}

function dshEnv() {
  return { ...process.env, DSH_HOME: dshHome }
}

function spawnDsh(extraArgs, options = {}) {
  const spec = dshCommand()
  if (!spec) throw new Error('dsh CLI not found')
  return spawn(spec.command, [...spec.prefix, ...extraArgs], {
    env: dshEnv(),
    cwd: root,
    stdio: options.stdio ?? 'ignore',
    windowsHide: true,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(spec.command),
  })
}

function runDshSync(extraArgs, timeout = 120_000) {
  const spec = dshCommand()
  if (!spec) throw new Error('dsh CLI not found')
  const result = spawnSync(spec.command, [...spec.prefix, ...extraArgs], {
    env: dshEnv(),
    cwd: root,
    stdio: 'ignore',
    timeout,
    windowsHide: true,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(spec.command),
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`dsh ${extraArgs.join(' ')} exited with status ${result.status ?? 'null'}`)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
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

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
  const body = await response.json().catch(() => null)
  return { response, body }
}

/** Health marker that changes when the plugin instance is re-applied. */
function healthMarker(body) {
  if (!body || typeof body !== 'object') return null
  const value = body.startedAt ?? body.started ?? null
  return value === null ? null : JSON.stringify(value)
}

function listeningPids(port) {
  const pids = new Set()
  if (process.platform === 'win32') {
    const result = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
    for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue
      if (!new RegExp(`:${port}\\s`).test(line)) continue
      const parts = line.trim().split(/\s+/)
      const pid = parts[parts.length - 1]
      if (pid) pids.add(pid)
    }
    return pids
  }
  const result = spawnSync('ss', ['-ltnp'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    if (!new RegExp(`:${port}\\s`).test(line)) continue
    for (const match of line.matchAll(/pid=(\d+)/g)) pids.add(match[1])
  }
  return pids
}

function killTree(child) {
  if (!child || child.killed) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try {
      child.kill('SIGTERM')
    } catch {
      // ignore
    }
  }
}

let child = null

async function main() {
  const spec = dshCommand()
  if (!spec) {
    console.log('dsh not found on PATH (and DSH_BIN is unset); skipping HMR check')
    process.exitCode = strict ? 1 : 0
    return
  }
  console.log('dsh HMR check: preparing temporary profile')

  const libEntry = path.join(root, 'lib', 'index.js')
  if (!fs.existsSync(libEntry)) {
    throw new Error(`${libEntry} is missing; run "npm run build" first`)
  }

  await fsp.rm(dshHome, { recursive: true, force: true })
  await fsp.mkdir(dshHome, { recursive: true })

  runDshSync(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
  runDshSync(['plugin', '--profile', profile, 'add', root])

  const dshPort = await freePort()
  const gatewayPort = await freePort()
  const patchFile = path.join(dshHome, 'profiles', profile, 'cordis.patch.yml')
  await fsp.writeFile(
    patchFile,
    `# hmr-check\n- id: gateway-mobile\n  config:\n    gateway:\n      host: '127.0.0.1'\n      port: ${gatewayPort}\n    tunnel:\n      enabled: false\n    auth:\n      pairingTokenExpiry: 300\n      sessionMaxAge: 3600\n    log:\n      level: 'warn'\n`,
    'utf8',
  )

  child = spawnDsh(['--profile', profile, '--no-open', '--port', String(dshPort)])
  let exitCode = null
  child.once('exit', (code) => {
    exitCode = code
  })
  console.log(`dsh web: pid ${child.pid}, dsh port ${dshPort}, gateway port ${gatewayPort}`)

  const base = `http://127.0.0.1:${gatewayPort}`
  await waitFor(
    async () => {
      if (exitCode !== null) throw new Error(`dsh web exited early with code ${exitCode}`)
      const { response, body } = await fetchJson(`${base}/health`)
      return response.ok && body && body.ok === true
    },
    60_000,
    'gateway /health',
  )
  console.log('gateway /health ok; capturing plugin start marker')

  const before = await fetchJson(`${base}/health?deep=1`).catch(() => null)
  const beforeMarker = healthMarker(before?.body)
  if (!beforeMarker) console.warn('warning: deep health did not expose startedAt; falling back to downtime detection')

  // Touch the built entry so the host watcher re-applies the plugin.
  const now = new Date()
  fs.utimesSync(libEntry, now, now)
  console.log(`touched ${path.relative(root, libEntry)}; waiting for reload`)

  let sawUnhealthy = false
  await waitFor(
    async () => {
      if (exitCode !== null) throw new Error(`dsh web exited during reload with code ${exitCode}`)
      let deep = null
      try {
        deep = await fetchJson(`${base}/health?deep=1`)
      } catch {
        sawUnhealthy = true
        return false
      }
      if (!deep.response.ok) {
        sawUnhealthy = true
        return false
      }
      const afterMarker = healthMarker(deep.body)
      if (beforeMarker && afterMarker && afterMarker !== beforeMarker) return true
      if (!beforeMarker && sawUnhealthy) return true
      return false
    },
    30_000,
    'plugin reload',
  )
  console.log('plugin reloaded; /health still ok')

  const pids = listeningPids(gatewayPort)
  if (pids.size > 1) throw new Error(`gateway port ${gatewayPort} has ${pids.size} listeners (expected 1)`)
  if (pids.size === 0) console.warn(`warning: no LISTENING socket observed for gateway port ${gatewayPort}`)
  else console.log(`gateway port ${gatewayPort}: single listener`)

  console.log('tunnel disabled in this profile; no cloudflared is spawned')
  console.log('\nHMR CHECK PASSED')
}

try {
  await main()
} catch (error) {
  console.error(`HMR CHECK FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  killTree(child)
  await sleep(500)
  if (!process.env.KEEP) {
    await fsp.rm(dshHome, { recursive: true, force: true }).catch(() => {})
  } else {
    console.log(`kept ${dshHome}`)
  }
}
