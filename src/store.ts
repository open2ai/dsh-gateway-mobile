/**
 * Persistent storage helpers: atomic JSON files and AES-256-GCM secrets.
 *
 * The gateway stores as little as possible: device registrations, the tunnel
 * session state, and a random HMAC/AES key. OAuth client secrets stay in the
 * plugin configuration (and are never copied here).
 *
 * @module dsh-gateway-mobile/lib/store
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Ensure a directory exists (recursive) and restrict it to the owner when possible. */
export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    await fsp.chmod(dir, 0o700)
  } catch {
    // Windows may not support POSIX modes; ACLs are the platform's job.
  }
}

/**
 * An atomically-written JSON document.
 */
export class JsonFile<T = unknown> {
  file: string
  fallback: () => T
  value: T
  loaded: boolean
  saveTimer: ReturnType<typeof setTimeout> | null
  saving: Promise<void> | null

  constructor(file: string, fallback: () => T) {
    this.file = file
    this.fallback = fallback
    this.value = fallback()
    this.loaded = false
    this.saveTimer = null
    this.saving = null
  }

  /** Synchronous load used during plugin startup. */
  load(): T {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      this.value = JSON.parse(raw) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        // A corrupt file must not take the whole gateway down; keep a backup.
        try {
          fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
        } catch {
          // ignore
        }
      }
      this.value = this.fallback()
    }
    this.loaded = true
    return this.value
  }

  /** Replace the whole document and persist it. */
  async set(value: T): Promise<void> {
    this.value = value
    await this.save()
  }

  /** Persist the current document. */
  async save(): Promise<void> {
    if (this.saving) {
      await this.saving
    }
    this.saving = this.#write()
    try {
      await this.saving
    } finally {
      this.saving = null
    }
  }

  /** Force a pending document to disk (used during shutdown). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.save()
  }

  /** Debounced save for request-path bookkeeping. */
  saveSoon(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save().catch(() => {})
    }, 50)
    this.saveTimer.unref?.()
  }

  async #write(): Promise<void> {
    await ensureDir(path.dirname(this.file))
    const temp = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
    const body = `${JSON.stringify(this.value, null, 2)}\n`
    await fsp.writeFile(temp, body, { encoding: 'utf8', mode: 0o600 })
    try {
      await fsp.rename(temp, this.file)
    } catch (error) {
      // Windows may refuse to rename over an open file; retry after a tick.
      if (process.platform === 'win32') {
        await fsp.rm(this.file, { force: true })
        await fsp.rename(temp, this.file)
      } else {
        throw error
      }
    }
  }
}

interface SecretKeyEntry {
  key: Buffer
  createdAt: number
}

interface SecretKeysDocument {
  version: 2
  active: string
  keys: Array<{ kid: string; key: string; createdAt: number }>
}

/** Hard cap on the number of retained keys (active key never retired). */
const MAX_SECRET_KEYS = 5
const SECRET_KID_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * AES-256-GCM / HMAC helper with a rotating key set.
 *
 * Keys live in `secret-keys.json` (version 2). A legacy single-key
 * `secret.key` is migrated on load: its content becomes `k1`. Ciphertexts are
 * `v2.<kid>.<iv>.<tag>.<data>`; the older `v1.<iv>.<tag>.<data>` form is still
 * decrypted (with every retained key) for backwards compatibility.
 */
