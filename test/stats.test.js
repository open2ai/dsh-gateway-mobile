import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { StatsStore } from '../lib/stats.js'

test('stats: records per-day and per-device counts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-stats-'))
  const stats = new StatsStore({ dataDir: dir })
  stats.record('dev_a')
  stats.record('dev_a')
  stats.record('dev_b')
  const summary = stats.summary(7)
  assert.equal(summary.todayRequests, 3)
  assert.equal(summary.totalRequests, 3)
  assert.equal(summary.byDevice.dev_a, 2)
  assert.equal(summary.byDevice.dev_b, 1)
  assert.equal(summary.topDevices[0].deviceId, 'dev_a')
  assert.ok(summary.daily.length === 7)
})

test('stats: reloads counters from disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-stats-'))
  const first = new StatsStore({ dataDir: dir })
  first.record('dev_a')
  await first.file.save()
  const second = new StatsStore({ dataDir: dir })
  assert.equal(second.summary(7).totalRequests, 1)
})
