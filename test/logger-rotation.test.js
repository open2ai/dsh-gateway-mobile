import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Logger } from '../lib/logger.js'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function tempLogFile(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-logger-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}))
  return { dir, file: path.join(dir, 'gateway.log') }
}

function readLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
}

test('logger: flush() persists every queued entry as JSONL', async (t) => {
  const { file } = await tempLogFile(t)
  const logger = new Logger({ level: 'error', file, maxEntries: 10 })
  logger.info('hello', { detail: 'world' })
  logger.warn('careful')
  logger.error('boom')

  await logger.flush()

  const lines = readLines(file)
  assert.equal(lines.length, 3)
  const first = JSON.parse(lines[0])
  assert.equal(first.level, 'info')
  assert.equal(first.message, 'hello')
  assert.deepEqual(first.meta, { detail: 'world' })
  assert.equal(JSON.parse(lines[1]).message, 'careful')
  assert.equal(JSON.parse(lines[2]).message, 'boom')
})

test('logger: rotates files at maxBytes and keeps at most maxFiles generations', async (t) => {
  const { file } = await tempLogFile(t)
  const logger = new Logger({ level: 'error', file, maxBytes: 180, maxFiles: 2 })
  const padding = 'x'.repeat(60)
  for (let index = 0; index < 60; index += 1) logger.info(`${index}:${padding}`)
  await logger.flush()

  assert.equal(fs.existsSync(file), true)
  assert.equal(fs.existsSync(`${file}.1`), true)
  assert.equal(fs.existsSync(`${file}.2`), true)
  assert.equal(fs.existsSync(`${file}.3`), false)

  for (const candidate of [file, `${file}.1`, `${file}.2`]) {
    const lines = readLines(candidate)
    assert.ok(lines.length > 0, `${candidate} should hold entries`)
    for (const line of lines) JSON.parse(line)
  }
})

test('logger: queryAudit filters by action/since/limit and auditTotal counts entries', async (t) => {
  const { file } = await tempLogFile(t)
  const logger = new Logger({ level: 'error', file })

  logger.audit({ action: 'pairing.success', deviceId: 'device-1' })
  const firstAt = Date.parse(logger.auditEntries[0].timestamp)
  await sleep(25)
  logger.audit({ action: 'device.logout', deviceId: 'device-1' })
  logger.audit({ action: 'pairing.success', deviceId: 'device-2' })
  logger.info('not-audit')

  assert.equal(logger.auditTotal(), 3)
  const all = await logger.queryAudit()
  assert.equal(all.entries.length, 3)
  assert.equal(all.total, 3)
  const pairings = await logger.queryAudit({ action: 'pairing.success' })
  assert.deepEqual(
    pairings.entries.map((entry) => entry.message),
    ['pairing.success', 'pairing.success'],
  )
  assert.equal(pairings.total, 2)
  assert.equal((await logger.queryAudit({ action: 'device.logout' })).total, 1)
  assert.equal((await logger.queryAudit({ action: 'missing' })).total, 0)
  assert.equal((await logger.queryAudit({ since: firstAt + 5 })).total, 2)
  const limited = await logger.queryAudit({ action: 'pairing.success', limit: 1 })
  assert.equal(limited.total, 2)
  assert.equal(limited.entries.length, 1)
  assert.equal((await logger.queryAudit({ limit: 2 })).entries.length, 2)

  await logger.flush()
  const lines = readLines(file)
  assert.equal(lines.length, 4)
  assert.equal(lines.filter((line) => JSON.parse(line).audit === true).length, 3)
})
