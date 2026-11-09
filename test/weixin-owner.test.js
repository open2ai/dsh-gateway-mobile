import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Logger } from '../lib/logger.js'
import { SecretBox } from '../lib/store.js'
import { WeixinChannel, ownerHash } from '../lib/weixin.js'

const OWNER = 'owner@example.test'
const STRANGER = 'stranger@example.test'
const ALLOWED = 'allowed@example.test'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(20)
  }
  return predicate()
}

function startFakeIlink() {
  const queue = []
  const seen = []
  let qrPolls = 0
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const send = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/ilink/bot/get_bot_qrcode') {
      send({ qrcode: 'qr-test', qrcode_img_content: 'https://weixin.example/qr-test' })
      return
    }
    if (url.pathname === '/ilink/bot/get_qrcode_status') {
      qrPolls += 1
      if (qrPolls === 1) {
        send({ status: 'wait' })
        return
      }
      if (qrPolls === 2) {
        send({ status: 'scaned' })
        return
      }
      const address = server.address()
      const baseUrl = address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : 'http://127.0.0.1'
      send({
        status: 'confirmed',
        bot_token: 'bot-token',
        ilink_bot_id: 'bot@im.bot',
        ilink_user_id: OWNER,
        baseurl: baseUrl,
      })
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null
      seen.push({ path: url.pathname, body: parsed })
      if (url.pathname === '/ilink/bot/getupdates') {
        const msgs = queue.splice(0, queue.length)
        send({ ret: 0, msgs, get_updates_buf: `cursor-${seen.length}` })
        return
      }
      send({ ret: 0 })
    })
  })
  return {
    server,
    queue,
    seen,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
    url: () => {
      const address = server.address()
      if (!address || typeof address !== 'object') throw new Error('fake server is not listening')
      return `http://127.0.0.1:${address.port}`
    },
  }
}

function channelConfig(fake, overrides = {}) {
  return {
    enabled: true,
    baseUrl: fake.url(),
    cdnBase: fake.url(),
    routeTag: '',
    channelVersion: '1.0.0',
    requireApproval: true,
    allowOtherUsers: false,
    allowedUsers: [],
    ...overrides,
  }
}

function writeCredentials(dir, box, overrides = {}) {
  const payload = box.encrypt({
    token: 'bot-token',
    baseUrl: overrides.baseUrl,
    accountId: 'bot@im.bot',
    savedAt: new Date().toISOString(),
    ...overrides,
  })
  fs.writeFileSync(path.join(dir, 'weixin-bot.json'), JSON.stringify({ version: 1, payload }))
}

function readCredentials(dir, box) {
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'weixin-bot.json'), 'utf8'))
  return { raw: JSON.stringify(stored), value: box.decrypt(stored.payload) }
}

test('WeChat login persists only the owner hash and rejects unauthorized users', async () => {
  const fake = startFakeIlink()
  await fake.listen()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-wx-owner-'))
  const logger = new Logger({ level: 'error' })
  const box = new SecretBox(dir).load()
  const channel = new WeixinChannel({
    dataDir: dir,
    config: channelConfig(fake),
    logger,
    box,
  })
  const received = []
  try {
    await channel.beginLogin()
    await channel.pollLogin()
    await channel.pollLogin()
    const pending = await channel.pollLogin()
    assert.equal(pending.state, 'pending')
    await channel.approveLogin(true)

    const status = channel.status()
    assert.equal(status.state, 'connected')
    assert.equal(status.owner?.masked, 'own***@example.test')
    assert.ok((status.owner?.boundAt ?? 0) > 0)
    assert.equal(status.allowOtherUsers, false)

    const stored = readCredentials(dir, box)
    assert.equal(stored.raw.includes(OWNER), false)
    assert.equal(stored.value.ownerHash, ownerHash(OWNER))
    assert.equal(stored.value.ownerMasked, 'own***@example.test')
    assert.equal(stored.value.ownerBoundAt, status.owner.boundAt)
    assert.equal(Object.hasOwn(stored.value, 'userId'), false)

    channel.onMessage = (message) => received.push(message)
    fake.queue.push({
      message_id: 1001,
      from_user_id: STRANGER,
      context_token: 'ctx-stranger',
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    })
    const rejected = await waitFor(() =>
      fake.seen.some((entry) => entry.path === '/ilink/bot/sendmessage' && entry.body.msg.to_user_id === STRANGER),
    )
    assert.equal(rejected, true)
    assert.equal(received.length, 0)
    const audit = logger.auditEntries.find((entry) => entry.message === 'weixin.message.rejected')
    assert.ok(audit)
    assert.equal(audit.maskedUserId, 'str***@example.test')

    fake.queue.push({
      message_id: 1002,
      from_user_id: OWNER,
      context_token: 'ctx-owner',
      item_list: [{ type: 1, text_item: { text: 'hello from owner' } }],
    })
    assert.equal(await waitFor(() => received.length === 1), true)
    assert.equal(received[0].userId, OWNER)
    assert.equal(received[0].contextToken, 'ctx-owner')
    assert.equal(channel.contextFor(OWNER), 'ctx-owner')
    assert.deepEqual(channel.ownerContext(), { userId: OWNER, token: 'ctx-owner' })
    assert.equal(channel.isOwner(OWNER), true)
    assert.equal(channel.isAuthorized(STRANGER), false)
  } finally {
    channel.stop()
    await new Promise((resolve) => fake.server.close(resolve))
  }
})

