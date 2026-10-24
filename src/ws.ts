/**
 * Minimal RFC 6455 WebSocket server used by the gateway's control endpoint
 * (`/mobile/ws`). DSH's own Remote mux is proxied opaquely and never parsed
 * here.
 *
 * @module dsh-gateway-mobile/lib/ws
 */

import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Logger } from './logger.js'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OPCODE = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 }

export function acceptKey(key: string): string {
  return crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64')
}

/** Encode a server-to-client frame (unmasked). */
function encodeFrame(opcode: number, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  let header: Buffer
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length])
  } else if (data.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  return Buffer.concat([header, data])
}

export interface WsConnectionOptions {
  heartbeatInterval?: number
  logger?: Logger
}

interface WsFrame {
  fin: boolean
  opcode: number
  payload: Buffer
}

/**
 * A tiny WebSocket connection wrapper.
 */
export class WsConnection extends EventEmitter {
  buffer: Buffer
  closed: boolean
  heartbeatInterval: number
  heartbeatTimer: ReturnType<typeof setInterval> | null
  lastSeen: number
  logger: Logger | undefined
  socket: Duplex
  terminated: boolean
  /** Per-connection message-rate window for the gateway control endpoint. */
  _rateWindow?: { start: number; count: number }

  constructor(socket: Duplex, options: WsConnectionOptions = {}) {
    super()
    this.socket = socket
    this.logger = options.logger
    this.buffer = Buffer.alloc(0)
    this.closed = false
    this.lastSeen = Date.now()
    this.heartbeatInterval = options.heartbeatInterval ?? 30000
    this.heartbeatTimer = null
    this.terminated = false
    socket.on('data', (chunk: Buffer) => this.#onData(chunk))
    socket.on('error', (error: unknown) => this.#fail(error))
    socket.on('close', () => this.#closed())
    this.#startHeartbeat()
  }

  /** Send a text frame. */
  sendText(text: string): boolean {
    if (this.closed) return false
    try {
      this.socket.write(encodeFrame(OPCODE.text, Buffer.from(String(text), 'utf8')))
      return true
    } catch {
      return false
    }
  }

  /** Send a ping frame. */
  ping(): void {
    if (this.closed) return
    try {
      this.socket.write(encodeFrame(OPCODE.ping, Buffer.alloc(0)))
    } catch {
      // ignore
    }
  }

  /** Send a close frame and end the socket. */
  close(code = 1000, reason = ''): void {
    if (this.closed) return
    this.closed = true
    this.#stopHeartbeat()
    const reasonBuffer = Buffer.from(String(reason).slice(0, 120), 'utf8')
    const payload = Buffer.alloc(2 + reasonBuffer.length)
    payload.writeUInt16BE(code, 0)
    reasonBuffer.copy(payload, 2)
    try {
      this.socket.write(encodeFrame(OPCODE.close, payload))
      this.socket.end()
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        this.socket.destroy()
      } catch {
        // ignore
      }
    }, 1000).unref?.()
  }

  terminate(): void {
    this.closed = true
    this.#stopHeartbeat()
    try {
      this.socket.destroy()
    } catch {
      // ignore
    }
  }

  #startHeartbeat(): void {
    if (!this.heartbeatInterval) return
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return
      if (Date.now() - this.lastSeen > this.heartbeatInterval * 2) {
        this.logger?.warn('WebSocket heartbeat timeout; terminating')
        this.terminate()
        return
      }
      this.ping()
    }, this.heartbeatInterval)
    this.heartbeatTimer.unref?.()
  }

  #stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  #fail(error: unknown): void {
    if (this.terminated) return
    this.terminated = true
    this.logger?.debug(`WebSocket error: ${error instanceof Error ? error.message : String(error)}`)
    this.#closed()
  }

  #closed(): void {
    if (this.closed) return
    this.closed = true
    this.#stopHeartbeat()
    this.emit('close')
  }

  #onData(chunk: Buffer): void {
    this.lastSeen = Date.now()
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]!
      const second = this.buffer[1]!
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const big = this.buffer.readBigUInt64BE(2)
        if (big > BigInt(1024 * 1024)) {
          this.close(4003, 'message too large')
          return
        }
        length = Number(big)
        offset = 10
      }
      if (!masked) {
        this.close(4003, 'client frames must be masked')
        return
      }
      if (this.buffer.length < offset + 4 + length) return
      const mask = this.buffer.subarray(offset, offset + 4)
      offset += 4
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length))
      for (let i = 0; i < payload.length; i += 1) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0)
      this.buffer = this.buffer.subarray(offset + length)
      this.#handleFrame({ fin, opcode, payload })
    }
  }

  #handleFrame({ fin, opcode, payload }: WsFrame): void {
    if (!fin) {
      this.close(4003, 'fragmented frames are not supported')
      return
    }
    if (opcode === OPCODE.ping) {
      try {
        this.socket.write(encodeFrame(OPCODE.pong, payload))
      } catch {
        // ignore
      }
      return
    }
    if (opcode === OPCODE.pong) return
    if (opcode === OPCODE.close) {
      this.close(1000)
      return
    }
    if (opcode !== OPCODE.text) {
      this.close(4003, 'binary frames are not supported')
      return
    }
    let text: string
    try {
      text = payload.toString('utf8')
    } catch {
      this.close(4003, 'invalid utf8')
      return
    }
    this.emit('message', text)
  }
}

/**
 * Complete the WebSocket handshake and return a WsConnection.
 */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: WsConnectionOptions = {},
): WsConnection | null {
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || !key) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return null
  }
  const protocolHeader = req.headers['sec-websocket-protocol']
  const requested = typeof protocolHeader === 'string' ? protocolHeader.split(',').map((value) => value.trim()) : []
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
  ]
  if (requested.includes('dsh-mobile-v1')) lines.push('Sec-WebSocket-Protocol: dsh-mobile-v1')
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  if (head?.length) socket.unshift(head)
  return new WsConnection(socket, options)
}
