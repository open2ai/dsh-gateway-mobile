import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Logger } from '../lib/logger.js'
import { WeixinNotifier } from '../lib/weixin-notifier.js'

function fakeController(sessions) {
  return {
    create: async () => ({ sessionId: 'unused' }),
    prompt: async () => ({ accepted: true }),
    list: async () => ({ items: sessions }),
    follow: async function* (request) {
      yield { type: 'snapshot', cursor: 0, records: [] }
      yield {
        type: 'event',
        event: { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: `done ${request.address.sessionId}` }] } } },
      }
      yield { type: 'event', event: { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'completed' } } }
    },
  }
}

test('notifier applies and persists runtime policy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-notifier-policy-'))
  const logger = new Logger({ level: 'error' })
  const channel = { connected: true, lastInbound: undefined, sendText: async () => {} }
  const options = {
    channel,
    controller: fakeController([]),
    logger,
    dataDir: dir,
    config: { enabled: true, debounceMs: 5000, perSessionIntervalMs: 30000, globalIntervalMs: 10000, maxPerHour: 20 },
  }
  const notifier = new WeixinNotifier(options)
  try {
    const updated = await notifier.setPolicy({
      debounceMs: 8000,
      perSessionIntervalMs: 60000,
      globalIntervalMs: 15000,
      maxPerHour: 40,
    })
    assert.equal(updated.debounceMs, 8000)
    assert.equal(updated.perSessionIntervalMs, 60000)
    assert.equal(updated.globalIntervalMs, 15000)
    assert.equal(updated.maxPerHour, 40)

    const reloaded = new WeixinNotifier(options)
    try {
      await reloaded.start()
      const restored = reloaded.status()
      assert.equal(restored.debounceMs, 8000)
      assert.equal(restored.perSessionIntervalMs, 60000)
      assert.equal(restored.globalIntervalMs, 15000)
      assert.equal(restored.maxPerHour, 40)
    } finally {
      reloaded.stop()
    }
  } finally {
    notifier.stop()
  }
})

test('notifier merges completed sessions into one WeChat message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-notifier-'))
  const logger = new Logger({ level: 'error' })
  const sent = []
  const channel = {
    connected: true,
    lastInbound: { userId: 'user@example.test', contextToken: 'ctx', text: 'hi' },
    sendText: async (userId, text, contextToken) => {
      sent.push({ userId, text, contextToken })
    },
  }
  const controller = fakeController([
    { sessionId: 'session-a', cwd: '/workspace/alpha', running: true },
    { sessionId: 'session-b', cwd: '/workspace/beta', running: true },
    { sessionId: 'session-child', cwd: '/workspace/alpha', running: true, parentSessionId: 'session-a' },
    { sessionId: 'session-wechat', cwd: '/workspace/alpha', running: true },
  ])
  const notifier = new WeixinNotifier({
    channel,
    controller,
    logger,
    dataDir: dir,
    config: { enabled: true, debounceMs: 20, perSessionIntervalMs: 1, globalIntervalMs: 1, maxPerHour: 20 },
    excludeSessionId: () => 'session-wechat',
  })
  try {
    await notifier.start()
    const deadline = Date.now() + 3000
    while (sent.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].userId, 'user@example.test')
    assert.match(sent[0].text, /2 个 DSH 任务已完成/)
    assert.match(sent[0].text, /alpha/)
    assert.match(sent[0].text, /beta/)
    assert.doesNotMatch(sent[0].text, /session-child/)
    assert.doesNotMatch(sent[0].text, /session-wechat/)
  } finally {
    notifier.stop()
  }
})
