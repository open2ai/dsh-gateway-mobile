/**
 * Device registrations, revocation, silent expiry, and OAuth bindings.
 *
 * Devices are persisted to `devices.json`; the store is small and owned by a
 * single user, so an in-memory map plus atomic rewrites is sufficient.
 *
 * @module dsh-gateway-mobile/lib/devices
 */

import path from 'node:path'
import { CODES, GatewayError } from './errors.js'
import { JsonFile } from './store.js'
import { deviceDisplayName } from './util.js'
import crypto from 'node:crypto'

const DEVICE_ID_PATTERN = /^dev_[a-f0-9]{16}$/

export interface OAuthBinding {
  provider: 'github' | 'gitee'
  providerUserId: string
  username: string
  avatarUrl?: string
  boundAt: number
}

export interface Device {
  deviceId: string
  deviceName: string
  userAgent: string
  createdAt: number
  lastActiveAt: number
  lastIp: string
  oauthBindings: OAuthBinding[]
  revoked: boolean
  revokedAt?: number
  expired?: boolean
}

export interface DeviceSocket {
  once(event: 'close', listener: () => void): unknown
  destroy?(): void
}

export interface DeviceManagerOptions {
  dataDir: string
  maxDevices: number
  inactiveExpiryDays: number
  logger: { audit(entry: Record<string, unknown>): void }
}

export interface RegisterDeviceInput {
  deviceName?: string
  userAgent?: string
  ip?: string
}

export interface PublicDevice {
  deviceId: string
  deviceName: string
  displayName: string
  userAgent: string
  createdAt: string
  lastActiveAt: string
  lastIp: string
  oauthBindings: Array<{
    provider: 'github' | 'gitee'
    username: string
    avatarUrl: string
    boundAt: string
  }>
  isOnline: boolean
  isCurrent: boolean
  revoked: boolean
  expired: boolean
}

export class DeviceManager {
  cleanupTimer: ReturnType<typeof setInterval> | null
  devices: Map<string, Device>
  file: JsonFile
  inactiveExpiryDays: number
  logger: DeviceManagerOptions['logger']
  maxDevices: number
  sockets: Map<string, Set<DeviceSocket>>
  touchTimes: Map<string, number>

  constructor(options: DeviceManagerOptions) {
    this.maxDevices = options.maxDevices
    this.inactiveExpiryDays = options.inactiveExpiryDays
    this.logger = options.logger
    this.file = new JsonFile(path.join(options.dataDir, 'devices.json'), () => ({ version: 1, devices: {} }))
    this.devices = new Map()
    this.sockets = new Map()
    this.cleanupTimer = null
    this.touchTimes = new Map()
    this.load()
  }

  load(): void {
    const data = this.file.load() as { devices?: Record<string, Device> } | null
    const devices = data && typeof data === 'object' && data.devices && typeof data.devices === 'object' ? data.devices : {}
    for (const [id, device] of Object.entries(devices)) {
      if (!device || typeof device !== 'object') continue
      const normalized: Device = {
        ...device,
        oauthBindings: Array.isArray(device.oauthBindings) ? device.oauthBindings : [],
      }
      this.devices.set(id, normalized)
    }
    this.#expireInactive()
  }

  async flush(): Promise<void> {
    await this.file.flush()
  }

