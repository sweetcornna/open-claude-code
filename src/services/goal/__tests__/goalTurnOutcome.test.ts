/**
 * Regression tests for the transient-failure path of the goal loop.
 *
 * The bug these pin down: a single `API Error: fetch failed` used to pause an
 * active goal outright, and nothing ever un-paused it. Reproduced from a real
 * transcript where a goal set at 09:05 was auto-paused at 10:15 on one network
 * blip and stayed paused for the remaining five hours of the session.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

import { logMock } from '../../../../tests/mocks/log.js'
mock.module('src/utils/telemetry/log.ts', logMock)

import {
  _clearAllGoalsForTesting,
  getContinuationDelayMs,
  getGoal,
  pauseGoal,
  setGoal,
  TRANSIENT_ERROR_PAUSE_THRESHOLD,
} from '../goalState.js'
import {
  classifyGoalFailure,
  formatGoalOutcomeNotice,
  recordGoalApiFailure,
  recordGoalApiSuccess,
} from '../goalTurnOutcome.js'
import { isGoalPresent } from '../goalPresence.js'

beforeEach(() => {
  _clearAllGoalsForTesting()
})

// The goal map drives a process-global presence flag that isDeferredTool reads;
// leaving a goal behind would make GoalTool non-deferred for every test file
// that runs after this one.
afterAll(() => {
  _clearAllGoalsForTesting()
})

describe('classifyGoalFailure', () => {
  test('recognises the network failures seen in real transcripts', () => {
    expect(classifyGoalFailure('API Error: fetch failed')).toBe('transient')
    expect(classifyGoalFailure('API Error: terminated')).toBe('transient')
    expect(classifyGoalFailure('Connection error.')).toBe('transient')
    expect(classifyGoalFailure('read ECONNRESET')).toBe('transient')
  })

  test('prefers the structured error field over text matching', () => {
    // Body reads like a network hiccup, but the provider already told us it
    // was quota — retrying on a 10s backoff would be pointless.
    expect(
      classifyGoalFailure('please retry your connection', 'rate_limit'),
    ).toBe('usage-limit')
    expect(classifyGoalFailure('boom', 'authentication_failed')).toBe('fatal')
    expect(classifyGoalFailure('boom', 'server_error')).toBe('transient')
  })

  test('leaves non-connectivity failures out of the error budget', () => {
    expect(classifyGoalFailure('API Error: 400 invalid tool input')).toBe(
      'benign',
    )
  })
})

describe('recordGoalApiFailure — transient streak', () => {
  test('a single connection error does NOT pause the goal', () => {
    setGoal('reverse engineer until it builds')

    const notice = recordGoalApiFailure('API Error: fetch failed')

    expect(getGoal()?.status).toBe('active')
    expect(getGoal()?.consecutiveErrors).toBe(1)
    expect(notice).toEqual({ kind: 'retrying', attempt: 1, delayMs: 10_000 })
  })

  test('backoff widens with the streak', () => {
    setGoal('objective')

    recordGoalApiFailure('API Error: fetch failed')
    expect(getContinuationDelayMs(getGoal()!)).toBe(10_000)

    recordGoalApiFailure('API Error: fetch failed')
    expect(getContinuationDelayMs(getGoal()!)).toBe(30_000)
  })

  test(`pauses only on failure #${TRANSIENT_ERROR_PAUSE_THRESHOLD}`, () => {
    setGoal('objective')

    for (let i = 1; i < TRANSIENT_ERROR_PAUSE_THRESHOLD; i++) {
      recordGoalApiFailure('API Error: fetch failed')
      expect(getGoal()?.status).toBe('active')
    }

    const notice = recordGoalApiFailure('API Error: fetch failed')
    expect(getGoal()?.status).toBe('paused')
    expect(getGoal()?.pauseReason).toBe('transient-error')
    expect(notice).toEqual({ kind: 'paused-transient' })
  })

  test('a success mid-streak clears the counter', () => {
    setGoal('objective')
    recordGoalApiFailure('API Error: fetch failed')
    recordGoalApiFailure('API Error: fetch failed')

    recordGoalApiSuccess()

    expect(getGoal()?.consecutiveErrors).toBe(0)
    expect(getContinuationDelayMs(getGoal()!)).toBe(0)
  })
})

describe('recordGoalApiSuccess — recovery', () => {
  test('revives a goal the network paused', () => {
    setGoal('objective')
    for (let i = 0; i < TRANSIENT_ERROR_PAUSE_THRESHOLD; i++) {
      recordGoalApiFailure('API Error: fetch failed')
    }
    expect(getGoal()?.status).toBe('paused')

    const notice = recordGoalApiSuccess()

    expect(getGoal()?.status).toBe('active')
    expect(getGoal()?.pauseReason).toBeNull()
    expect(notice).toEqual({ kind: 'auto-resumed' })
  })

  test('never overrides a pause the user asked for', () => {
    setGoal('objective')
    pauseGoal()
    expect(getGoal()?.pauseReason).toBe('user')

    expect(recordGoalApiSuccess()).toBeNull()
    expect(getGoal()?.status).toBe('paused')
  })

  test('never overrides a fatal pause — auth needs the user, not a retry', () => {
    setGoal('objective')
    recordGoalApiFailure('API Error: 401 invalid api key')
    expect(getGoal()?.pauseReason).toBe('fatal-error')

    expect(recordGoalApiSuccess()).toBeNull()
    expect(getGoal()?.status).toBe('paused')
  })

  test('is a no-op on a healthy goal (no spurious transcript writes)', () => {
    setGoal('objective')
    expect(recordGoalApiSuccess()).toBeNull()
  })
})

describe('usage limits', () => {
  test('stop the loop immediately instead of spending the error budget', () => {
    setGoal('objective')

    const notice = recordGoalApiFailure('Claude usage limit reached')

    expect(getGoal()?.status).toBe('usage_limited')
    expect(notice).toEqual({ kind: 'usage-limited' })
  })

  test('lift once the provider answers again', () => {
    setGoal('objective')
    recordGoalApiFailure('Claude usage limit reached')

    expect(recordGoalApiSuccess()).toEqual({ kind: 'auto-resumed' })
    expect(getGoal()?.status).toBe('active')
  })
})

describe('goal presence flag', () => {
  test('tracks set/clear so GoalTool stops being deferred', () => {
    expect(isGoalPresent()).toBe(false)
    setGoal('objective')
    expect(isGoalPresent()).toBe(true)
    _clearAllGoalsForTesting()
    expect(isGoalPresent()).toBe(false)
  })
})

describe('formatGoalOutcomeNotice', () => {
  test('renders each notice and nothing for null', () => {
    expect(
      formatGoalOutcomeNotice({
        kind: 'retrying',
        attempt: 2,
        delayMs: 30_000,
      }),
    ).toContain('Retrying in 30s')
    expect(formatGoalOutcomeNotice({ kind: 'auto-resumed' })).toContain(
      'resumed automatically',
    )
    expect(formatGoalOutcomeNotice(null)).toBeNull()
  })
})
