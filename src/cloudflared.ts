/**
 * Resolve (or download) the cloudflared binary.
 *
 * Quick Tunnel is a development/testing facility. The gateway still verifies
 * the binary's SHA-256 when a hash is configured or known for the pinned
 * release; otherwise it records the observed hash and warns loudly.
 *
 * @module dsh-gateway-mobile/lib/cloudflared
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CODES, GatewayError } from './errors.js'
import type { GatewayConfig } from './config.js'
import type { Logger } from './logger.js'
import { errorMessage } from './util.js'

/** Assets published for the pinned release. */
const ASSETS: Readonly<Record<string, string>> = {
  'win32-x64': 'cloudflared-windows-amd64.exe',
  'win32-ia32': 'cloudflared-windows-386.exe',
  'linux-x64': 'cloudflared-linux-amd64',
  'linux-arm64': 'cloudflared-linux-arm64',
  'linux-arm': 'cloudflared-linux-arm',
  'darwin-x64': 'cloudflared-darwin-amd64.tgz',
  'darwin-arm64': 'cloudflared-darwin-arm64.tgz',
}

/**
 * Known hashes for the pinned release. Filled for the platforms we can verify
 * offline; other platforms require tunnel.sha256 or an explicit binaryPath.
 */
const KNOWN_SHA256: Record<string, string> = {
  // Filled by the release process; empty means "verify at download time and warn".
}

export function assetName(asset: string): string {
  return asset
}

function cacheFile(dataDir: string, asset: string): string {
  return path.join(dataDir, 'cloudflared', asset)
}

function isExecutableFile(file: string): boolean {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() && stat.size > 1024
  } catch {
    return false
  }
}

function findOnPath(name: string): string {
  const pathEnv = process.env.PATH ?? ''
  const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name]
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    for (const candidate of names) {
      const file = path.join(dir, candidate)
      if (isExecutableFile(file)) return file
    }
  }
  return ''
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Resolve the cloudflared binary path, downloading it when allowed.
 */
export async function resolveCloudflared(config: GatewayConfig, logger: Logger): Promise<string> {
  const explicit = [
    config.tunnel.binaryPath,
    process.env.CLOUDFLARED_PATH ?? '',
  ].filter((value): value is string => Boolean(value))
  for (const candidate of explicit) {
    const file = path.resolve(candidate)
    if (isExecutableFile(file)) return file
    logger.warn(`Configured cloudflared path is not executable: ${file}`)
  }
  const onPath = findOnPath('cloudflared')
  if (onPath) return onPath

  const asset = ASSETS[`${process.platform}-${process.arch}`]
  if (!asset) {
    throw new GatewayError(CODES.TUNNEL_START_FAILED, {}, 500, `unsupported platform ${process.platform}-${process.arch}; set tunnel.binaryPath`)
  }
  const cached = cacheFile(config.dataDir, asset)
  if (isExecutableFile(cached)) return cached
  if (!config.tunnel.autoDownload) {
    throw new GatewayError(CODES.TUNNEL_START_FAILED, {}, 500, 'cloudflared is not installed; set tunnel.binaryPath or enable tunnel.autoDownload')
  }
  return downloadCloudflared(config, asset, logger)
}

export async function downloadCloudflared(config: GatewayConfig, asset: string, logger: Logger): Promise<string> {
  if (asset.endsWith('.tgz')) {
    throw new GatewayError(CODES.CLOUDFLARED_DOWNLOAD_FAILED, {}, 500, 'automatic download for macOS is not supported; install cloudflared or set tunnel.binaryPath')
  }
  const version = config.tunnel.version
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${version}/${asset}`
  const target = cacheFile(config.dataDir, asset)
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  logger.info(`Downloading cloudflared ${version} from ${url}`)
  let buffer: Buffer
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    buffer = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    throw new GatewayError(CODES.CLOUDFLARED_DOWNLOAD_FAILED, {}, 500, `download failed: ${errorMessage(error)}`)
  }
  const observed = crypto.createHash('sha256').update(buffer).digest('hex')
  const expected = config.tunnel.sha256 || KNOWN_SHA256[`${version}:${asset}`] || ''
  if (expected && expected.toLowerCase() !== observed) {
    throw new GatewayError(
      CODES.CLOUDFLARED_DOWNLOAD_FAILED,
      { expected, observed },
      500,
      `cloudflared SHA-256 mismatch (expected ${expected}, got ${observed})`,
    )
  }
  if (!expected) {
    logger.warn(`cloudflared hash is not pinned for ${asset}; observed sha256=${observed}. Set tunnel.sha256 to enforce verification.`)
  }
  const temp = `${target}.${process.pid}.tmp`
  await fsp.writeFile(temp, buffer, { mode: 0o755 })
  try {
    await fsp.rename(temp, target)
  } catch (error) {
    if (process.platform === 'win32') {
      await fsp.rm(target, { force: true })
      await fsp.rename(temp, target)
    } else {
      throw error
    }
  }
  try {
    await fsp.chmod(target, 0o755)
  } catch {
    // Windows ignores POSIX modes.
  }
  const check = spawnSync(target, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
  if (check.error || check.status !== 0) {
    throw new GatewayError(CODES.CLOUDFLARED_DOWNLOAD_FAILED, {}, 500, `downloaded binary failed to run: ${check.error?.message ?? check.stderr}`)
  }
  logger.info(`cloudflared ready at ${target} (${check.stdout.trim() || 'version unknown'})`)
  return target
}

export { ASSETS, KNOWN_SHA256, sha256File, findOnPath }
