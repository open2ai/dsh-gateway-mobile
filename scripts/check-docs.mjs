#!/usr/bin/env node
/**
 * Validate version references in docs and the pack manifest against package.json.
 *
 * Checks:
 * - package.json version / engines.dsh / engines.node
 * - README*.md Status/状态 line, DSH requirement, Node requirement
 * - CHANGELOG*.md first version heading
 * - docs/DETAIL*.md DSH (and plugin, when present) version references
 * - docs/api.md example `version` / `gatewayVersion` fields
 * - docs/architecture-flow.md + docs/deviations.md plugin `0.1.x` and DSH `0.2.x` refs
 * - scripts/pack.mjs manifest derives from package.json.files (no whole docs/)
 *
 * Usage: node scripts/check-docs.mjs [--json]
 * Exit code: 0 when no ❌, 1 when any ❌.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const flags = new Set(process.argv.slice(2))
const asJson = flags.has('--json')

const checks = []
const GLOB_CHARS = /[*?[\]{}!]/

function add(name, status, message, file = '') {
  checks.push({ name, status, message, file })
}

function read(relative) {
  try {
    return fs.readFileSync(path.join(root, relative), 'utf8')
  } catch {
    return null
  }
}

function exists(relative) {
  return fs.existsSync(path.join(root, relative))
}

function collect(text, regex) {
  const pattern = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`)
  const tokens = []
  let match
  while ((match = pattern.exec(text)) !== null) {
    tokens.push(match[1])
    if (match[0] === '') pattern.lastIndex += 1
  }
  return tokens
}

/** Compare captured version tokens with the expected value; zero tokens is inert. */
function checkVersions(name, file, tokens, expected, kind) {
  const unique = [...new Set(tokens.filter((token) => token !== undefined))]
  if (unique.length === 0) {
    add(name, 'ok', `no ${kind} reference found`, file)
    return
  }
  const bad = unique.filter((token) => token !== expected)
  if (bad.length > 0) {
    add(name, 'fail', `${kind} reference(s) ${bad.map((token) => `"${token}"`).join(', ')} != ${expected}`, file)
    return
  }
  add(name, 'ok', `${kind} reference(s) match ${expected}`, file)
}

function requireDoc(relative) {
  const text = read(relative)
  if (text === null) add(`missing ${relative}`, 'fail', 'required documentation file is missing', relative)
  return text
}

