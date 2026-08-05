import { expect, test } from 'bun:test'
import {
  AGENT_RETRY_BACKOFF_MS,
  AGENT_RETRY_JITTER_RATIO,
} from '../constants.js'
import { retryDelayMs } from '../engine/retryBackoff.js'

// Every retry suite injects retryBackoffMs: 0 to stay instant, which makes the growth curve
// invisible to them — a wrong exponent (or a jitter that can double the wait) would keep the
// whole engine suite green. These assert the formula directly, with jitter injected.

test('retryDelayMs doubles per retry (base * 2^(n-1)) with jitter 0', () => {
  expect(retryDelayMs(2_000, 1, 0)).toBe(2_000)
  expect(retryDelayMs(2_000, 2, 0)).toBe(4_000)
  expect(retryDelayMs(2_000, 3, 0)).toBe(8_000)
  expect(retryDelayMs(2_000, 4, 0)).toBe(16_000)
})

test('retryDelayMs adds at most AGENT_RETRY_JITTER_RATIO of the geometric value', () => {
  // jitter = 1 is the ceiling of the [0,1) range Math.random() produces
  expect(retryDelayMs(2_000, 1, 1)).toBe(2_000 * (1 + AGENT_RETRY_JITTER_RATIO))
  expect(retryDelayMs(2_000, 3, 1)).toBe(8_000 * (1 + AGENT_RETRY_JITTER_RATIO))
  // half jitter lands halfway into the band
  expect(retryDelayMs(1_000, 1, 0.5)).toBe(1_125)
})

test('retryDelayMs stays inside [geometric, geometric * (1 + ratio)] for random jitter', () => {
  for (let retryNo = 1; retryNo <= 4; retryNo++) {
    const geometric = AGENT_RETRY_BACKOFF_MS * 2 ** (retryNo - 1)
    for (let i = 0; i < 200; i++) {
      const d = retryDelayMs(AGENT_RETRY_BACKOFF_MS, retryNo)
      expect(d).toBeGreaterThanOrEqual(geometric)
      expect(d).toBeLessThanOrEqual(
        Math.round(geometric * (1 + AGENT_RETRY_JITTER_RATIO)),
      )
    }
  }
})

test('retryDelayMs(0, …) is always 0 (tests disable the wait; jitter must not resurrect it)', () => {
  expect(retryDelayMs(0, 1, 0.99)).toBe(0)
  expect(retryDelayMs(0, 5, 0.99)).toBe(0)
  // negative base is treated as disabled rather than producing a negative timeout
  expect(retryDelayMs(-100, 2, 0.5)).toBe(0)
})

test('the full default retry chain stays in the tens of seconds, not minutes', () => {
  // Guards the interaction with the API transport's own retry budget: the two multiply,
  // so the engine-side worst case must remain small enough to stay debuggable.
  const worstCase = [1, 2, 3].reduce(
    (sum, n) => sum + retryDelayMs(AGENT_RETRY_BACKOFF_MS, n, 1),
    0,
  )
  expect(worstCase).toBeLessThanOrEqual(20_000)
})
