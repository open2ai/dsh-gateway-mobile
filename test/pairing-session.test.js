import assert from 'node:assert/strict'
import test from 'node:test'
import { CODES, GatewayError, messageFor } from '../lib/errors.js'
import { PairingManager } from '../lib/pairing.js'
import { SessionManager } from '../lib/sessions.js'
import { SecretBox } from '../lib/store.js'
import { Logger } from '../lib/logger.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-unit-'))
}

test('pairing code is single-use and used codes report PAIRING_TOKEN_USED', () => {
  const logger = new Logger({ level: 'error' })
  const pairing = new PairingManager({ ttlSeconds: 60, logger })
  const code = pairing.describe().code
  pairing.consume(code, 'phone')
  assert.throws(() => pairing.consume(code, 'phone'), (error) => error.code === CODES.PAIRING_TOKEN_USED)
})

test('pairing rejects wrong, malformed and expired codes', () => {
  const logger = new Logger({ level: 'error' })
  const pairing = new PairingManager({ ttlSeconds: 60, logger })
  assert.throws(() => pairing.consume('short', 'x'), (error) => error.code === CODES.INVALID_PAIRING_CODE)
  assert.throws(() => pairing.consume('AAAAAAAA', 'x'), (error) => error.code === CODES.PAIRING_FAILED)
  // Force expiry without waiting: mutate the in-memory record (it is private API,
  // but useful to prove the error mapping).
  pairing.current.expiresAt = Date.now() - 1
  assert.throws(() => pairing.consume(pairing.current.code, 'x'), (error) => error.code === CODES.PAIRING_TOKEN_EXPIRED)
})

test('session tokens round-trip and reject tampering/expiry', async () => {
  const dir = tempDir()
  const box = new SecretBox(dir).load()
  const sessions = new SessionManager({ box, maxAgeSeconds: 60 })
  const issued = sessions.issue('dev_0123456789abcdef')
  const verified = sessions.verify(issued.token)
  assert.equal(verified.ok, true)
  assert.equal(verified.payload.deviceId, 'dev_0123456789abcdef')

  const [payload, signature] = issued.token.split('.')
  assert.equal(sessions.verify(`${payload}.${signature.slice(0, -1)}x`).ok, false)
  assert.equal(sessions.verify('not-a-token').ok, false)

  const shortLived = new SessionManager({ box, maxAgeSeconds: 1 })
  const token = shortLived.issue('dev_0123456789abcdef').token
  await new Promise((resolve) => setTimeout(resolve, 1100))
  assert.equal(shortLived.verify(token).code, CODES.SESSION_EXPIRED)
})

test('error messages are bilingual', () => {
  assert.equal(messageFor(CODES.PAIRING_FAILED, 'zh'), '配对码错误，请重试')
  assert.equal(messageFor(CODES.PAIRING_FAILED, 'en'), 'Pairing failed, check the code')
  assert.equal(new GatewayError(CODES.INVALID_PARAMS).httpStatus, 400)
})
