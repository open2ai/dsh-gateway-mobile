import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

// PWA build manifest + service-worker wiring. `npm test` runs the web build
// first, so the manifest exists; standalone runs skip the content checks.
const manifestUrl = new URL('../web/assets/build.json', import.meta.url)
const built = existsSync(manifestUrl)
const skip = built ? false : 'web/assets/build.json missing: run node scripts/build-web.mjs'
const manifest = built ? JSON.parse(readFileSync(manifestUrl, 'utf8')) : null
const sw = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8')
const appHtml = readFileSync(new URL('../web/app.html', import.meta.url), 'utf8')
const shellHtml = readFileSync(new URL('../web/shell.html', import.meta.url), 'utf8')
const appCss = readFileSync(new URL('../web/assets/app.css', import.meta.url), 'utf8')

const sha8 = (buffer) => createHash('sha256').update(buffer).digest('hex').slice(0, 8)

test('build manifest has the agreed schema', { skip }, () => {
  assert.match(manifest.version, /^[0-9a-f]{8}$/)
  assert.ok(!Number.isNaN(Date.parse(manifest.generatedAt)), 'generatedAt must be an ISO timestamp')
  assert.ok(manifest.assets && typeof manifest.assets === 'object')
  const names = Object.keys(manifest.assets)
  assert.ok(names.length > 0)
  for (const name of names) {
    assert.match(name, /\.(js|css)$/)
    assert.match(manifest.assets[name], /^[0-9a-f]{8}$/, `${name} hash must be 8 hex chars`)
  }
  // Every emitted JS bundle and the hand-written CSS are covered.
  for (const required of ['admin.js', 'app.js', 'common.js', 'shell.js', 'admin.css', 'app.css', 'pair.css']) {
    assert.ok(names.includes(required), `${required} missing from manifest`)
  }
})

test('manifest hashes match the files on disk', { skip }, () => {
  for (const [name, hash] of Object.entries(manifest.assets)) {
    const file = new URL(`../web/assets/${name}`, import.meta.url)
    assert.ok(existsSync(file), `${name} listed in manifest but missing on disk`)
    assert.equal(sha8(readFileSync(file)), hash, `${name} hash is stale; rebuild web assets`)
  }
})

test('manifest version is the union hash of the sorted assets', { skip }, () => {
  const union = sha8(Buffer.from(Object.entries(manifest.assets).map(([name, hash]) => `${name}:${hash}`).join('\n'), 'utf8'))
  assert.equal(manifest.version, union)
})

test('service worker derives its cache from the build manifest', () => {
  assert.match(sw, /\/mobile\/assets\/build\.json/)
  assert.match(sw, /cache:\s*'no-store'/)
  assert.match(sw, /dsh-gateway-mobile-/)
  assert.match(sw, /\?v=\$\{hash\}/)
  assert.match(sw, /FALLBACK_SHELL/)
  assert.match(sw, /\/mobile\/icon\.svg/)
  assert.match(sw, /\/mobile\/manifest\.webmanifest/)
  // Never cache API/WebSocket traffic or navigation HTML.
  assert.match(sw, /\/mobile\/api\//)
  assert.match(sw, /event\.request\.mode === 'navigate'/)
  // Stale caches are cleaned up on activate.
  assert.match(sw, /caches\.delete/)
})

test('phone pages expose weak-network status affordances', () => {
  assert.match(appHtml, /id="sync-state"/)
  assert.match(shellHtml, /id="shell-timeout"/)
  assert.match(shellHtml, /id="shell-retry"/)
  assert.match(shellHtml, /href="\/mobile\/diag"/)
  assert.match(appCss, /\.shell-timeout/)
  assert.match(appCss, /\.shell-spinner\[hidden\]/)
})
