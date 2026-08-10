import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { debugMock } from '../../../tests/mocks/debug.js'
import { logMock } from '../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readonly sent: string[] = []
  closeCalls = 0
  pingCalls = 0
  private listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(_url: string, _options?: unknown) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  close(): void {
    this.closeCalls++
  }

  send(data: string): void {
    this.sent.push(data)
  }

  ping(): void {
    this.pingCalls++
  }
}

const originalWebSocket = globalThis.WebSocket
let SessionsWebSocket: typeof import('../SessionsWebSocket.js').SessionsWebSocket
let client: InstanceType<typeof SessionsWebSocket> | undefined

beforeAll(async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  ;({ SessionsWebSocket } = await import('../SessionsWebSocket.js'))
})

beforeEach(() => {
  FakeWebSocket.instances = []
  client = undefined
})

afterEach(() => {
  client?.close()
})

afterAll(() => {
  globalThis.WebSocket = originalWebSocket
})

describe('SessionsWebSocket connection generations', () => {
  test('ignores delayed events from a replaced socket', async () => {
    const messages: unknown[] = []
    let connected = 0
    let errors = 0
    let closes = 0
    let reconnects = 0
    client = new SessionsWebSocket('session-1', 'org-1', () => 'token', {
      onMessage: message => messages.push(message),
      onConnected: () => connected++,
      onError: () => errors++,
      onClose: () => closes++,
      onReconnecting: () => reconnects++,
    })

    await client.connect()
    const oldSocket = FakeWebSocket.instances[0]!
    oldSocket.emit('open')
    expect(client.isConnected()).toBe(true)

    client.reconnect()
    await new Promise<void>(resolve => setTimeout(resolve, 550))
    const replacement = FakeWebSocket.instances[1]!
    replacement.emit('open')
    expect(client.isConnected()).toBe(true)

    oldSocket.emit('open')
    oldSocket.emit('message', {
      data: JSON.stringify({ type: 'assistant', message: { content: [] } }),
    })
    oldSocket.emit('error', new Error('delayed old error'))
    oldSocket.emit('pong')
    oldSocket.emit('close', { code: 1006, reason: 'delayed old close' })

    expect(client.isConnected()).toBe(true)
    expect(connected).toBe(2)
    expect(messages).toEqual([])
    expect(errors).toBe(0)
    expect(closes).toBe(0)
    expect(reconnects).toBe(0)

    replacement.emit('message', {
      data: JSON.stringify({ type: 'assistant', message: { content: [] } }),
    })
    client.sendControlRequest({ subtype: 'interrupt' })

    expect(messages).toHaveLength(1)
    expect(oldSocket.sent).toEqual([])
    expect(replacement.sent).toHaveLength(1)
  })
})
