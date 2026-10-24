/**
 * Lightweight access statistics: requests per day and per device.
 *
 * Only aggregate counters are stored (no request bodies, paths, or IPs).
 * Used by the admin page and `/status`; token usage is intentionally not
 * fabricated here (DSH does not expose it over a stable endpoint).
 *
 * @module dsh-gateway-mobile/lib/stats
 */

import path from 'node:path'
import { JsonFile } from './store.js'

interface DayStats {
  requests: number
  devices: Record<string, number>
}

interface StatsData {
  version: number
  days: Record<string, DayStats>
  totalRequests: number
}

export interface StatsSummary {
  days: number
  totalRequests: number
  windowRequests: number
  todayRequests: number
  byDevice: Record<string, number>
  daily: Array<{ date: string; requests: number }>
  topDevices: Array<{ deviceId: string; requests: number }>
}

function dayKey(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export class StatsStore {
  data: StatsData
  file: JsonFile
  retentionDays: number

  constructor(options: { dataDir: string; retentionDays?: number }) {
    this.retentionDays = options.retentionDays ?? 30
    this.file = new JsonFile(path.join(options.dataDir, 'stats.json'), () => ({
      version: 1,
      days: {},
      totalRequests: 0,
    }))
    const loaded = this.file.load() as Partial<StatsData> | null
    this.data = {
      version: 1,
      days: loaded?.days && typeof loaded.days === 'object' ? loaded.days : {},
      totalRequests: typeof loaded?.totalRequests === 'number' ? loaded.totalRequests : 0,
    }
    for (const [key, day] of Object.entries(this.data.days)) {
      if (!day || typeof day !== 'object') {
        delete this.data.days[key]
        continue
      }
      day.requests = Number(day.requests) || 0
      day.devices = day.devices && typeof day.devices === 'object' ? day.devices : {}
    }
    this.#prune()
  }

  async flush(): Promise<void> {
    await this.file.flush()
  }

  /** Record one authenticated request. */
  record(deviceId?: string): void {
    const key = dayKey()
    const day = this.data.days[key] ?? { requests: 0, devices: {} }
    day.requests += 1
    if (deviceId) day.devices[deviceId] = (day.devices[deviceId] ?? 0) + 1
    this.data.days[key] = day
    this.data.totalRequests += 1
    this.#prune()
    this.file.saveSoon()
  }

  /** Aggregate the last `days` calendar days. */
  summary(days = 7): StatsSummary {
    const window = Math.max(1, Math.min(days, this.retentionDays))
    const today = new Date()
    const result: StatsSummary = {
      days: window,
      totalRequests: this.data.totalRequests,
      windowRequests: 0,
      todayRequests: 0,
      byDevice: {},
      daily: [],
      topDevices: [],
    }
    for (let offset = window - 1; offset >= 0; offset -= 1) {
      const date = new Date(today)
      date.setDate(today.getDate() - offset)
      const key = dayKey(date)
      const day = this.data.days[key]
      const requests = day?.requests ?? 0
      result.daily.push({ date: key, requests })
      result.windowRequests += requests
      if (offset === 0) result.todayRequests = requests
      if (day?.devices) {
        for (const [deviceId, count] of Object.entries(day.devices)) {
          result.byDevice[deviceId] = (result.byDevice[deviceId] ?? 0) + count
        }
      }
    }
    result.topDevices = Object.entries(result.byDevice)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([deviceId, requests]) => ({ deviceId, requests }))
    return result
  }

  #prune(): void {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - this.retentionDays)
    const keepFrom = dayKey(cutoff)
    for (const key of Object.keys(this.data.days)) {
      if (key < keepFrom) delete this.data.days[key]
    }
    this.file.value = this.data
  }
}
