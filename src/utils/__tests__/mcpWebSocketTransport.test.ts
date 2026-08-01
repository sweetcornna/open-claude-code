import type { Transport as ModernTransport } from '@modelcontextprotocol/server'
import type { Transport as LegacyTransport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, test } from 'bun:test'
import { WebSocketTransport } from '../mcpWebSocketTransport.js'

const WS_CONNECTING = 0
const WS_OPEN = 1
const WS_CLOSED = 3

const REQUEST: JSONRPCMessage = {
  jsonrpc: '2.0',
  method: 'tools/list',
  params: {},
  id: 1,
}

/**
 * Stands in for a native `WebSocket`. The transport picks the
 * `addEventListener` branch whenever `Bun` is defined, which is always the
 * case under `bun test`, so only that branch needs to be emulated.
 */
class FakeWebSocket {
  readyState = WS_OPEN
  readonly sent: string[] = []
  closeCalls = 0
  private listeners = new Map<string, Set<(event: unknown) => void>>()

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closeCalls++
    this.readyState = WS_CLOSED
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  /** Drives an event the way the runtime would. */
  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event)
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }
}

function createTransport(): {
  ws: FakeWebSocket
  transport: WebSocketTransport
} {
  const ws = new FakeWebSocket()
  const transport = new WebSocketTransport(ws)
  return { ws, transport }
}

describe('WebSocketTransport', () => {
  test('satisfies both the v1 and the v2 SDK Transport contract', () => {
    const { transport } = createTransport()

    const asLegacy: LegacyTransport = transport
    const asModern: ModernTransport = transport

    expect(typeof asLegacy.start).toBe('function')
    expect(typeof asLegacy.send).toBe('function')
    expect(typeof asLegacy.close).toBe('function')
    // A WebSocket multiplexes every request over one channel, so the v2-only
    // per-request-stream flag stays unset.
    expect(asModern.hasPerRequestStream).toBeUndefined()
  })

  test('round-trips a message in both directions', async () => {
    const { ws, transport } = createTransport()
    const received: JSONRPCMessage[] = []
    transport.onmessage = message => {
      received.push(message)
    }

    await transport.start()
    await transport.send(REQUEST)
    expect(ws.sent).toEqual([JSON.stringify(REQUEST)])

    const response: JSONRPCMessage = { jsonrpc: '2.0', result: {}, id: 1 }
    ws.emit('message', { data: JSON.stringify(response) })
    expect(received).toEqual([response])
  })

  test('rejects a second start', async () => {
    const { transport } = createTransport()
    await transport.start()

    expect(transport.start()).rejects.toThrow(
      'Start can only be called once per transport.',
    )
  })

  test('propagates a socket close to onclose and detaches listeners', async () => {
    const { ws, transport } = createTransport()
    let closes = 0
    transport.onclose = () => {
      closes++
    }
    await transport.start()
    expect(ws.listenerCount('message')).toBe(1)

    ws.emit('close', {})

    expect(closes).toBe(1)
    expect(ws.listenerCount('message')).toBe(0)
    expect(ws.listenerCount('close')).toBe(0)
  })

  test('closes the underlying socket and fires onclose', async () => {
    const { ws, transport } = createTransport()
    let closes = 0
    transport.onclose = () => {
      closes++
    }
    await transport.start()

    await transport.close()

    expect(ws.closeCalls).toBe(1)
    expect(closes).toBe(1)
    expect(ws.listenerCount('message')).toBe(0)
  })

  test('does not re-close an already closed socket', async () => {
    const { ws, transport } = createTransport()
    await transport.start()
    ws.readyState = WS_CLOSED

    await transport.close()

    expect(ws.closeCalls).toBe(0)
  })

  test('surfaces a malformed inbound frame on onerror', async () => {
    const { ws, transport } = createTransport()
    const errors: Error[] = []
    const received: JSONRPCMessage[] = []
    transport.onerror = error => {
      errors.push(error)
    }
    transport.onmessage = message => {
      received.push(message)
    }
    await transport.start()

    ws.emit('message', { data: 'not json' })

    expect(errors.length).toBe(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect(received).toEqual([])
  })

  test('surfaces a socket error on onerror', async () => {
    const { ws, transport } = createTransport()
    const errors: Error[] = []
    transport.onerror = error => {
      errors.push(error)
    }
    await transport.start()

    ws.emit('error', {})

    expect(errors.length).toBe(1)
    expect(errors[0]?.message).toBe('WebSocket error')
  })

  test('rejects a send once the socket is no longer open', async () => {
    const { ws, transport } = createTransport()
    await transport.start()
    ws.readyState = WS_CLOSED

    expect(transport.send(REQUEST)).rejects.toThrow(
      'WebSocket is not open. Cannot send message.',
    )
  })

  test('refuses to start while the socket is still connecting', async () => {
    const ws = new FakeWebSocket()
    ws.readyState = WS_CONNECTING
    const transport = new WebSocketTransport(ws)

    // `start()` awaits the open handshake; resolve it, but leave the socket
    // in a non-open state so the readiness guard is what trips.
    ws.emit('open', {})
    ws.readyState = WS_CLOSED

    expect(transport.start()).rejects.toThrow(
      'WebSocket is not open. Cannot start transport.',
    )
  })
})
