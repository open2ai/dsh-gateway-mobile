import assert from 'node:assert/strict'
import test from 'node:test'
import WebSocket from 'ws'
import { startFakeUpstream, createGateway, pairDevice } from './helpers.js'

function wsUrl(gateway, path) {
  return `ws://127.0.0.1:${gateway.port}${path}`
}

function open(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers })
    socket._queue = []
    socket._waiters = []
    socket.on('message', (data) => {
      const text = data.toString()
      const waiter = socket._waiters.shift()
      if (waiter) waiter(text)
      else socket._queue.push(text)
    })
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('ws open timeout'))
    }, 5000)
    socket.once('open', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function nextMessage(socket) {
  if (socket._queue.length > 0) return Promise.resolve(socket._queue.shift())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws message timeout')), 5000)
    socket._waiters.push((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

test('websocket: proxies the DSH remote mux opaquely', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })
  const { cookie } = await pairDevice(instance.gateway)
  const socket = await open(wsUrl(instance.gateway, '/api/remote.mux'), { cookie })
  socket.send('hello')
  assert.equal(await nextMessage(socket), 'echo:hello')
  socket.close()
})

test('websocket: rejects unauthenticated DSH upgrades', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })
  await assert.rejects(() => open(wsUrl(instance.gateway, '/api/remote.mux')))
})

test('websocket: /mobile/ws control channel works and closes unknown types', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })
  const { cookie } = await pairDevice(instance.gateway)
  const socket = await open(wsUrl(instance.gateway, '/mobile/ws'), { cookie })
  const ready = JSON.parse(await nextMessage(socket))
  assert.equal(ready.type, 'ready')
  assert.equal(ready.payload.protocolVersion, 1)

  socket.send(JSON.stringify({ type: 'ping', id: 'p1' }))
  const pong = JSON.parse(await nextMessage(socket))
  assert.equal(pong.type, 'pong')
  assert.equal(pong.id, 'p1')

  const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)))
  socket.send(JSON.stringify({ type: 'unknown.type' }))
  assert.equal(await closed, 4003)
})

test('websocket: /mobile/ws rate-limits message floods', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })
  const { cookie } = await pairDevice(instance.gateway)
  const socket = await open(wsUrl(instance.gateway, '/mobile/ws'), { cookie })
  const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)))
  for (let i = 0; i < 25; i += 1) {
    socket.send(JSON.stringify({ type: 'status.get', id: `s${i}` }))
  }
  assert.equal(await closed, 4004)
})

test('websocket: /mobile/ws closes 4001 without a session', async (t) => {
  const upstream = await startFakeUpstream()
  const instance = await createGateway({ upstreamOrigin: upstream.origin })
  t.after(async () => {
    await instance.close()
    await upstream.close()
  })
  const socket = await open(wsUrl(instance.gateway, '/mobile/ws'))
  const code = await new Promise((resolve) => socket.once('close', (value) => resolve(value)))
  assert.equal(code, 4001)
})