const pkgText = read('package.json')
if (pkgText === null) {
  console.error('check-docs: package.json is missing')
  process.exit(1)
}
let pkg
try {
  pkg = JSON.parse(pkgText)
} catch (error) {
  console.error(`check-docs: package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const pluginVersion = String(pkg.version ?? '')
const dshVersion = String(pkg.engines?.dsh ?? '')
const nodeRange = String(pkg.engines?.node ?? '')
const nodeMajor = /(\d+)/.exec(nodeRange)?.[1] ?? ''

if (!/^\d+\.\d+\.\d+/.test(pluginVersion)) {
  add('package.json version', 'fail', `invalid version "${pluginVersion}"`, 'package.json')
} else {
  add('package.json version', 'ok', pluginVersion, 'package.json')
}
if (!dshVersion) add('package.json engines.dsh', 'fail', 'engines.dsh is missing', 'package.json')
else add('package.json engines.dsh', 'ok', dshVersion, 'package.json')
if (!nodeMajor) add('package.json engines.node', 'fail', 'engines.node is missing', 'package.json')
else add('package.json engines.node', 'ok', nodeRange, 'package.json')

// --- README status / requirements ------------------------------------------------
const readmeFiles = [
  { file: 'README.md', statusRegex: /\bStatus:\s*\*\*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\*\*/i, label: 'README.md Status' },
  { file: 'README.zh.md', statusRegex: /状态[:：]\s*\*\*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\*\*/, label: 'README.zh.md 状态' },
]
for (const entry of readmeFiles) {
  const text = requireDoc(entry.file)
  if (text === null) continue
  const match = entry.statusRegex.exec(text)
  if (!match) {
    add(entry.label, 'warn', 'no Status/状态 version declaration found', entry.file)
  } else if (match[1] !== pluginVersion) {
    add(entry.label, 'fail', `declares ${match[1]} != package.json ${pluginVersion}`, entry.file)
  } else {
    add(entry.label, 'ok', match[1], entry.file)
  }

  const dshTokens = collect(text, /DSH\s+`?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)`?/g)
  checkVersions(`${entry.file} DSH requirement`, entry.file, dshTokens, dshVersion, 'DSH version')

  const nodeMatch = /Node(?:\.js)?\s*(?:>=|≥)?\s*(\d+)\s*\+?/i.exec(text)
  if (!nodeMatch) add(`${entry.file} Node requirement`, 'warn', 'no Node.js version requirement found', entry.file)
  else if (nodeMajor && nodeMatch[1] !== nodeMajor) {
    add(`${entry.file} Node requirement`, 'fail', `Node ${nodeMatch[1]} != engines.node ${nodeRange}`, entry.file)
  } else add(`${entry.file} Node requirement`, 'ok', `Node ${nodeMatch[1]}+ matches engines.node`, entry.file)
}

// --- CHANGELOG first version -----------------------------------------------------
for (const file of ['CHANGELOG.md', 'CHANGELOG.zh.md']) {
  const text = requireDoc(file)
  if (text === null) continue
  const match = /^##\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/m.exec(text)
  if (!match) add(`${file} first version`, 'warn', 'no "## X.Y.Z" heading found', file)
  else if (match[1] !== pluginVersion) {
    add(`${file} first version`, 'fail', `latest heading ${match[1]} != package.json ${pluginVersion}`, file)
  } else add(`${file} first version`, 'ok', match[1], file)
}

// --- DETAIL docs -----------------------------------------------------------------
for (const file of ['docs/DETAIL.md', 'docs/DETAIL.zh.md']) {
  const text = read(file)
  if (text === null) {
    add(`missing ${file}`, 'warn', 'optional document is missing', file)
    continue
  }
  checkVersions(`${file} DSH reference`, file, collect(text, /DSH\s+`([^`]+)`/g), dshVersion, 'DSH version')
  checkVersions(
    `${file} plugin reference`,
    file,
    collect(text, /(?:插件|plugin)\s*[`"*]*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/gi),
    pluginVersion,
    'plugin version',
  )
}

// --- docs/api.md examples --------------------------------------------------------
const apiText = requireDoc('docs/api.md')
if (apiText !== null) {
  const apiVersions = [
    ...collect(apiText, /"version"\s*:\s*"([^"]+)"/g),
    ...collect(apiText, /"gatewayVersion"\s*:\s*"([^"]+)"/g),
  ]
  checkVersions('docs/api.md example version', 'docs/api.md', apiVersions, pluginVersion, 'plugin version')
}

// --- architecture-flow / deviations ---------------------------------------------
for (const file of ['docs/architecture-flow.md', 'docs/deviations.md']) {
  const text = read(file)
  if (text === null) {
    add(`missing ${file}`, 'fail', 'required document is missing', file)
    continue
  }
  checkVersions(
    `${file} plugin version refs`,
    file,
    collect(text, /(?:Plugin version|插件)[：:\s]*`?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`?/gi),
    pluginVersion,
    'plugin version',
  )
  checkVersions(
    `${file} DSH version refs`,
    file,
    collect(text, /\b(0\.2\.\d+(?:-[0-9A-Za-z.]+)?)\b/g).filter((token) => token !== pluginVersion),
    dshVersion,
    'DSH version',
  )
}

// --- pack manifest vs package.json.files ----------------------------------------
const files = Array.isArray(pkg.files) ? pkg.files : []
const packText = read('scripts/pack.mjs')

if (files.length === 0) {
  add('package.json files', 'fail', 'files array is missing or empty', 'package.json')
} else {
  add('package.json files', 'ok', `${files.length} entries`, 'package.json')
}

if (packText === null) {
  add('pack manifest', 'fail', 'scripts/pack.mjs is missing', 'scripts/pack.mjs')
} else {
  const derivesManifest = /pkg\.files/.test(packText) && /new Set/.test(packText)
  if (!derivesManifest) {
    add('pack manifest derivation', 'fail', 'scripts/pack.mjs does not derive entries from pkg.files', 'scripts/pack.mjs')
  } else {
    add('pack manifest derivation', 'ok', 'entries derive from package.json.files', 'scripts/pack.mjs')
  }

  if (/['"]docs['"]/.test(packText)) {
    add('pack manifest docs', 'fail', 'scripts/pack.mjs still hardcodes the whole docs/ directory', 'scripts/pack.mjs')
  } else {
    add('pack manifest docs', 'ok', 'no hardcoded whole-docs entry', 'scripts/pack.mjs')
  }

  for (const required of ['package.json', 'README.md', 'LICENSE']) {
    if (!packText.includes(required)) {
      add(`pack manifest ${required}`, 'fail', `scripts/pack.mjs does not add ${required}`, 'scripts/pack.mjs')
    } else add(`pack manifest ${required}`, 'ok', `${required} is included`, 'scripts/pack.mjs')
  }
}

const filesSet = new Set(files)
for (const required of ['cordis.patch.yml', 'LICENSE', 'docs/DETAIL.md', 'docs/DETAIL.zh.md']) {
  if (!filesSet.has(required)) {
    add(`package.json files ${required}`, 'fail', `${required} must be listed in package.json.files`, 'package.json')
  } else add(`package.json files ${required}`, 'ok', required, 'package.json')
}
if (filesSet.has('docs')) {
  add('package.json files docs', 'fail', 'package.json.files must not ship the whole docs/ directory', 'package.json')
}
// `lib/` is a build output (git-ignored), so a missing copy is a warning until
// the first `npm run build`; every other listed path must exist in the repo.
const GENERATED_ENTRIES = new Set(['lib'])
for (const entry of files) {
  if (GLOB_CHARS.test(entry)) continue
  if (exists(entry)) continue
  if (GENERATED_ENTRIES.has(entry)) {
    add('package.json files entry', 'warn', `generated path not built yet: ${entry}`, 'package.json')
  } else {
    add('package.json files entry', 'fail', `listed path does not exist: ${entry}`, 'package.json')
  }
}

// --- report ---------------------------------------------------------------------
const failed = checks.filter((check) => check.status === 'fail').length
const warned = checks.filter((check) => check.status === 'warn').length
const ok = failed === 0

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok,
        package: { version: pluginVersion, dsh: dshVersion, node: nodeRange },
        summary: { ok: checks.length - failed - warned, warn: warned, fail: failed },
        checks,
      },
      null,
      2,
    )}\n`,
  )
} else {
  const icon = { ok: '✅', warn: '⚠', fail: '❌' }
  console.log('dsh-gateway-mobile check-docs\n')
  for (const check of checks) {
    const where = check.file ? ` [${check.file}]` : ''
    console.log(`${icon[check.status]} ${check.name}${where}: ${check.message}`)
  }
  console.log(`\n${checks.length - failed - warned} ok, ${warned} warning(s), ${failed} failure(s)`)
}

process.exitCode = ok ? 0 : 1
