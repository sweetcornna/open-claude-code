import { describe, expect, test } from 'bun:test'
import {
  CREDENTIAL_REFRESH_BUFFER_MS,
  CREDENTIAL_REFRESH_BUSY_RETRY_MS,
  CREDENTIAL_REFRESH_FAILURE_RETRY_MS,
  CREDENTIAL_REFRESH_MIN_DELAY_MS,
  MAX_CREDENTIAL_REFRESH_FAILURES,
  computeCredentialRefreshDelayMs,
  createCredentialRotationScheduler,
} from '../credentialRotation.js'

/**
 * Deterministic clock + timer queue. The scheduler takes both as deps, so
 * nothing here touches real time and the whole file runs in microseconds.
 */
function createFakeClock() {
  let nowMs = 1_000_000
  let nextId = 1
  const pending = new Map<number, { at: number; fn: () => void }>()

  return {
    now: () => nowMs,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++
      pending.set(id, { at: nowMs + ms, fn })
      return id as unknown as { readonly __timer?: never }
    },
    clearTimer: (timer: { readonly __timer?: never }) => {
      pending.delete(timer as unknown as number)
    },
    get pendingCount() {
      return pending.size
    },
    /** Delay of the single armed timer, relative to now. */
    nextDelay(): number {
      const entries = [...pending.values()]
      if (entries.length !== 1) {
        throw new Error(`expected exactly 1 timer, found ${entries.length}`)
      }
      return entries[0]!.at - nowMs
    },
    /** Advance to the next timer and run it. */
    async fire(): Promise<void> {
      const entries = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)
      const next = entries[0]
      if (!next) throw new Error('no timer armed')
      pending.delete(next[0])
      nowMs = next[1].at
      next[1].fn()
      // Let the async rotate() body settle.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    },
    advance(ms: number) {
      nowMs += ms
    },
  }
}

type Harness = ReturnType<typeof createHarness>

function createHarness(
  options: {
    ttlMs?: number
    /** false → the swap is blocked and the scheduler must retry. */
    rotateResult?: () => boolean
    /** false → refresh does not mint a new token. */
    refreshWorks?: () => boolean
  } = {},
) {
  const clock = createFakeClock()
  const ttlMs = options.ttlMs ?? 15 * 60 * 1000
  const refreshWorks = options.refreshWorks ?? (() => true)

  let tokenSeq = 0
  let token = `token-${tokenSeq}`
  let expiry = clock.now() + ttlMs
  const rotations: string[] = []
  const refreshedWith: string[] = []
  const logs: string[] = []
  let stopped = false
  let refreshThrows = false

  const scheduler = createCredentialRotationScheduler({
    getAccessToken: () => token,
    getAccessTokenExpiry: () => expiry,
    refreshAccessToken: async (stale: string) => {
      refreshedWith.push(stale)
      if (refreshThrows) throw new Error('refresh exploded')
      if (!refreshWorks()) return
      tokenSeq++
      token = `token-${tokenSeq}`
      expiry = clock.now() + ttlMs
    },
    rotateTransport: () => {
      const ok = options.rotateResult?.() ?? true
      if (ok) rotations.push(token)
      return ok
    },
    isStopped: () => stopped,
    log: message => logs.push(message),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })

  return {
    clock,
    scheduler,
    rotations,
    refreshedWith,
    logs,
    get token() {
      return token
    },
    stop: () => {
      stopped = true
    },
    makeRefreshThrow: () => {
      refreshThrows = true
    },
    setExpiry: (at: number) => {
      expiry = at
    },
  }
}

describe('computeCredentialRefreshDelayMs', () => {
  test('a 15-minute token rotates one buffer ahead of expiry', () => {
    const now = 0
    const expiry = 15 * 60 * 1000
    expect(computeCredentialRefreshDelayMs(expiry, now)).toBe(
      expiry - CREDENTIAL_REFRESH_BUFFER_MS,
    )
  })

  // The reason the halving rule exists: without it a token whose whole life
  // is shorter than the buffer computes a negative delay, clamps to the
  // floor, and re-fires every few seconds for the life of the session.
  test('a token shorter-lived than the buffer rotates at its midpoint', () => {
    const ttl = 60 * 1000
    expect(computeCredentialRefreshDelayMs(ttl, 0)).toBe(ttl / 2)
  })

  test('never returns less than the floor, even past expiry', () => {
    expect(computeCredentialRefreshDelayMs(-10_000, 0)).toBe(
      CREDENTIAL_REFRESH_MIN_DELAY_MS,
    )
    expect(computeCredentialRefreshDelayMs(1_000, 0)).toBe(
      CREDENTIAL_REFRESH_MIN_DELAY_MS,
    )
  })
})

