import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Logger } from '../lib/logger.js'
import { SecretBox } from '../lib/store.js'
import { WeixinChannel } from '../lib/weixin.js'

function startFakeIlink() {
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
      } else if (qrPolls === 2) {
        send({ status: 'scaned' })
      } else {
        const address = server.address()
        const baseUrl = address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : 'http://127.0.0.1'
        send({
          status: 'confirmed',
          bot_token: 'bot-token',
          ilink_bot_id: 'bot@im.bot',
          ilink_user_id: 'user@example.test',
          baseurl: baseUrl,
        })
      }
      return
    }
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null
      seen.push({ path: url.pathname, headers: req.headers, body: parsed })
      if (url.pathname === '/ilink/bot/getupdates') {
        send({ ret: 0, msgs: [], get_updates_buf: 'cursor-1' })
      } else if (url.pathname === '/ilink/bot/sendmessage') {
        send({ ret: 0 })
      } else {
        send({ ret: 0 })
      }
    })
  })
  return {
    server,
    seen,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
    url: () => {
      const address = server.address()
      if (!address || typeof address !== 'object') throw new Error('fake server is not listening')
      return `http://127.0.0.1:${address.port}`
    },
  }
}

test('WeChat QR login persists credentials and sends text with context_token', async () => {
  const fake = startFakeIlink()
  await fake.listen()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-weixin-'))
  const logger = new Logger({ level: 'error' })
  const box = new SecretBox(dir).load()
  const channel = new WeixinChannel({
    dataDir: dir,
    config: {
      enabled: true,
      baseUrl: fake.url(),
      cdnBase: fake.url(),
      routeTag: '',
      channelVersion: '1.0.0',
      requireApproval: true,
    },
    logger,
    box,
  })
  try {
    const login = await channel.beginLogin()
    assert.equal(login.state, 'wait')
    assert.equal(login.qrcode, 'qr-test')
    assert.ok(login.qrSvg?.includes('<svg'))

    const wait = await channel.pollLogin()
    assert.equal(wait.state, 'wait')
    const scaned = await channel.pollLogin()
    assert.equal(scaned.state, 'scaned')

    // The third poll confirms the scan but waits for local admin approval.
    const pending = await channel.pollLogin()
    assert.equal(pending.state, 'pending')
    assert.ok(pending.pendingUserId?.includes('@example.test'))
    assert.equal(fs.existsSync(path.join(dir, 'weixin-bot.json')), false)
    const confirmed = await channel.approveLogin(true)
    assert.equal(confirmed.state, 'confirmed')
    assert.equal(confirmed.connected, true)
    assert.equal(confirmed.accountId, 'bot@im.bot')
    assert.equal(fs.existsSync(path.join(dir, 'weixin-bot.json')), true)

    await channel.sendText('user@example.test', 'hello', 'ctx-1')
    const sent = fake.seen.find((entry) => entry.path === '/ilink/bot/sendmessage')
    assert.ok(sent)
    assert.equal(sent.body.msg.context_token, 'ctx-1')
    assert.equal(sent.body.msg.to_user_id, 'user@example.test')
    assert.equal(sent.body.msg.item_list[0].text_item.text, 'hello')
    assert.match(String(sent.headers.authorization), /^Bearer /)

    await channel.logout()
    assert.equal(channel.connected, false)
    assert.equal(fs.existsSync(path.join(dir, 'weixin-bot.json')), false)
  } finally {
    channel.stop()
    await new Promise((resolve) => fake.server.close(resolve))
  }
})