test('legacy credentials migrate the first sender to owner without storing the raw id', async () => {
  const fake = startFakeIlink()
  await fake.listen()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-wx-legacy-'))
  const logger = new Logger({ level: 'error' })
  const box = new SecretBox(dir).load()
  writeCredentials(dir, box, { baseUrl: fake.url() })
  const channel = new WeixinChannel({
    dataDir: dir,
    config: channelConfig(fake),
    logger,
    box,
  })
  const received = []
  channel.onMessage = (message) => received.push(message)
  try {
    await channel.start()
    assert.equal(channel.status().state, 'connecting')
    assert.equal(channel.status().owner, undefined)
    assert.equal(channel.connected, true)

    fake.queue.push({
      message_id: 2001,
      from_user_id: STRANGER,
      context_token: 'ctx-legacy',
      item_list: [{ type: 1, text_item: { text: 'first message' } }],
    })
    assert.equal(await waitFor(() => received.length === 1), true)
    assert.equal(received[0].userId, STRANGER)
    assert.equal(channel.status().state, 'connected')
    assert.equal(channel.isOwner(STRANGER), true)
    assert.ok(logger.auditEntries.some((entry) => entry.message === 'weixin.owner.migrated'))

    const stored = readCredentials(dir, box)
    assert.equal(stored.raw.includes(STRANGER), false)
    assert.equal(stored.value.ownerHash, ownerHash(STRANGER))
    assert.equal(stored.value.ownerMasked, 'str***@example.test')
  } finally {
    channel.stop()
    await new Promise((resolve) => fake.server.close(resolve))
  }
})

test('allowOtherUsers and allowedUsers authorize non-owner senders', async () => {
  const fake = startFakeIlink()
  await fake.listen()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-wx-allow-'))
  const logger = new Logger({ level: 'error' })
  const box = new SecretBox(dir).load()
  writeCredentials(dir, box, {
    baseUrl: fake.url(),
    ownerHash: ownerHash(OWNER),
    ownerMasked: 'own***@example.test',
    ownerBoundAt: Date.now(),
  })
  const channel = new WeixinChannel({
    dataDir: dir,
    config: channelConfig(fake, { allowOtherUsers: true }),
    logger,
    box,
  })
  const received = []
  channel.onMessage = (message) => received.push(message)
  try {
    await channel.start()
    assert.equal(channel.status().allowOtherUsers, true)
    fake.queue.push({
      message_id: 3001,
      from_user_id: ALLOWED,
      context_token: 'ctx-allowed',
      item_list: [{ type: 1, text_item: { text: 'other user' } }],
    })
    assert.equal(await waitFor(() => received.length === 1), true)
    assert.equal(received[0].userId, ALLOWED)
    assert.equal(channel.isOwner(ALLOWED), false)
    assert.equal(channel.isAuthorized(ALLOWED), true)
  } finally {
    channel.stop()
    await new Promise((resolve) => fake.server.close(resolve))
  }

  const fake2 = startFakeIlink()
  await fake2.listen()
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-wx-list-'))
  const logger2 = new Logger({ level: 'error' })
  const box2 = new SecretBox(dir2).load()
  writeCredentials(dir2, box2, {
    baseUrl: fake2.url(),
    ownerHash: ownerHash(OWNER),
    ownerMasked: 'own***@example.test',
    ownerBoundAt: Date.now(),
  })
  const channel2 = new WeixinChannel({
    dataDir: dir2,
    config: channelConfig(fake2, { allowedUsers: [ownerHash(ALLOWED)] }),
    logger: logger2,
    box: box2,
  })
  const received2 = []
  channel2.onMessage = (message) => received2.push(message)
  try {
    await channel2.start()
    fake2.queue.push({
      message_id: 3101,
      from_user_id: ALLOWED,
      context_token: 'ctx-allowed',
      item_list: [{ type: 1, text_item: { text: 'allowed by list' } }],
    })
    assert.equal(await waitFor(() => received2.length === 1), true)
    assert.equal(channel2.isAuthorized(ALLOWED), true)

    fake2.queue.push({
      message_id: 3102,
      from_user_id: STRANGER,
      context_token: 'ctx-stranger',
      item_list: [{ type: 1, text_item: { text: 'not allowed' } }],
    })
    assert.equal(
      await waitFor(() =>
        fake2.seen.some((entry) => entry.path === '/ilink/bot/sendmessage' && entry.body.msg.to_user_id === STRANGER),
      ),
      true,
    )
    assert.equal(received2.length, 1)
    assert.equal(channel2.isAuthorized(STRANGER), false)
  } finally {
    channel2.stop()
    await new Promise((resolve) => fake2.server.close(resolve))
  }
})