describe('credential rotation scheduler', () => {
  test('rotates before expiry and re-arms from the new token', async () => {
    const h = createHarness()
    h.scheduler.schedule()

    expect(h.clock.nextDelay()).toBe(
      15 * 60 * 1000 - CREDENTIAL_REFRESH_BUFFER_MS,
    )
    await h.clock.fire()

    expect(h.refreshedWith).toEqual(['token-0'])
    expect(h.rotations).toEqual(['token-1'])
    // Re-armed against the refreshed token's expiry, not the old one.
    expect(h.clock.nextDelay()).toBe(
      15 * 60 * 1000 - CREDENTIAL_REFRESH_BUFFER_MS,
    )
  })

  test('keeps rotating across many token lifetimes', async () => {
    const h = createHarness()
    h.scheduler.schedule()
    for (let i = 0; i < 5; i++) await h.clock.fire()
    expect(h.rotations).toEqual([
      'token-1',
      'token-2',
      'token-3',
      'token-4',
      'token-5',
    ])
  })

  // A history flush in flight owns the queue; swapping under it would strand
  // the flush. The rotation must be deferred, never skipped.
  test('retries on the busy interval when the swap is blocked', async () => {
    let blocked = true
    const h = createHarness({ rotateResult: () => !blocked })
    h.scheduler.schedule()

    await h.clock.fire()
    expect(h.rotations).toEqual([])
    expect(h.clock.nextDelay()).toBe(CREDENTIAL_REFRESH_BUSY_RETRY_MS)

    blocked = false
    await h.clock.fire()
    expect(h.rotations).toEqual(['token-2'])
  })

  test('backs off, then stands down, when refresh mints nothing new', async () => {
    const h = createHarness({ refreshWorks: () => false })
    h.scheduler.schedule()

    await h.clock.fire()
    expect(h.clock.nextDelay()).toBe(CREDENTIAL_REFRESH_FAILURE_RETRY_MS)
    await h.clock.fire()
    expect(h.clock.nextDelay()).toBe(CREDENTIAL_REFRESH_FAILURE_RETRY_MS)

    // Third strike: stop scheduling and let the transport-close path, which
    // re-registers the environment, own recovery instead of hammering refresh.
    await h.clock.fire()
    expect(h.clock.pendingCount).toBe(0)
    expect(h.rotations).toEqual([])
    expect(h.logs.filter(l => l.includes('no newer token')).length).toBe(
      MAX_CREDENTIAL_REFRESH_FAILURES,
    )
  })

  test('a throwing refresh is logged and counted, not propagated', async () => {
    const h = createHarness()
    h.makeRefreshThrow()
    h.scheduler.schedule()

    await h.clock.fire()
    expect(h.logs.some(l => l.includes('refresh exploded'))).toBe(true)
    expect(h.rotations).toEqual([])
    expect(h.clock.nextDelay()).toBe(CREDENTIAL_REFRESH_FAILURE_RETRY_MS)
  })

  test('a failure streak resets once a refresh succeeds', async () => {
    let working = false
    const h = createHarness({ refreshWorks: () => working })
    h.scheduler.schedule()

    await h.clock.fire()
    await h.clock.fire()
    working = true
    await h.clock.fire()
    expect(h.rotations).toEqual(['token-1'])

    // Budget restored: two more failures must not stand the scheduler down.
    working = false
    await h.clock.fire()
    await h.clock.fire()
    expect(h.clock.pendingCount).toBe(1)
  })

  test('no expiry means no timer at all', () => {
    const h = createHarness()
    h.setExpiry(0)
    h.scheduler.schedule()
    expect(h.clock.pendingCount).toBe(0)
  })

  test('cancel disarms, and a stopped bridge never re-arms', async () => {
    const h = createHarness()
    h.scheduler.schedule()
    h.scheduler.cancel()
    expect(h.clock.pendingCount).toBe(0)

    h.scheduler.schedule()
    expect(h.clock.pendingCount).toBe(1)
    h.stop()
    await h.clock.fire()
    expect(h.refreshedWith).toEqual([])
    expect(h.clock.pendingCount).toBe(0)
  })

  test('schedule() is idempotent — never leaves two timers armed', () => {
    const h = createHarness()
    h.scheduler.schedule()
    h.scheduler.schedule()
    h.scheduler.schedule()
    expect(h.clock.pendingCount).toBe(1)
  })

  test('a token already inside its buffer rotates at the floor, not instantly', () => {
    const h: Harness = createHarness()
    h.setExpiry(h.clock.now() + 1_000)
    h.scheduler.schedule()
    expect(h.clock.nextDelay()).toBe(CREDENTIAL_REFRESH_MIN_DELAY_MS)
  })
})
