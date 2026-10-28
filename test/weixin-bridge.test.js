import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Logger } from '../lib/logger.js'
import { WeixinBridge } from '../lib/weixin-bridge.js'

test('WeChat bridge serializes an owner message into a dedicated DSH turn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-bridge-'))
  const logger = new Logger({ level: 'error' })
  const sent = []
  const channel = {
    onMessage: undefined,
    status: () => ({ enabled: true, connected: true, state: 'confirmed', userId: 'user@example.test', cursor: '', received: 0 }),
    sendText: async (userId, text, contextToken) => {
      sent.push({ userId, text, contextToken })
    },
  }
  const controller = {
    create: async () => ({ sessionId: 'session-test' }),
    prompt: async (request) => {
      assert.equal(request.sessionId, 'session-test')
      assert.equal(request.content[0].text, 'hello DSH')
      return { accepted: true }
    },
    follow: async function* () {
      yield { type: 'snapshot', cursor: 0, records: [] }
      yield {
        type: 'event',
        event: { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'hello from DSH' }] } } },
      }
      yield { type: 'event', event: { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'completed' } } }
    },
  }
  const bridge = new WeixinBridge({ channel, controller, logger, dataDir: dir })
  await bridge.start()
  assert.equal(typeof channel.onMessage, 'function')

  channel.onMessage({ userId: 'user@example.test', contextToken: 'ctx-owner', text: 'hello DSH' })

  const deadline = Date.now() + 3000
  while (sent.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  bridge.stop()

  assert.equal(sent.length, 1)
  assert.equal(sent[0].userId, 'user@example.test')
  assert.equal(sent[0].contextToken, 'ctx-owner')
  assert.equal(sent[0].text, 'hello from DSH')
})

test('WeChat bridge forwards an image-only message as a DSH image prompt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-image-'))
  const logger = new Logger({ level: 'error' })
  let promptContent
  const channel = {
    onMessage: undefined,
    status: () => ({ enabled: true, connected: true, state: 'confirmed', userId: 'user@example.test', cursor: '', received: 0 }),
    sendText: async () => {},
  }
  const controller = {
    create: async () => ({ sessionId: 'session-image' }),
    prompt: async (request) => {
      promptContent = request.content
      return { accepted: true }
    },
    follow: async function* () {
      yield { type: 'snapshot', cursor: 0, records: [] }
      yield {
        type: 'event',
        event: { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '图片已收到' }] } } },
      }
      yield { type: 'event', event: { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'completed' } } }
    },
  }
  const bridge = new WeixinBridge({ channel, controller, logger, dataDir: dir })
  await bridge.start()
  channel.onMessage({
    userId: 'user@example.test',
    contextToken: 'ctx-image',
    text: '',
    images: [{ mediaType: 'image/jpeg', data: Buffer.from('fake-jpeg').toString('base64'), name: 'photo.jpg' }],
  })
  const deadline = Date.now() + 3000
  while (!promptContent && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  bridge.stop()
  assert.ok(promptContent)
  assert.equal(promptContent[0].type, 'text')
  assert.equal(promptContent[0].text, '[微信图片]')
  assert.equal(promptContent[1].type, 'image')
  assert.equal(promptContent[1].mediaType, 'image/jpeg')
  assert.equal(promptContent[1].name, 'photo.jpg')
})

test('WeChat bridge forwards a single user question and accepts an option reply', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-question-'))
  fs.writeFileSync(path.join(dir, 'weixin-session.json'), JSON.stringify({ version: 1, sessionId: 'session-question' }))
  const logger = new Logger({ level: 'error' })
  const sent = []
  let questionListener
  const channel = {
    onMessage: undefined,
    status: () => ({ enabled: true, connected: true, state: 'confirmed', userId: 'user@example.test', cursor: '', received: 0 }),
    contextFor: () => 'ctx-question',
    sendText: async (userId, text, contextToken) => {
      sent.push({ userId, text, contextToken })
    },
  }
  const events = {
    on: (name, listener) => {
      if (name === 'user-questions/request') questionListener = listener
      return undefined
    },
    off: () => undefined,
  }
  const bridge = new WeixinBridge({ channel, events, logger, dataDir: dir })
  await bridge.start()
  assert.equal(typeof questionListener, 'function')

  channel.onMessage({ userId: 'user@example.test', contextToken: 'ctx-question', text: 'trigger' })
  await new Promise((resolve) => setTimeout(resolve, 20))

  const answer = questionListener(
    {
      agent: { id: 'session-question' },
      questions: [{
        id: 'q1',
        question: '选择发布方式',
        options: [{ label: '立即发布' }, { label: '稍后发布' }],
      }],
    },
    async () => ({ answers: [] }),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  const prompt = sent.find((entry) => entry.text.includes('需要回答'))
  assert.ok(prompt)
  assert.match(prompt.text, /立即发布/)
  channel.onMessage({ userId: 'user@example.test', contextToken: 'ctx-question', text: '2' })
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['稍后发布'] }] })
  bridge.stop()
})

