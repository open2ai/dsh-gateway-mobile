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
