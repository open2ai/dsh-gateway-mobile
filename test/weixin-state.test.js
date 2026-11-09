import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CODES, GatewayError } from '../lib/errors.js'
import { Logger } from '../lib/logger.js'
import { SecretBox } from '../lib/store.js'
import { WeixinBridge } from '../lib/weixin-bridge.js'
import { WeixinChannel, ownerHash, weixinSendFailureReason } from '../lib/weixin.js'
import { WeixinNotifier } from '../lib/weixin-notifier.js'

const OWNER = 'owner@example.test'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(20)
  }
  return predicate()
}

/**
 * Minimal iLink fake. `handlers` lets each test swap getupdates/sendmessage
 * responses; return `{ body }` or `{ httpStatus, body }`.
 */
function startFakeIlink(handlers = {}) {
  const state = {
    getUpdates: handlers.getUpdates ?? (() => ({ body: { ret: 0, msgs: [], get_updates_buf: 'cursor' } })),
    sendMessage: handlers.sendMessage ?? (() => ({ body: { ret: 0 } })),
    seen: [],
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const respond = (result) => {
      res.writeHead(result.httpStatus ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result.body ?? {}))
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      state.seen.push({ path: url.pathname, body: body ? JSON.parse(body) : null })
      if (url.pathname === '/ilink/bot/getupdates') {
        respond(state.getUpdates())
        return
      }
      if (url.pathname === '/ilink/bot/sendmessage') {
        respond(state.sendMessage())
        return
      }
      respond({ body: { ret: 0 } })
    })
  })
  return {
    server,
    state,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
    url: () => {
      const address = server.address()
      if (!address || typeof address !== 'object') throw new Error('fake server is not listening')
      return `http://127.0.0.1:${address.port}`
    },
  }
}

function channelFor(dir, fake, logger, box, overrides = {}) {
  return new WeixinChannel({
    dataDir: dir,
    config: {
      enabled: true,
      baseUrl: fake.url(),
      cdnBase: fake.url(),
      routeTag: '',
      channelVersion: '1.0.0',
      requireApproval: true,
      allowOtherUsers: false,
      allowedUsers: [],
      ...overrides,
    },
    logger,
    box,
  })
}

function writeCredentials(dir, box, fake) {
  const payload = box.encrypt({
    token: 'bot-token',
    baseUrl: fake.url(),
    accountId: 'bot@im.bot',
    savedAt: new Date().toISOString(),
    ownerHash: ownerHash(OWNER),
    ownerMasked: 'own***@example.test',
    ownerBoundAt: Date.now(),
  })
  fs.writeFileSync(path.join(dir, 'weixin-bot.json'), JSON.stringify({ version: 1, payload }))
}

test('a single -14 degrades but only the second consecutive -14 expires the session', async () => {
  const fake = startFakeIlink({ getUpdates: () => ({ body: { ret: -14 } }) })
  await fake.listen()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-wx-expired-'))
  const logger = new Logger({ level: 'error' })
  const box = new SecretBox(dir).load()
  writeCredentials(dir, box, fake)
  const channel = channelFor(dir, fake, logger, box)
  try {
    await channel.start()
    assert.equal(await waitFor(() => channel.status().failures >= 1), true)
    const degraded = channel.status()
    assert.equal(degraded.state, 'degraded')
    assert.equal(degraded.connected, true)
    assert.equal(fs.existsSync(path.join(dir, 'weixin-bot.json')), true)
    assert.match(degraded.lastError ?? '', /微信会话已过期/)

    assert.equal(await waitFor(() => channel.status().state === 'expired'), true)
    const expired = channel.status()
    assert.equal(expired.connected, false)
    assert.equal(expired.owner, undefined)
    assert.match(expired.lastError ?? '', /微信会话已过期/)
    assert.equal(fs.existsSync(path.join(dir, 'weixin-bot.json')), false)
    assert.deepEqual(channel.ownerContext(), undefined)
  } finally {
    channel.stop()
    await new Promise((resolve) => fake.server.close(resolve))
  }
})