test('WeChat bridge answers a multi-question batch with multi-select', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-question-batch-'))
  fs.writeFileSync(path.join(dir, 'weixin-session.json'), JSON.stringify({ version: 1, sessionId: 'session-question' }))
  const logger = new Logger({ level: 'error' })
  const sent = []
  let questionListener
  const channel = {
    onMessage: undefined,
    status: () => ({ enabled: true, connected: true, state: 'confirmed', userId: 'user@example.test', cursor: '', received: 0 }),
    contextFor: () => 'ctx-question',
    sendText: async (userId, text, contextToken) => {
      sent.push({ userId, text, contextToken })
    },
  }
  const events = {
    on: (name, listener) => {
      if (name === 'user-questions/request') questionListener = listener
      return undefined
    },
    off: () => undefined,
  }
  const bridge = new WeixinBridge({ channel, events, logger, dataDir: dir })
  await bridge.start()
  channel.onMessage({ userId: 'user@example.test', contextToken: 'ctx-question', text: 'trigger' })
  await new Promise((resolve) => setTimeout(resolve, 20))

  const answer = questionListener(
    {
      agent: { id: 'session-question' },
      questions: [
        { id: 'q1', question: '选择组件', multiSelect: true, options: [{ label: '前端' }, { label: '后端' }, { label: '文档' }] },
        { id: 'q2', question: '备注' },
      ],
    },
    async () => ({ answers: [] }),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.match(sent.find((entry) => entry.text.includes('选择组件'))?.text ?? '', /可多选/)
  channel.onMessage({ userId: 'user@example.test', contextToken: 'ctx-question', text: '1,3' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  channel.onMessage({ userId: 'user@example.test', contextToken: 'ctx-question', text: '今晚发布' })
  assert.deepEqual(await answer, {
    answers: [
      { id: 'q1', selected: ['前端', '文档'] },
      { id: 'q2', selected: [], custom: '今晚发布' },
    ],
  })
  bridge.stop()
})

test('WeChat bridge submits a timed question answer after the foreground wait', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-question-timed-'))
  fs.writeFileSync(path.join(dir, 'weixin-session.json'), JSON.stringify({ version: 1, sessionId: 'session-question' }))
  const logger = new Logger({ level: 'error' })
  const sent = []
  const late = []
  let questionListener
  const channel = {
    onMessage: undefined,
    status: () => ({ enabled: true, connected: true, state: 'confirmed', userId: 'user@example.test', cursor: '', received: 0 }),
    contextFor: () => 'ctx-question',
    sendText: async (userId, text, contextToken) => {
      sent.push({ userId, text, contextToken })
    },
  }
  const events = {
    on: (name, listener) => {
      if (name === 'user-questions/request') questionListener = listener
      return undefined
    },
    off: () => undefined,
  }
  const bridge = new WeixinBridge({
    channel,
    events,
    logger,
    dataDir: dir,
    lateAnswer: async (agent, callId, answer) => {
      late.push({ agent, callId, answer })
      return true
    },
  })
  await bridge.start()
  channel.onMessage({ userId: 'user@example.test', contextToken: 'ctx-question', text: 'trigger' })
  await new Promise((resolve) => setTimeout(resolve, 20))

  const abort = new AbortController()
  const answer = questionListener(
    {
      agent: { id: 'session-question' },
      signal: abort.signal,
      wait: { callId: 'call-timed', timed: true },
      questions: [{ id: 'q1', question: '继续吗', options: [{ label: '继续' }, { label: '停止' }] }],
    },
    async () => ({ answers: [] }),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  abort.abort()
  await answer.catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  channel.onMessage({ userId: 'user@example.test', contextToken: 'ctx-question', text: '2' })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(late[0]?.answer, { answers: [{ id: 'q1', selected: ['停止'] }] })
  assert.equal(late[0]?.callId, 'call-timed')
  bridge.stop()
})

test('WeChat bridge forwards a DSH approval and accepts an owner decision', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-approval-'))
  fs.writeFileSync(path.join(dir, 'weixin-session.json'), JSON.stringify({ version: 1, sessionId: 'session-approval' }))
  const logger = new Logger({ level: 'error' })
  const sent = []
  let approvalListener
  const channel = {
    onMessage: undefined,
    status: () => ({ enabled: true, connected: true, state: 'confirmed', userId: 'user@example.test', cursor: '', received: 0 }),
    contextFor: () => 'ctx-approval',
    sendText: async (userId, text, contextToken) => {
      sent.push({ userId, text, contextToken })
    },
  }
  const events = {
    on: (name, listener) => {
      if (name === 'approval/request') approvalListener = listener
      return undefined
    },
    off: () => undefined,
  }
  const bridge = new WeixinBridge({ channel, events, logger, dataDir: dir })
  await bridge.start()
  assert.equal(typeof approvalListener, 'function')

  channel.onMessage({ userId: 'user@example.test', contextToken: 'ctx-approval', text: 'trigger' })
  await new Promise((resolve) => setTimeout(resolve, 20))

  const outcome = approvalListener(
    { agent: { id: 'session-approval' }, toolName: 'Bash', reason: 'run tests' },
    async () => 'unavailable',
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  const prompt = sent.find((entry) => entry.text.includes('需要审批'))
  assert.ok(prompt)
  assert.match(prompt.text, /Y 允许/)
  const handled = channel.onMessage({ userId: 'user@example.test', contextToken: 'ctx-approval', text: 'Y' })
  assert.equal(handled, undefined)
  assert.equal(await outcome, 'allowed-once')
  bridge.stop()
})


