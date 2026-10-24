import assert from 'node:assert/strict'
import test from 'node:test'
import { parseQuickTunnelUrl } from '../lib/tunnel.js'

test('parseQuickTunnelUrl extracts the URL from cloudflared output', () => {
  const line = '2026-10-23T12:00:00Z INF |  https://random-words-here.trycloudflare.com  |'
  assert.equal(parseQuickTunnelUrl(line), 'https://random-words-here.trycloudflare.com')
})

test('parseQuickTunnelUrl ignores unrelated lines', () => {
  assert.equal(parseQuickTunnelUrl('INF Starting metrics server'), '')
  assert.equal(parseQuickTunnelUrl(''), '')
})

test('parseQuickTunnelUrl handles ANSI-free box output', () => {
  const line = '|  https://abc-123.trycloudflare.com  |'
  assert.equal(parseQuickTunnelUrl(line), 'https://abc-123.trycloudflare.com')
})
