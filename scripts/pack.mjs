#!/usr/bin/env node
/**
 * Build a distributable zip/tarball of the plugin.
 *
 * Usage: npm run pack
 * Output: dist/dsh-gateway-mobile-<version>.(zip|tar.gz)
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'))
const dist = path.join(root, 'dist')
const stage = path.join(dist, 'dsh-gateway-mobile')

await fsp.rm(dist, { recursive: true, force: true })
await fsp.mkdir(stage, { recursive: true })

const entries = ['package.json', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'CHANGELOG.md', 'CHANGELOG.zh.md', 'LICENSE', 'lib', 'web', 'docs']
for (const entry of entries) {
  const source = path.join(root, entry)
  if (!fs.existsSync(source)) continue
  await fsp.cp(source, path.join(stage, entry), { recursive: true })
}

const base = path.join(dist, `dsh-gateway-mobile-${pkg.version}`)
if (process.platform === 'win32') {
  const zip = `${base}.zip`
  const result = spawnSync('tar.exe', ['-a', '-c', '-f', zip, '-C', stage, '.'], { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error('tar.exe failed; trying Compress-Archive')
    const ps = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `Compress-Archive -Path "${stage}\\*" -DestinationPath "${zip}" -Force`],
      { stdio: 'inherit' },
    )
    if (ps.status !== 0) process.exit(1)
  }
  console.log(`packed ${zip}`)
} else {
  const tar = `${base}.tar.gz`
  const result = spawnSync('tar', ['-czf', tar, '-C', dist, 'dsh-gateway-mobile'], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(1)
  console.log(`packed ${tar}`)
}
