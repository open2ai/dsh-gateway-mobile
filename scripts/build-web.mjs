import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ASSETS_DIR = 'web/assets'
const CSS_ASSETS = ['admin.css', 'app.css', 'pair.css']
const MANIFEST = 'build.json'

const entries = ['admin', 'app', 'common', 'devices', 'diag', 'oauth', 'pair', 'shell']

await build({
  entryPoints: entries.map((name) => `web/src/${name}.ts`),
  outdir: 'web/assets',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  splitting: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
})

function sha8(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 8)
}

async function hashFile(name) {
  try {
    return sha8(await readFile(join(ASSETS_DIR, name)))
  } catch {
    return null
  }
}

/** Every emitted JS bundle plus the hand-written CSS shipped to the PWA. */
const jsFiles = (await readdir(ASSETS_DIR)).filter((name) => name.endsWith('.js')).sort()
const assetNames = [...new Set([...jsFiles, ...CSS_ASSETS])].sort()

const assets = {}
for (const name of assetNames) {
  const hash = await hashFile(name)
  if (hash) assets[name] = hash
}

// Union hash: deterministic over the sorted `name:hash` pairs so every asset
// change produces a new PWA cache name.
const version = sha8(Buffer.from(Object.entries(assets).map(([name, hash]) => `${name}:${hash}`).join('\n'), 'utf8'))

// Keep the manifest content idempotent: when nothing changed, preserve the
// original generatedAt so repeated builds do not churn the file (and the
// gateway's rewritten ?v= URLs stay stable).
let generatedAt = new Date().toISOString()
try {
  const previous = JSON.parse(await readFile(join(ASSETS_DIR, MANIFEST), 'utf8'))
  if (previous && previous.version === version && JSON.stringify(previous.assets) === JSON.stringify(assets)) {
    generatedAt = typeof previous.generatedAt === 'string' && previous.generatedAt ? previous.generatedAt : generatedAt
  }
} catch {
  // First build, missing or unreadable manifest: keep the fresh timestamp.
}

const manifest = { version, generatedAt, assets }
await writeFile(join(ASSETS_DIR, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`\n  ${ASSETS_DIR}/${MANIFEST}  version=${version}  assets=${Object.keys(assets).length}`)