export class SecretBox {
  dataDir: string
  keyFile: string
  keysFile: string
  activeKid: string
  keys: Map<string, SecretKeyEntry>

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.keyFile = path.join(dataDir, 'secret.key')
    this.keysFile = path.join(dataDir, 'secret-keys.json')
    this.activeKid = ''
    this.keys = new Map()
  }

  /** Load the key set, migrating a legacy `secret.key` or creating one. */
  load(): this {
    const stored = this.#readKeysDocument()
    if (stored) {
      this.keys = stored.keys
      this.activeKid = stored.active
      return this
    }
    const legacy = this.#readLegacyKey()
    if (legacy) {
      this.keys = new Map([['k1', { key: legacy, createdAt: Date.now() }]])
      this.activeKid = 'k1'
      this.#persist()
      return this
    }
    this.keys = new Map([['k1', { key: crypto.randomBytes(32), createdAt: Date.now() }]])
    this.activeKid = 'k1'
    this.#persist()
    return this
  }

  /** Legacy accessor kept for older integrations: the active 32-byte key. */
  get key(): Buffer {
    return this.#entry().key
  }

  /** Key ids with the active key first, then the retained older keys. */
  keyIds(): string[] {
    this.#ensureLoaded()
    const ids = [...this.keys.keys()]
    const index = ids.indexOf(this.activeKid)
    if (index > 0) {
      ids.splice(index, 1)
      ids.unshift(this.activeKid)
    }
    return ids
  }

  /** HMAC key material for session cookies / OAuth state. Defaults to the active key. */
  hmac(data: string, kid?: string): string {
    return crypto.createHmac('sha256', this.#entry(kid).key).update(data).digest('base64url')
  }

  /** Encrypt a JSON-serializable value into a compact string using the active key. */
  encrypt(value: unknown): string {
    const entry = this.#entry()
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', entry.key, iv)
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    return [
      'v2',
      entry.kid,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.')
  }

  /** Decrypt a value produced by encrypt(); returns null on tampering/unknown key. */
  decrypt<T = unknown>(payload: string): T | null {
    this.#ensureLoaded()
    const parts = String(payload ?? '').split('.')
    if (parts[0] === 'v2') {
      if (parts.length !== 5) return null
      const [, kid = '', ivB64 = '', tagB64 = '', dataB64 = ''] = parts
      const entry = this.keys.get(kid)
      if (!entry) return null
      const opened = this.#open<T>(entry.key, ivB64, tagB64, dataB64)
      return opened.ok ? opened.value : null
    }
    if (parts[0] === 'v1') {
      if (parts.length !== 4) return null
      const [, ivB64 = '', tagB64 = '', dataB64 = ''] = parts
      for (const entry of this.keys.values()) {
        const opened = this.#open<T>(entry.key, ivB64, tagB64, dataB64)
        if (opened.ok) return opened.value
      }
      return null
    }
    return null
  }

  /**
   * Generate a fresh key, make it active, and retire the oldest keys beyond
   * the retention cap. Old ciphertexts/signatures stay verifiable.
   */
  rotate(): { activeKid: string; keyIds: string[]; retired: number } {
    this.#ensureLoaded()
    const kid = this.#nextKid()
    this.keys.set(kid, { key: crypto.randomBytes(32), createdAt: Date.now() })
    this.activeKid = kid
    let retired = 0
    while (this.keys.size > MAX_SECRET_KEYS) {
      const oldest = [...this.keys.keys()][0]
      if (oldest === undefined || oldest === this.activeKid) break
      this.keys.delete(oldest)
      retired += 1
    }
    this.#persist()
    return { activeKid: this.activeKid, keyIds: this.keyIds(), retired }
  }

  #ensureLoaded(): void {
    if (this.keys.size === 0) this.load()
  }

  #entry(kid?: string): { kid: string; key: Buffer } {
    this.#ensureLoaded()
    const id = kid ?? this.activeKid
    const entry = this.keys.get(id)
    if (!entry) throw new Error(`unknown secret key id: ${id}`)
    return { kid: id, key: entry.key }
  }

  #open<T>(key: Buffer, ivB64: string, tagB64: string, dataB64: string): { ok: true; value: T } | { ok: false } {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'))
      decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
      const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()])
      return { ok: true, value: JSON.parse(plaintext.toString('utf8')) as T }
    } catch {
      return { ok: false }
    }
  }

  #readKeysDocument(): { keys: Map<string, SecretKeyEntry>; active: string } | null {
    let raw: string
    try {
      raw = fs.readFileSync(this.keysFile, 'utf8')
    } catch {
      return null
    }
    try {
      const doc = JSON.parse(raw) as Partial<SecretKeysDocument>
      if (!doc || doc.version !== 2 || typeof doc.active !== 'string' || !Array.isArray(doc.keys)) return null
      const keys = new Map<string, SecretKeyEntry>()
      for (const item of doc.keys) {
        if (!item || typeof item.kid !== 'string' || !SECRET_KID_PATTERN.test(item.kid) || typeof item.key !== 'string') continue
        const key = Buffer.from(item.key, 'base64')
        if (key.length !== 32) continue
        keys.set(item.kid, { key, createdAt: Number(item.createdAt) || Date.now() })
      }
      if (keys.size === 0) return null
      const active = keys.has(doc.active) ? doc.active : (keys.keys().next().value as string)
      return { keys, active }
    } catch {
      return null
    }
  }

  #readLegacyKey(): Buffer | null {
    try {
      const raw = fs.readFileSync(this.keyFile, 'utf8').trim()
      const key = Buffer.from(raw, 'base64')
      return key.length === 32 ? key : null
    } catch {
      return null
    }
  }

  #nextKid(): string {
    let max = 0
    for (const kid of this.keys.keys()) {
      const match = /^k(\d+)$/.exec(kid)
      if (match?.[1]) max = Math.max(max, Number(match[1]))
    }
    return `k${max + 1}`
  }

  #persist(): void {
    const doc: SecretKeysDocument = {
      version: 2,
      active: this.activeKid,
      keys: [...this.keys].map(([kid, entry]) => ({
        kid,
        key: entry.key.toString('base64'),
        createdAt: entry.createdAt,
      })),
    }
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    const temp = `${this.keysFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      fs.renameSync(temp, this.keysFile)
    } catch {
      try {
        fs.rmSync(this.keysFile, { force: true })
      } catch {
        // ignore
      }
      fs.renameSync(temp, this.keysFile)
    }
    try {
      fs.chmodSync(this.keysFile, 0o600)
    } catch {
      // Windows may not support POSIX modes; ACLs are the platform's job.
    }
  }
}

/** Read a JSON file synchronously, returning fallback when missing/corrupt. */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Write a JSON file atomically (best effort cleanup on failure). */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file))
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await fsp.rename(temp, file)
  } catch (error) {
    if (process.platform === 'win32') {
      await fsp.rm(file, { force: true })
      await fsp.rename(temp, file)
    } else {
      throw error
    }
  }
}
