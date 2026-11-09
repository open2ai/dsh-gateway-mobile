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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-audit-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}))
  return { dir, file: path.join(dir, 'gateway.log') }
}

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

test('logger: a new instance reads audit entries written by a previous instance', async (t) => {
  const { file } = await tempLogFile(t)
  const first = new Logger({ level: 'error', file })
  first.audit({ action: 'pairing.success', deviceId: 'device-1' })
  first.audit({ action: 'device.logout', deviceId: 'device-1' })
  await first.flush()

  const second = new Logger({ level: 'error', file })
  const result = await second.queryAudit()

  assert.equal(result.total, 2)
  assert.equal(result.entries.length, 2)
  assert.deepEqual(
    result.entries.map((entry) => entry.message),
    ['pairing.success', 'device.logout'],
  )
  assert.equal(result.entries[0].action, 'pairing.success')
})

test('logger: queryAudit reads rotated .1..N files after a restart', async (t) => {
  const { file } = await tempLogFile(t)
  const first = new Logger({ level: 'error', file, maxBytes: 400, maxFiles: 3 })
  for (let index = 0; index < 40; index += 1) first.audit({ action: 'batch.event', seq: index })
  await first.flush()

  assert.equal(fs.existsSync(`${file}.1`), true)
  const rotated = readJsonl(`${file}.1`).find((entry) => entry.audit === true)
  assert.ok(rotated, 'expected an audit entry in the rotated file')

  const second = new Logger({ level: 'error', file, maxBytes: 400, maxFiles: 3 })
  const result = await second.queryAudit({ action: 'batch.event' })

  assert.ok(result.total > 0)
  assert.ok(
    result.entries.some((entry) => entry.timestamp === rotated.timestamp && entry.message === rotated.message),
    'expected an entry that only exists in the rotated file',
  )
  const times = result.entries.map((entry) => Date.parse(entry.timestamp))
  assert.deepEqual(times, [...times].sort((left, right) => left - right), 'entries are ascending')
})

test('logger: cross-file query filters by action and since; total ignores limit', async (t) => {
  const { file } = await tempLogFile(t)
  const first = new Logger({ level: 'error', file })
  // Distinct milliseconds: the dedupe key is timestamp+message+meta, so three
  // identical messages written in the same tick would merge by design.
  first.audit({ action: 'alpha.event', seq: 1 })
  await sleep(3)
  first.audit({ action: 'alpha.event', seq: 2 })
  await sleep(3)
  first.audit({ action: 'alpha.event', seq: 3 })
  await sleep(25)
  const betaStart = Date.now()
  first.audit({ action: 'beta.event', seq: 4 })
  await sleep(3)
  first.audit({ action: 'beta.event', seq: 5 })
  await first.flush()

  const second = new Logger({ level: 'error', file })

  const alpha = await second.queryAudit({ action: 'alpha.event' })
  assert.equal(alpha.total, 3)
  assert.equal(alpha.entries.length, 3)
  assert.ok(alpha.entries.every((entry) => entry.message === 'alpha.event'))

  const since = await second.queryAudit({ since: betaStart })
  assert.equal(since.total, 2)
  assert.ok(since.entries.every((entry) => entry.message === 'beta.event'))

  const limited = await second.queryAudit({ action: 'alpha.event', limit: 1 })
  assert.equal(limited.total, 3)
  assert.equal(limited.entries.length, 1)
  assert.equal(limited.entries[0].seq, 3, 'limit keeps the most recent matches')
})

test('logger: malformed JSONL lines are ignored', async (t) => {
  const { file } = await tempLogFile(t)
  const first = new Logger({ level: 'error', file })
  first.audit({ action: 'valid.event', seq: 1 })
  await first.flush()

  fs.appendFileSync(file, 'not json\n{"timestamp":42}\n{"level":"audit"}\n[]\n\n', 'utf8')

  const second = new Logger({ level: 'error', file })
  const result = await second.queryAudit()
  assert.equal(result.total, 1)
  assert.equal(result.entries[0].message, 'valid.event')
})

test('logger: on-disk and in-memory copies are deduplicated', async (t) => {
  const { file } = await tempLogFile(t)
  const logger = new Logger({ level: 'error', file })
  logger.audit({ action: 'dup.event', seq: 1 })

  assert.equal((await logger.queryAudit()).total, 1)
  assert.equal((await logger.queryAudit()).total, 1)
})

test('logger: setLevel validates and updates the runtime level', () => {
  const logger = new Logger({ level: 'info' })
  assert.throws(() => logger.setLevel('verbose'), TypeError)
  assert.throws(() => logger.setLevel('audit'), TypeError)
  logger.setLevel('ERROR')
  assert.equal(logger.enabled('warn'), false)
  assert.equal(logger.enabled('error'), true)
  logger.setLevel('debug')
  assert.equal(logger.enabled('debug'), true)
})