test('owner contexts expire after 30 minutes and status reports their age', async () => {
  let delivered = false
  const fake = startFakeIlink({
    getUpdates: () => {
      if (delivered) return { body: { ret: 0, msgs: [], get_updates_buf: 'cursor' } }
      delivered = true
      return {
        body: {
          ret: 0,
          get_updates_buf: 'cursor',
          msgs: [
            {
              message_id: 4001,
              from_user_id: OWNER,
              context_token: 'ctx-owner',
              item_list: [{ type: 1, text_item: { text: 'hello' } }],
            },
          ],
        },
      }
    },
  })
  await fake.listen()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-wx-ttl-'))
  const logger = new Logger({ level: 'error' })
  const box = new SecretBox(dir).load()
  writeCredentials(dir, box, fake)
  const channel = channelFor(dir, fake, logger, box)
  const received = []
  channel.onMessage = (message) => received.push(message)
  const realNow = Date.now
  try {
    await channel.start()
    assert.equal(await waitFor(() => received.length === 1), true)
    assert.equal(channel.lastInbound?.userId, OWNER)
    assert.equal(channel.contextFor(OWNER), 'ctx-owner')
    assert.deepEqual(channel.ownerContext(), { userId: OWNER, token: 'ctx-owner' })
    const fresh = channel.status()
    assert.ok(fresh.contextAgeMs >= 0 && fresh.contextAgeMs < 30 * 60_000)

    Date.now = () => realNow() + 30 * 60_000 + 1
    assert.equal(channel.contextFor(OWNER), undefined)
    assert.equal(channel.ownerContext(), undefined)
    assert.ok(channel.status().contextAgeMs > 30 * 60_000)
  } finally {
    channel.stop()
    Date.now = realNow
    await new Promise((resolve) => fake.server.close(resolve))
  }
})

test('sendText failures carry a classified reason', async () => {
  const fake = startFakeIlink()
  await fake.listen()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-wx-fail-'))
  const logger = new Logger({ level: 'error' })
  const box = new SecretBox(dir).load()
  writeCredentials(dir, box, fake)
  const channel = channelFor(dir, fake, logger, box)
  try {
    await channel.start()

    fake.state.sendMessage = () => ({ body: { ret: -14 } })
    await assert.rejects(channel.sendText(OWNER, 'hello', 'ctx-owner'), (error) => {
      assert.equal(error.code, CODES.PROXY_ERROR)
      assert.equal(weixinSendFailureReason(error), 'auth-expired')
      return true
    })

    fake.state.sendMessage = () => ({ httpStatus: 429, body: { ret: 429 } })
    await assert.rejects(channel.sendText(OWNER, 'hello', 'ctx-owner'), (error) => {
      assert.equal(weixinSendFailureReason(error), 'rate-limited')
      return true
    })

    fake.state.sendMessage = () => ({ httpStatus: 401, body: { ret: -14 } })
    await assert.rejects(channel.sendText(OWNER, 'hello', 'ctx-owner'), (error) => {
      assert.equal(weixinSendFailureReason(error), 'auth-expired')
      return true
    })

    assert.equal(weixinSendFailureReason(new TypeError('fetch failed')), 'network')
    assert.equal(weixinSendFailureReason(new GatewayError(CODES.PROXY_ERROR, { reason: 'network' })), 'network')
    assert.equal(weixinSendFailureReason(new GatewayError(CODES.PROXY_ERROR, { reason: 'unknown' })), 'unknown')
    assert.equal(weixinSendFailureReason(new Error('boom')), 'unknown')
  } finally {
    channel.stop()
    await new Promise((resolve) => fake.server.close(resolve))
  }
})

