#!/usr/bin/env node
/**
 * Read-only environment diagnostics for dsh-gateway-mobile.
 *
 * Checks Node/DSH versions, cloudflared availability, the gateway port, the
 * data directory, DSH profiles that link this plugin, and whether secret
 * material exists. Never prints secrets, tokens or key contents.
 *
 * Usage: node scripts/doctor.mjs [--json] [--strict]
 *   --json    machine-readable output
 *   --strict  treat warnings as failures (exit 1)
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const flags = new Set(process.argv.slice(2))
const asJson = flags.has('--json')
const strict = flags.has('--strict')

const CLOUDFLARED_ASSETS = {
  'win32-x64': 'cloudflared-windows-amd64.exe',
  'win32-ia32': 'cloudflared-windows-386.exe',
  'linux-x64': 'cloudflared-linux-amd64',
  'linux-arm64': 'cloudflared-linux-arm64',
  'linux-arm': 'cloudflared-linux-arm',
  'darwin-x64': 'cloudflared-darwin-amd64.tgz',
  'darwin-arm64': 'cloudflared-darwin-arm64.tgz',
}

const checks = []
let packageJson = {}

function add(name, status, detail, hint = '') {
  checks.push({ name, status, detail, hint })
}

async function run(name, fn) {
  try {
    await fn()
  } catch (error) {
    add(name, 'fail', `check crashed: ${error instanceof Error ? error.message : String(error)}`, '')
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
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

/** Run a CLI, tolerating .cmd/.bat shims on Windows. */
function cliVersion(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
  })
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  if (result.error || result.status !== 0) return { ok: false, version: '', text }
  return { ok: true, version: (text.split(/\r?\n/)[0] ?? '').trim(), text }
}

function stripQuotes(value) {
  const trimmed = String(value ?? '').replace(/\s+#.*$/, '').trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Minimal, indentation-aware lookup inside a YAML section (best effort only). */
function sectionValue(text, section, key) {
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const head = /^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!head || head[2] !== section || head[3].trim() !== '') continue
    const sectionIndent = head[1].length
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const child = lines[inner]
      if (!child.trim()) continue
      const match = /^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/.exec(child)
      if (!match) continue
      if (match[1].length <= sectionIndent) break
      if (match[2] === key) return stripQuotes(match[3])
    }
  }
  return undefined
}

function topLevelValue(text, key) {
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (match && match[1] === key) return stripQuotes(match[2])
  }
  return undefined
}

function portInUse(port, host = '127.0.0.1', timeout = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const done = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function versionTriplet(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''))
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function meetsRequirement(installed, required) {
  const have = versionTriplet(installed)
  const want = versionTriplet(required)
  if (!have || !want) return null
  for (let index = 0; index < 3; index += 1) {
    if (have[index] > want[index]) return true
    if (have[index] < want[index]) return false
  }
  return true
}

function listProfiles(dshHome) {
  const profilesDir = path.join(dshHome, 'profiles')
  let names = []
  try {
    names = fs
      .readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  return names.map((name) => {
    const dir = path.join(profilesDir, name)
    const pkg = readJson(path.join(dir, 'package.json'))
    const patchFile = path.join(dir, 'cordis.patch.yml')
    let patch = ''
    try {
      patch = fs.readFileSync(patchFile, 'utf8')
    } catch {
      // Missing patch is fine; defaults apply.
    }
    const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies } : {}
    return {
      name,
      dir,
      linksPlugin: Object.keys(deps).includes('dsh-gateway-mobile') || patch.includes('dsh-gateway-mobile'),
      patch,
    }
  })
}

