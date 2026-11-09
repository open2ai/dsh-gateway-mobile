import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

// The browser bundle is plain ESM with no DOM side effects at import time, so
// Node can import it after `node scripts/build-web.mjs` to exercise the
// weak-network helpers without a DOM.
const commonUrl = new URL('../web/assets/common.js', import.meta.url)
const built = existsSync(commonUrl)
const common = built ? await import(commonUrl.href) : null
const skip = built ? false : 'web/assets/common.js missing: run node scripts/build-web.mjs'

test('GET backoff sequence is 500ms/1s/2s and clamps after 3 retries', { skip }, () => {
  assert.deepEqual([...common.GET_RETRY_DELAYS], [500, 1000, 2000])
  assert.equal(common.retryDelayMs(0), 500)
  assert.equal(common.retryDelayMs(1), 1000)
  assert.equal(common.retryDelayMs(2), 2000)
  // Extra attempts (or bad input) clamp to the last delay instead of growing.
  assert.equal(common.retryDelayMs(3), 2000)
  assert.equal(common.retryDelayMs(-1), 500)
  assert.equal(common.retryDelayMs(1.9), 1000)
})

test('only transient statuses are retryable', { skip }, () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal(common.isRetryableStatus(status), true, `status ${status} should retry`)
  }
  for (const status of [200, 201, 204, 301, 304, 400, 401, 403, 404, 409, 422]) {
    assert.equal(common.isRetryableStatus(status), false, `status ${status} should not retry`)
  }
})

test('connection state starts online and notifies subscribers immediately', { skip }, () => {
  assert.equal(common.connectionState(), 'online')
  const seen = []
  const unsubscribe = common.onConnectionChange((state) => seen.push(state))
  assert.deepEqual(seen, ['online'])
  unsubscribe()
  assert.equal(seen.length, 1)
})
