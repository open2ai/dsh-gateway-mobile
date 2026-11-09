/**
 * Phase 2 security regression tests: rotating secret keys, legacy migration,
 * kid-aware session tokens, and pairing-code log redaction.
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PairingManager } from '../lib/pairing.js'
import { SessionManager } from '../lib/sessions.js'
import { SecretBox } from '../lib/store.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-security-keys-'))
}

function keysFile(dir) {
  return path.join(dir, 'secret-keys.json')
}

function readKeysDocument(dir) {
  return JSON.parse(fs.readFileSync(keysFile(dir), 'utf8'))
}

function encryptV1(key, value) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.')
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

test('secret box creates a versioned key file and encrypts with the active kid', () => {
  const dir = tempDir()
  const box = new SecretBox(dir).load()
  assert.equal(box.activeKid, 'k1')
  assert.deepEqual(box.keyIds(), ['k1'])

  const doc = readKeysDocument(dir)
  assert.equal(doc.version, 2)
  assert.equal(doc.active, 'k1')
  assert.equal(doc.keys.length, 1)
  assert.equal(doc.keys[0].kid, 'k1')
  assert.equal(Buffer.from(doc.keys[0].key, 'base64').length, 32)

  const payload = box.encrypt({ hello: 'world' })
  assert.match(payload, /^v2\.k1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.deepEqual(box.decrypt(payload), { hello: 'world' })
  assert.equal(box.decrypt('v1.bogus'), null)
  assert.equal(box.decrypt('not-a-ciphertext'), null)

  const parts = payload.split('.')
  const ciphertext = parts[4]
  parts[4] = `${ciphertext[0] === 'A' ? 'B' : 'A'}${ciphertext.slice(1)}`
  assert.equal(box.decrypt(parts.join('.')), null)
})

test('legacy secret.key migrates to k1 and old v1 ciphertext stays decryptable', () => {
  const dir = tempDir()
  const legacyKey = crypto.randomBytes(32)
  fs.writeFileSync(path.join(dir, 'secret.key'), `${legacyKey.toString('base64')}\n`, { mode: 0o600 })
  const v1 = encryptV1(legacyKey, { token: 'legacy-credential' })
  assert.equal(v1.split('.')[0], 'v1')

  const box = new SecretBox(dir).load()
  assert.equal(box.activeKid, 'k1')
  assert.deepEqual(box.keyIds(), ['k1'])
  assert.deepEqual(box.decrypt(v1), { token: 'legacy-credential' })

  // The legacy key is migrated into secret-keys.json (the old file is kept).
  assert.equal(fs.existsSync(keysFile(dir)), true)
  const doc = readKeysDocument(dir)
  assert.equal(doc.active, 'k1')
  assert.deepEqual(doc.keys.map((entry) => entry.kid), ['k1'])
  assert.equal(Buffer.from(doc.keys[0].key, 'base64').equals(legacyKey), true)

  // New ciphertexts are written in the v2 format under the migrated kid.
  assert.match(box.encrypt({ migrated: true }), /^v2\.k1\./)
  assert.deepEqual(box.decrypt(box.encrypt({ migrated: true })), { migrated: true })
})

test('rotate() keeps old ciphertext readable, switches the active kid and caps retention at 5', () => {
  const dir = tempDir()
  const box = new SecretBox(dir).load()
  const before = box.encrypt({ generation: 1 })

  const first = box.rotate()
  assert.equal(first.activeKid, 'k2')
  assert.equal(first.retired, 0)
  assert.deepEqual(first.keyIds, ['k2', 'k1'])
  assert.deepEqual(box.decrypt(before), { generation: 1 })
  assert.match(box.encrypt({ generation: 2 }), /^v2\.k2\./)

  const generation2 = box.encrypt({ generation: 2 })
  for (let i = 0; i < 3; i += 1) {
    assert.equal(box.rotate().retired, 0)
  }
  assert.equal(box.keyIds().length, 5)
  // Retained keys still decrypt the older generation.
  assert.deepEqual(box.decrypt(generation2), { generation: 2 })

  // The sixth key retires exactly the oldest one; the active key is retained.
  const overflow = box.rotate()
  assert.equal(overflow.retired, 1)
  assert.equal(overflow.keyIds.length, 5)
  assert.equal(overflow.activeKid, box.activeKid)
  assert.equal(overflow.keyIds.includes('k1'), false)
  assert.equal(overflow.keyIds[0], box.activeKid)
  assert.deepEqual(box.decrypt(generation2), { generation: 2 })

  const doc = readKeysDocument(dir)
  assert.equal(doc.version, 2)
  assert.equal(doc.active, box.activeKid)
  assert.equal(doc.keys.length, 5)

  // A fresh process reloads the same key set and can read current ciphertext.
  const current = box.encrypt({ generation: 'current' })
  const reloaded = new SecretBox(dir).load()
  assert.equal(reloaded.activeKid, box.activeKid)
  assert.deepEqual(reloaded.keyIds(), box.keyIds())
  assert.deepEqual(reloaded.decrypt(current), { generation: 'current' })
})

test('session manager issues kid-scoped tokens and verifies legacy tokens across rotation', () => {
  const dir = tempDir()
  const box = new SecretBox(dir).load()
  const sessions = new SessionManager({ box, maxAgeSeconds: 3600 })
  const deviceId = 'dev_0123456789abcdef'

  const issued = sessions.issue(deviceId)
  assert.equal(issued.token.startsWith('k1:'), true)
  assert.equal(issued.token.split('.').length, 2)
  const verified = sessions.verify(issued.token)
  assert.equal(verified.ok, true)
  assert.equal(verified.payload.deviceId, deviceId)

  // Legacy token shape: <base64url(payload)>.<hmac without kid>.
  const now = Date.now()
  const legacyPayload = base64url({ v: 1, deviceId, issuedAt: now, expiresAt: now + 3_600_000 })
  const legacyToken = `${legacyPayload}.${box.hmac(legacyPayload, 'k1')}`
  assert.equal(sessions.verify(legacyToken).ok, true)

  box.rotate()
  assert.equal(box.activeKid, 'k2')
  // Old kid-scoped tokens and legacy tokens stay valid after rotation.
  assert.equal(sessions.verify(issued.token).ok, true)
  assert.equal(sessions.verify(legacyToken).ok, true)

  // New tokens carry the new kid.
  const next = sessions.issue(deviceId)
  assert.equal(next.token.startsWith('k2:'), true)
  assert.equal(sessions.verify(next.token).ok, true)

  // Tampering / malformed tokens are still rejected.
  const [head, signature] = issued.token.split('.')
  assert.equal(sessions.verify(`${head}.${signature.slice(0, -1)}x`).ok, false)
  assert.equal(sessions.verify('not-a-token').ok, false)
  assert.equal(sessions.verify(undefined).ok, false)
})

test('pairing issue never logs or audits the full pairing code', () => {
  const logs = []
  const audits = []
  const logger = {
    info(message) {
      logs.push(String(message))
    },
    audit(entry) {
      audits.push(entry)
    },
  }
  const pairing = new PairingManager({ ttlSeconds: 60, logger })
  const description = pairing.describe()
  const code = description.code
  const formatted = `${code.slice(0, 4)}-${code.slice(4)}`

  assert.equal(description.formatted, formatted)
  assert.ok(logs.length >= 1)
  for (const line of logs) {
    assert.equal(line.includes(code), false, `log leaked the full code: ${line}`)
    assert.equal(line.includes(formatted), false, `log leaked the formatted code: ${line}`)
    assert.match(line, /\*{4}-[A-Z0-9]{2}/)
  }

  // Consuming also must not leak the code into the audit trail.
  pairing.consume(code, 'phone')
  for (const line of logs) {
    assert.equal(line.includes(code), false, `log leaked the full code: ${line}`)
    assert.equal(line.includes(formatted), false, `log leaked the formatted code: ${line}`)
  }
  for (const entry of audits) {
    const serialized = JSON.stringify(entry)
    assert.equal(serialized.includes(code), false, `audit leaked the full code: ${serialized}`)
    assert.equal(serialized.includes(formatted), false, `audit leaked the formatted code: ${serialized}`)
  }
  assert.ok(audits.some((entry) => entry.action === 'pairing.issued'))
  assert.ok(audits.some((entry) => entry.action === 'pairing.consumed'))
})
