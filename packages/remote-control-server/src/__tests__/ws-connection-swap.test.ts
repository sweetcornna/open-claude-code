import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import type { WSContext } from 'hono/ws'
import { setupRcsConfigMock } from '../../../../tests/mocks/rcsConfig.js'

const swapConfig = {
  port: 3000,
  host: '0.0.0.0',
  apiKeys: [] as string[],
  legacyApiKeyAuth: false,
  tokenPepper: 'test-token-pepper-at-least-32-characters',
  workerJwtSecret: 'test-worker-secret-at-least-32-characters',
  baseUrl: 'http://localhost:3000',
  webCorsOrigins: [] as string[],
  wsKeepaliveInterval: 20,
}
const configMock = setupRcsConfigMock()
beforeAll(() => configMock.set(swapConfig))
afterAll(() => configMock.reset())

import { setDatabasePathForTests } from '../db/database'
import { storeCreateSession, storeReset } from '../store'
import {
  getAllEventBuses,
  getEventBus,
  removeEventBus,
} from '../transport/event-bus'
import {
  closeAllConnections,
  handleWebSocketClose,
  handleWebSocketOpen,
} from '../transport/ws-handler'

beforeAll(() => setDatabasePathForTests(':memory:'))

function createMockWs(): WSContext & { sent: string[]; closes: number[] } {
  const sent: string[] = []
  const closes: number[] = []
  return {
    readyState: 1,
    send: (data: string) => sent.push(data),
    close: (code?: number) => closes.push(code ?? 1000),
    sent,
    closes,
  } as unknown as WSContext & { sent: string[]; closes: number[] }
}

/** Outbound = server → bridge, the direction a bridge socket subscribes to. */
function publishOutbound(sessionId: string, text: string) {
  getEventBus(sessionId).publish({
    id: `evt-${text}`,
    sessionId,
    type: 'user',
    payload: { text },
    direction: 'outbound',
  })
}

describe('credential-rotation connection swap', () => {
  beforeEach(() => {
    configMock.set(swapConfig)
    storeReset()
    for (const [key] of getAllEventBuses()) removeEventBus(key)
    closeAllConnections()
  })

  // A client rotating its access token opens the replacement socket and then
  // closes the old one. handleWebSocketOpen has already re-pointed the
  // session's cleanup entry at the new socket by then, so the late close must
  // not tear that entry down — doing so unsubscribed the live connection and
  // left the session permanently silent while still looking connected.
  test('a late close from the replaced socket leaves the new one subscribed', () => {
    const session = storeCreateSession({})
    const oldWs = createMockWs()
    const newWs = createMockWs()

    handleWebSocketOpen(oldWs, session.id)
    handleWebSocketOpen(newWs, session.id)
    // Old socket's close lands after the swap.
    handleWebSocketClose(oldWs, session.id, 1000, 'rotated')

    publishOutbound(session.id, 'after-rotation')

    expect(newWs.sent.some(m => m.includes('after-rotation'))).toBe(true)
    expect(oldWs.sent.some(m => m.includes('after-rotation'))).toBe(false)
  })

  test('the replaced socket stops receiving as soon as the new one opens', () => {
    const session = storeCreateSession({})
    const oldWs = createMockWs()
    const newWs = createMockWs()

    handleWebSocketOpen(oldWs, session.id)
    handleWebSocketOpen(newWs, session.id)
    publishOutbound(session.id, 'only-for-new')

    expect(oldWs.sent.some(m => m.includes('only-for-new'))).toBe(false)
    expect(newWs.sent.some(m => m.includes('only-for-new'))).toBe(true)
  })

  test('the owning socket closing still tears the entry down', () => {
    const session = storeCreateSession({})
    const ws = createMockWs()

    handleWebSocketOpen(ws, session.id)
    handleWebSocketClose(ws, session.id, 1000, 'done')

    const before = ws.sent.length
    publishOutbound(session.id, 'after-close')
    expect(ws.sent.length).toBe(before)
  })

  // The replacement replays the outbound backlog, so a message published in
  // the gap between the two sockets is delivered rather than lost.
  test('the new socket replays what was published while nothing was attached', () => {
    const session = storeCreateSession({})
    const oldWs = createMockWs()
    handleWebSocketOpen(oldWs, session.id)
    handleWebSocketClose(oldWs, session.id, 4002, 'token_expired')

    publishOutbound(session.id, 'sent-during-gap')

    const newWs = createMockWs()
    handleWebSocketOpen(newWs, session.id)
    expect(newWs.sent.some(m => m.includes('sent-during-gap'))).toBe(true)
  })
})