async function main() {
  packageJson = readJson(path.join(root, 'package.json')) ?? {}
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const profiles = listProfiles(dshHome)
  const pluginProfile = profiles.find((profile) => profile.linksPlugin)
  const configPatch = pluginProfile?.patch ?? profiles[0]?.patch ?? ''
  const dataDir = path.resolve(
    process.env.DSH_GATEWAY_DATA_DIR || topLevelValue(configPatch, 'dataDir') || path.join(dshHome, 'gateway-mobile'),
  )
  const gatewayPort = Number(sectionValue(configPatch, 'gateway', 'port') ?? 3081)
  const tunnelEnabled = (sectionValue(configPatch, 'tunnel', 'enabled') ?? 'true').toLowerCase() !== 'false'
  const tunnelMode = (sectionValue(configPatch, 'tunnel', 'mode') ?? 'quick').toLowerCase()
  const tunnelBinaryPath = sectionValue(configPatch, 'tunnel', 'binaryPath') ?? ''
  const tunnelAutoDownload = (sectionValue(configPatch, 'tunnel', 'autoDownload') ?? 'true').toLowerCase() !== 'false'

  await run('Node.js version', async () => {
    const major = Number(process.versions.node.split('.')[0])
    const enginesNode = packageJson.engines?.node ?? '>=24'
    if (major >= 24) add('Node.js version', 'ok', `${process.version} (requires ${enginesNode})`)
    else add('Node.js version', 'fail', `${process.version} (requires ${enginesNode})`, 'Install Node.js 24 LTS or newer')
  })

  await run('DSH CLI', async () => {
    const required = packageJson.engines?.dsh ?? ''
    const dshBin = process.env.DSH_BIN || findOnPath('dsh')
    if (!dshBin) {
      add('DSH CLI', 'warn', `not found on PATH (plugin requires dsh ${required || 'unknown'})`, 'Install @deepseek-ai/dsh and add it to PATH, or set DSH_BIN')
      return
    }
    const result = cliVersion(dshBin)
    if (!result.ok) {
      add('DSH CLI', 'warn', `found at ${dshBin} but --version failed`, 'Check the DSH installation')
      return
    }
    const meets = required ? meetsRequirement(result.version, required) : null
    if (meets === false) add('DSH CLI', 'warn', `${result.version} < required ${required}`, 'Upgrade @deepseek-ai/dsh')
    else add('DSH CLI', 'ok', `${result.version}${required ? ` (requires ${required})` : ''}`)
  })

  await run('cloudflared', async () => {
    if (!tunnelEnabled) {
      add('cloudflared', 'ok', 'tunnel disabled; cloudflared not needed')
      return
    }
    const asset = CLOUDFLARED_ASSETS[`${process.platform}-${process.arch}`]
    const candidates = [
      process.env.CLOUDFLARED_PATH ?? '',
      tunnelBinaryPath,
      findOnPath('cloudflared'),
      asset ? path.join(dataDir, 'cloudflared', asset) : '',
    ].filter(Boolean)
    const binary = candidates.find((candidate) => isExecutableFile(path.resolve(candidate)))
    if (!binary) {
      const hint = 'Install cloudflared, set tunnel.binaryPath/CLOUDFLARED_PATH, or enable tunnel.autoDownload'
      if (tunnelMode === 'named' || !tunnelAutoDownload) add('cloudflared', 'fail', 'binary not found', hint)
      else add('cloudflared', 'warn', 'binary not found (Quick Tunnel downloads it on first start)', hint)
      return
    }
    const result = cliVersion(path.resolve(binary))
    if (result.ok) add('cloudflared', 'ok', `${result.version} (${path.resolve(binary)})`)
    else add('cloudflared', 'warn', `found at ${path.resolve(binary)} but --version failed`, 'Reinstall cloudflared')
  })

  await run('gateway port', async () => {
    if (!Number.isInteger(gatewayPort) || gatewayPort <= 0 || gatewayPort > 65535) {
      add('gateway port', 'fail', `invalid configured port: ${gatewayPort}`, 'Set gateway.port to a free loopback port')
      return
    }
    const inUse = await portInUse(gatewayPort)
    if (inUse) add('gateway port', 'ok', `127.0.0.1:${gatewayPort} is in use (gateway appears to be running)`)
    else add('gateway port', 'warn', `127.0.0.1:${gatewayPort} is free (gateway not running)`, 'Start DSH with this plugin enabled to pair a phone')
  })

  await run('dataDir', async () => {
    try {
      const stat = fs.statSync(dataDir)
      if (!stat.isDirectory()) {
        add('dataDir', 'fail', `${dataDir} is not a directory`, 'Remove the file or choose another dataDir')
        return
      }
      fs.accessSync(dataDir, fs.constants.W_OK)
      add('dataDir', 'ok', `${dataDir} is writable`)
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        const parent = path.dirname(dataDir)
        try {
          fs.accessSync(parent, fs.constants.W_OK)
          add('dataDir', 'warn', `${dataDir} does not exist yet`, 'It is created automatically on the first gateway start')
        } catch {
          add('dataDir', 'fail', `parent of ${dataDir} is not writable`, 'Create the directory and grant write permission')
        }
        return
      }
      add('dataDir', 'fail', `${dataDir} is not writable`, 'Fix directory permissions or configure another dataDir')
    }
  })

  await run('DSH profile', async () => {
    if (profiles.length === 0) {
      add('DSH profile', 'warn', `no profiles found under ${path.join(dshHome, 'profiles')}`, `Initialize a profile, then run: dsh plugin --profile <name> add ${root}`)
      return
    }
    if (pluginProfile) add('DSH profile', 'ok', `plugin linked in profile "${pluginProfile.name}"`)
    else add('DSH profile', 'warn', `plugin not linked in any of ${profiles.length} profile(s)`, `Run: dsh plugin --profile <name> add ${root}`)
  })

  await run('credentials/keys', async () => {
    try {
      const stat = fs.statSync(dataDir)
      if (!stat.isDirectory()) {
        add('credentials/keys', 'warn', 'dataDir is missing; secret material is not available yet')
        return
      }
    } catch {
      add('credentials/keys', 'warn', 'dataDir is missing; secret material will be generated on first start')
      return
    }
    const present = ['secret-keys.json', 'secret.keys', 'secret.key'].filter((name) => {
      try {
        return fs.statSync(path.join(dataDir, name)).isFile()
      } catch {
        return false
      }
    })
    // Only file names are reported; contents are never read or echoed.
    if (present.length > 0) add('credentials/keys', 'ok', `secret material present (${present.join(', ')})`)
    else add('credentials/keys', 'warn', 'no secret material yet', 'It is generated automatically on first start; rotate from the admin console if lost')
  })

  const failed = checks.filter((check) => check.status === 'fail').length
  const warned = checks.filter((check) => check.status === 'warn').length
  const ok = failed === 0 && (!strict || warned === 0)

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok, strict, summary: { ok: checks.length - failed - warned, warn: warned, fail: failed }, checks }, null, 2)}\n`)
  } else {
    const icon = { ok: '✅', warn: '⚠', fail: '❌' }
    console.log('dsh-gateway-mobile doctor\n')
    for (const check of checks) {
      console.log(`${icon[check.status]} ${check.name}: ${check.detail}`)
      if (check.hint) console.log(`   ↳ ${check.hint}`)
    }
    console.log(`\n${checks.length - failed - warned} ok, ${warned} warning(s), ${failed} failure(s)${strict ? ' (strict)' : ''}`)
  }

  process.exitCode = ok ? 0 : 1
}

main().catch((error) => {
  console.error(`doctor crashed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
