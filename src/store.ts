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

/**
 * AES-256-GCM helper with a key file created on first use.
 */
export class SecretBox {
  keyFile: string
  key: Buffer | null

  constructor(dataDir: string) {
    this.keyFile = path.join(dataDir, 'secret.key')
    this.key = null
  }

  /** Load or create the 32-byte key. */
  load(): this {
    try {
      const raw = fs.readFileSync(this.keyFile, 'utf8').trim()
      const key = Buffer.from(raw, 'base64')
      if (key.length !== 32) throw new Error('invalid key length')
      this.key = key
    } catch {
      this.key = crypto.randomBytes(32)
      fs.mkdirSync(path.dirname(this.keyFile), { recursive: true, mode: 0o700 })
      fs.writeFileSync(this.keyFile, `${this.key.toString('base64')}\n`, { encoding: 'utf8', mode: 0o600 })
      try {
        fs.chmodSync(this.keyFile, 0o600)
      } catch {
        // ignore
      }
    }
    return this
  }

  #requireKey(): Buffer {
    if (!this.key) this.load()
    return this.key as Buffer
  }

  /** HMAC key material for session cookies. */
  hmac(data: string): string {
    return crypto.createHmac('sha256', this.#requireKey()).update(data).digest('base64url')
  }

  /** Encrypt a JSON-serializable value into a compact string. */
  encrypt(value: unknown): string {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.#requireKey(), iv)
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.')
  }

  /** Decrypt a value produced by encrypt(); returns null on tampering. */
  decrypt<T = unknown>(payload: string): T | null {
    try {
      const parts = String(payload).split('.')
      if (parts.length !== 4 || parts[0] !== 'v1') return null
      const [, ivB64 = '', tagB64 = '', dataB64 = ''] = parts
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.#requireKey(), Buffer.from(ivB64, 'base64url'))
      decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
      const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()])
      return JSON.parse(plaintext.toString('utf8')) as T
    } catch {
      return null
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