  startCleanup(): void {
    if (this.cleanupTimer) return
    this.cleanupTimer = setInterval(() => this.#expireInactive(), 60 * 60 * 1000)
    this.cleanupTimer.unref?.()
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  register(input: RegisterDeviceInput = {}): Device {
    const active = this.listActive()
    if (active.length >= this.maxDevices) throw new GatewayError(CODES.DEVICE_LIMIT_REACHED)
    const now = Date.now()
    const device: Device = {
      deviceId: `dev_${crypto.randomBytes(8).toString('hex')}`,
      deviceName: this.#sanitizeName(input.deviceName) || deviceDisplayName(undefined, input.userAgent),
      userAgent: String(input.userAgent ?? '').slice(0, 512),
      createdAt: now,
      lastActiveAt: now,
      lastIp: String(input.ip ?? '').slice(0, 128),
      oauthBindings: [],
      revoked: false,
    }
    this.devices.set(device.deviceId, device)
    this.logger.audit({ action: 'device.registered', deviceId: device.deviceId, deviceName: device.deviceName })
    this.#persist()
    return device
  }

  get(deviceId: string): Device | null {
    if (!DEVICE_ID_PATTERN.test(String(deviceId ?? ''))) return null
    return this.devices.get(deviceId) ?? null
  }

  /** Throw for missing/revoked/expired devices. */
  requireActive(deviceId: string): Device {
    const device = this.get(deviceId)
    if (!device) throw new GatewayError(CODES.INVALID_DEVICE_ID)
    if (device.revoked) throw new GatewayError(CODES.DEVICE_REVOKED)
    if (device.expired) throw new GatewayError(CODES.DEVICE_EXPIRED)
    if (this.#isInactive(device, Date.now())) {
      device.expired = true
      this.#persist()
      throw new GatewayError(CODES.DEVICE_EXPIRED)
    }
    return device
  }

  /** Update activity at most once a minute per device. */
  touch(deviceId: string, ip: string): void {
    const device = this.devices.get(deviceId)
    if (!device) return
    const now = Date.now()
    const last = this.touchTimes.get(deviceId) ?? 0
    if (now - last < 60_000) return
    this.touchTimes.set(deviceId, now)
    device.lastActiveAt = now
    if (ip) device.lastIp = String(ip).slice(0, 128)
    this.file.saveSoon()
  }

  /** Rename one active device. */
  rename(deviceId: string, deviceName: string): Device {
    const device = this.requireActive(deviceId)
    device.deviceName = this.#sanitizeName(deviceName) || device.deviceName
    this.logger.audit({ action: 'device.renamed', deviceId, deviceName: device.deviceName })
    this.#persist()
    return device
  }

  revoke(deviceId: string): Device {
    const device = this.requireActive(deviceId)
    device.revoked = true
    device.revokedAt = Date.now()
    this.logger.audit({ action: 'device.revoked', deviceId })
    this.closeDevice(deviceId, 4002)
    this.#persist()
    return device
  }

  revokeAll(): number {
    const now = Date.now()
    let count = 0
    for (const device of this.devices.values()) {
      if (!device.revoked) {
        device.revoked = true
        device.revokedAt = now
        count += 1
        this.closeDevice(device.deviceId, 4002)
      }
    }
    this.logger.audit({ action: 'device.revoke_all', count })
    this.#persist()
    return count
  }

  /** Permanently delete one revoked/expired device record. */
  remove(deviceId: string): Device {
    const device = this.get(deviceId)
    if (!device) throw new GatewayError(CODES.INVALID_DEVICE_ID)
    if (!device.revoked && !device.expired) throw new GatewayError(CODES.DEVICE_NOT_DELETABLE)
    this.#drop(deviceId)
    this.logger.audit({ action: 'device.deleted', deviceId })
    this.#persist()
    return device
  }

  /** Permanently delete every revoked/expired device record. */
  purgeInactive(): number {
    let count = 0
    for (const [deviceId, device] of [...this.devices.entries()]) {
      if (!device.revoked && !device.expired) continue
      this.#drop(deviceId)
      count += 1
    }
    this.logger.audit({ action: 'device.purged', count })
    if (count > 0) this.#persist()
    return count
  }

  #drop(deviceId: string): void {
    this.devices.delete(deviceId)
    this.touchTimes.delete(deviceId)
    this.closeDevice(deviceId)
  }

  listActive(): Device[] {
    return [...this.devices.values()].filter((device) => !device.revoked && !device.expired)
  }

  toPublic(device: Device, options: { currentDeviceId?: string } = {}): PublicDevice {
    return {
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      displayName: deviceDisplayName(device.deviceName, device.userAgent),
      userAgent: device.userAgent,
      createdAt: new Date(device.createdAt).toISOString(),
      lastActiveAt: new Date(device.lastActiveAt).toISOString(),
      lastIp: device.lastIp,
      oauthBindings: (device.oauthBindings ?? []).map((binding) => ({
        provider: binding.provider,
        username: binding.username,
        avatarUrl: binding.avatarUrl ?? '',
        boundAt: new Date(binding.boundAt).toISOString(),
      })),
      isOnline: (this.sockets.get(device.deviceId)?.size ?? 0) > 0,
      isCurrent: options.currentDeviceId === device.deviceId,
      revoked: device.revoked,
      expired: Boolean(device.expired),
    }
  }

  bindOAuth(deviceId: string, binding: OAuthBinding): Device {
    const device = this.requireActive(deviceId)
    device.oauthBindings = device.oauthBindings.filter((entry) => entry.provider !== binding.provider)
    device.oauthBindings.push(binding)
    this.logger.audit({ action: 'oauth.bound', deviceId, provider: binding.provider, username: binding.username })
    this.#persist()
    return device
  }

  unbindOAuth(deviceId: string, provider: 'github' | 'gitee'): Device {
    const device = this.requireActive(deviceId)
    device.oauthBindings = device.oauthBindings.filter((entry) => entry.provider !== provider)
    this.logger.audit({ action: 'oauth.unbound', deviceId, provider })
    this.#persist()
    return device
  }

  /** Track a long-lived socket so revocation can close it immediately. */
  attachSocket(deviceId: string, socket: DeviceSocket): void {
    let set = this.sockets.get(deviceId)
    if (!set) {
      set = new Set()
      this.sockets.set(deviceId, set)
    }
    set.add(socket)
    socket.once('close', () => {
      set.delete(socket)
      if (set.size === 0) this.sockets.delete(deviceId)
    })
  }

  /** Close every socket owned by a device, optionally with a WebSocket close frame. */
  closeDevice(deviceId: string, code = 4002): void {
    const set = this.sockets.get(deviceId)
    if (!set) return
    for (const socket of set) {
      try {
        if (typeof socket.destroy === 'function') socket.destroy()
      } catch {
        // ignore
      }
    }
    set.clear()
    this.sockets.delete(deviceId)
    this.logger.audit({ action: 'device.sockets_closed', deviceId, code })
  }

  closeAll(): void {
    for (const deviceId of [...this.sockets.keys()]) this.closeDevice(deviceId, 4005)
  }

  #isInactive(device: Device, now: number): boolean {
    return now - device.lastActiveAt > this.inactiveExpiryDays * 86400 * 1000
  }

  #expireInactive(): void {
    const now = Date.now()
    let changed = false
    for (const device of this.devices.values()) {
      if (!device.revoked && !device.expired && this.#isInactive(device, now)) {
        device.expired = true
        changed = true
        this.logger.audit({ action: 'device.expired', deviceId: device.deviceId })
      }
    }
    if (changed) this.#persist()
  }

  #persist(): void {
    this.file.value = { version: 1, devices: Object.fromEntries(this.devices) }
    this.file.saveSoon()
  }

  #sanitizeName(value: unknown): string {
    return String(value ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 48)
  }
}
