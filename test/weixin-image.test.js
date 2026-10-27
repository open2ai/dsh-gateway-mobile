import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Logger } from '../lib/logger.js'
import { SecretBox } from '../lib/store.js'
import { WeixinChannel } from '../lib/weixin.js'

test('WeChat inbound image is downloaded and AES-128-ECB decrypted', async () => {
  const key = crypto.randomBytes(16)
  const plain = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(64)])
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
  let qrPolls = 0
  let delivered = false
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const send = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/ilink/bot/get_bot_qrcode') {
      send({ qrcode: 'qr-image', qrcode_img_content: 'https://weixin.example/qr-image' })
      return
    }
    if (url.pathname === '/ilink/bot/get_qrcode_status') {
      qrPolls += 1
      if (qrPolls < 2) {
        send({ status: 'wait' })
        return
      }
      const address = server.address()
      const baseUrl = address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : 'http://127.0.0.1'
      send({
        status: 'confirmed',
        bot_token: 'token',
        ilink_bot_id: 'bot@im.bot',
        ilink_user_id: 'user@example.test',
        baseurl: baseUrl,
      })
      return
    }
    if (url.pathname === '/download') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(encrypted)
      return
    }
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {}
      if (url.pathname === '/ilink/bot/getupdates') {
        if (delivered) {
          send({ ret: 0, msgs: [], get_updates_buf: 'cursor-2' })
          return
        }
        delivered = true
        send({
          ret: 0,
          get_updates_buf: 'cursor-1',
          msgs: [{
            message_id: 42,
            from_user_id: 'user@example.test',
            message_type: 1,
            context_token: 'ctx-image',
            item_list: [{
              type: 2,
              image_item: {
                media: { encrypt_query_param: 'encrypted-param', aes_key: key.toString('base64') },
                aeskey: key.toString('hex'),
                mid_size: encrypted.length,
              },
            }],
          }],
        })
        return
      }
      send({ ret: 0 })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('server is not listening')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-weixin-image-'))
  const logger = new Logger({ level: 'error' })
  const box = new SecretBox(dir).load()
  let inbound
  const channel = new WeixinChannel({
    dataDir: dir,
    config: { enabled: true, baseUrl, cdnBase: baseUrl, routeTag: '', channelVersion: '1.0.0', requireApproval: true },
    logger,
    box,
    onMessage: (message) => { inbound = message },
  })
  try {
    await channel.beginLogin()
    await channel.pollLogin()
    assert.equal((await channel.pollLogin()).state, 'pending')
    await channel.approveLogin(true)
    const deadline = Date.now() + 3000
    while (!inbound && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(inbound)
    assert.equal(inbound.text, '')
    assert.equal(inbound.images.length, 1)
    assert.equal(inbound.images[0].mediaType, 'image/jpeg')
    assert.equal(inbound.images[0].name.includes('.jpg'), true)
    assert.deepEqual(Buffer.from(inbound.images[0].data, 'base64'), plain)
  } finally {
    channel.stop()
    await new Promise((resolve) => server.close(resolve))
  }
})
