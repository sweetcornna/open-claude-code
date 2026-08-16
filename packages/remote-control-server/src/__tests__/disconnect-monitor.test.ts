import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { setupRcsConfigMock } from '../../../../tests/mocks/rcsConfig.js'

const mockConfig = {
  port: 3000,
  host: '0.0.0.0',
  apiKeys: ['test-api-key'],
  baseUrl: 'http://localhost:3000',
  pollTimeout: 8,
  heartbeatInterval: 20,
  jwtExpiresIn: 3600,
  disconnectTimeout: 300,
  webCorsOrigins: [],
  wsIdleTimeout: 30,
  wsKeepaliveInterval: 20,
}
const configMock = setupRcsConfigMock()

import {
  clearDatabasePathOverride,
  setDatabasePathForTests,
} from '../db/database'

beforeAll(() => {
  configMock.set(mockConfig)
  setDatabasePathForTests(':memory:')
})
afterAll(() => {
  clearDatabasePathOverride()
  configMock.reset()
})

import {
  storeReset,
  storeCreateEnvironment,
  storeUpdateEnvironment,
  storeCreateSession,
  storeUpdateSession,
  storeGetEnvironment,
  storeGetSession,
} from '../store'
import {
  getEventBus,
  getAllEventBuses,
  removeEventBus,
} from '../transport/event-bus'
import { runDisconnectMonitorSweep } from '../services/disconnect-monitor'
import { publishSessionEvent } from '../services/transport'

describe('Disconnect Monitor Logic', () => {
  beforeEach(() => {
    storeReset()
    for (const [key] of getAllEventBuses()) {
      removeEventBus(key)
    }
  })

  test('environment times out when lastPollAt is too old', () => {
    const env = storeCreateEnvironment({ secret: 's' })
    const timeoutMs = 300 * 1000 // 5 minutes

    // Simulate lastPollAt being 6 minutes ago
    const oldDate = new Date(Date.now() - timeoutMs - 60000)
    storeUpdateEnvironment(env.id, { lastPollAt: oldDate })

    runDisconnectMonitorSweep()

    const updated = storeGetEnvironment(env.id)
    expect(updated?.status).toBe('disconnected')
  })

  test('environment stays active when lastPollAt is recent', () => {
    const env = storeCreateEnvironment({ secret: 's' })
    runDisconnectMonitorSweep()

    const updated = storeGetEnvironment(env.id)
    expect(updated?.status).toBe('active')
  })

  test('session becomes inactive when updatedAt is too old', () => {
    const session = storeCreateSession({})
    storeUpdateSession(session.id, { status: 'running' })
    const rec = storeGetSession(session.id)
    expect(rec).toBeTruthy()
    if (!rec) return

    storeUpdateSession(session.id, {
      updatedAt: new Date(Date.now() - 300 * 1000 * 2 - 60000),
    })

    runDisconnectMonitorSweep()

    const updated = storeGetSession(session.id)
    expect(updated?.status).toBe('inactive')
  })

  test('session events refresh activity before the timeout sweep', () => {
    const session = storeCreateSession({})
    storeUpdateSession(session.id, { status: 'running' })
    const rec = storeGetSession(session.id)
    expect(rec).toBeTruthy()
    if (!rec) return

    const staleTimestamp = Date.now() - 300 * 1000 * 2 - 60000
    storeUpdateSession(session.id, { updatedAt: new Date(staleTimestamp) })
    publishSessionEvent(
      session.id,
      'assistant',
      { content: 'still active' },
      'inbound',
    )

    runDisconnectMonitorSweep()

    const updated = storeGetSession(session.id)
    expect(updated?.status).toBe('running')
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(staleTimestamp)
  })

  test('session stays running when recently updated', () => {
    const session = storeCreateSession({})
    storeUpdateSession(session.id, { status: 'running' })

    runDisconnectMonitorSweep()

    const updated = storeGetSession(session.id)
    expect(updated?.status).toBe('running')
  })

  test('session timeout publishes an inactive session_status event', () => {
    const session = storeCreateSession({})
    storeUpdateSession(session.id, { status: 'idle' })
    const rec = storeGetSession(session.id)
    expect(rec).toBeTruthy()
    if (!rec) return
    storeUpdateSession(session.id, {
      updatedAt: new Date(Date.now() - 300 * 1000 * 2 - 60000),
    })

    const bus = getEventBus(session.id)
    const events: Array<{ type: string; payload: { status?: string } }> = []
    bus.subscribe(event => {
      events.push({
        type: event.type,
        payload: event.payload as { status?: string },
      })
    })

    runDisconnectMonitorSweep()

    expect(events).toContainEqual({
      type: 'session_status',
      payload: { status: 'inactive' },
    })
  })
})