test('bridge deduplicates redelivered message ids and rejects bare replies without pending work', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-wx-dedupe-'))
  const logger = new Logger({ level: 'error' })
  const sent = []
  let prompts = 0
  const channel = {
    onMessage: undefined,
    status: () => ({ enabled: true, connected: true, state: 'connected', cursor: '', received: 0 }),
    sendText: async (userId, text, contextToken) => {
      sent.push({ userId, text, contextToken })
    },
  }
  const controller = {
    create: async () => ({ sessionId: 'session-dedupe' }),
    prompt: async () => {
      prompts += 1
      return { accepted: true }
    },
    follow: async function* () {
      yield { type: 'snapshot', cursor: 0, records: [] }
      yield { type: 'event', event: { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'completed' } } }
    },
  }
  const bridge = new WeixinBridge({ channel, controller, logger, dataDir: dir })
  try {
    await bridge.start()
    const message = { userId: OWNER, contextToken: 'ctx-owner', text: 'hello', messageId: 500 }
    channel.onMessage(message)
    channel.onMessage({ ...message })
    assert.equal(await waitFor(() => prompts === 1, 3000), true)
    await sleep(150)
    assert.equal(prompts, 1)

    channel.onMessage({ userId: OWNER, contextToken: 'ctx-owner', text: 'Y', messageId: 501 })
    await sleep(100)
    assert.equal(prompts, 1)
    const last = sent.at(-1)
    assert.equal(last?.text, '当前没有待处理的审批或提问。')
    assert.equal(last?.userId, OWNER)
  } finally {
    bridge.stop()
  }
})

function fakeController(sessions) {  return {
    create: async () => ({ sessionId: 'unused' }),
    prompt: async () => ({ accepted: true }),
    list: async () => ({ items: sessions }),
    follow: async function* (request) {
      yield { type: 'snapshot', cursor: 0, records: [] }
      yield {
        type: 'event',
        event: {
          type: 'assistant/message',
          seq: 1,
          data: { message: { content: [{ type: 'text', text: `done ${request.address.sessionId}` }] } },
        },
      }
      yield { type: 'event', event: { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'completed' } } }
    },
  }
}

test('notifier sends to channel.ownerContext() even without lastInbound', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-wx-notify-owner-'))
  const logger = new Logger({ level: 'error' })
  const sent = []
  const channel = {
    connected: true,
    lastInbound: undefined,
    ownerContext: () => ({ userId: OWNER, token: 'ctx-owner' }),
    sendText: async (userId, text, contextToken) => {
      sent.push({ userId, text, contextToken })
    },
  }
  const notifier = new WeixinNotifier({
    channel,
    controller: fakeController([{ sessionId: 'session-owner', cwd: '/workspace/alpha', running: true }]),
    logger,
    dataDir: dir,
    config: { enabled: true, debounceMs: 20, perSessionIntervalMs: 1, globalIntervalMs: 1, maxPerHour: 20 },
  })
  try {
    await notifier.start()
    const deadline = Date.now() + 3000
    while (sent.length === 0 && Date.now() < deadline) await sleep(20)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].userId, OWNER)
    assert.equal(sent[0].contextToken, 'ctx-owner')
    assert.match(sent[0].text, /DSH 任务完成/)
    assert.equal(notifier.status().permanentFailureCount, 0)
  } finally {
    notifier.stop()
  }
})

test('notifier counts auth-expired failures as permanent and stops retrying', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-wx-notify-perm-'))
  const logger = new Logger({ level: 'error' })
  let attempts = 0
  const channel = {
    connected: true,
    lastInbound: undefined,
    ownerContext: () => ({ userId: OWNER, token: 'ctx-expired' }),
    sendText: async () => {
      attempts += 1
      throw new GatewayError(CODES.PROXY_ERROR, { reason: 'auth-expired' }, 502, 'WeChat session expired')
    },
  }
  const notifier = new WeixinNotifier({
    channel,
    controller: fakeController([{ sessionId: 'session-perm', cwd: '/workspace/beta', running: true }]),
    logger,
    dataDir: dir,
    config: { enabled: true, debounceMs: 20, perSessionIntervalMs: 1, globalIntervalMs: 1, maxPerHour: 20 },
  })
  try {
    await notifier.start()
    assert.equal(await waitFor(() => notifier.status().permanentFailureCount >= 1, 3000), true)
    const status = notifier.status()
    assert.equal(status.lastFailure?.reason, 'auth-expired')
    assert.match(status.lastFailure?.message ?? '', /expired/)
    const attemptsAtFailure = attempts
    await sleep(400)
    assert.equal(attempts, attemptsAtFailure)
  } finally {
    notifier.stop()
  }
})
