import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../tests/mocks/debug'

mock.module('src/utils/telemetry/debug.ts', debugMock)

const { computeElapsedMs, resetPausedOverflowWarningForTesting } = await import(
  '../useElapsedTime.js'
)

beforeEach(() => {
  resetPausedOverflowWarningForTesting()
})

describe('computeElapsedMs', () => {
  test('subtracts paused time from the wall-clock span', () => {
    expect(computeElapsedMs(1_000, 2_000, 10_000)).toBe(7_000)
  })

  test('leaves the span alone when nothing was paused', () => {
    expect(computeElapsedMs(1_000, 0, 10_000)).toBe(9_000)
  })

  test('ignores pausedMs once it exceeds the whole span', () => {
    // The regression: a runaway paused counter used to clamp to 0, so a task
    // that had been running for 9s rendered as "0s" indefinitely while its
    // token counter kept climbing.
    expect(computeElapsedMs(1_000, 9_000, 10_000)).toBe(9_000)
    expect(computeElapsedMs(1_000, 50_000, 10_000)).toBe(9_000)
  })

  test('treats pausedMs exactly equal to the span as over-accumulated', () => {
    // Zero would be indistinguishable from "just started", which is the
    // ambiguity that made this bug invisible.
    expect(computeElapsedMs(1_000, 9_000, 10_000)).toBe(9_000)
  })

  test('returns 0 for a startTime in the future', () => {
    expect(computeElapsedMs(10_000, 0, 1_000)).toBe(0)
  })

  test('returns 0 rather than NaN when startTime is not a number', () => {
    expect(computeElapsedMs(Number.NaN, 0, 10_000)).toBe(0)
  })

  test('measures against now when no endTime is given', () => {
    const elapsed = computeElapsedMs(Date.now() - 5_000, 0)
    expect(elapsed).toBeGreaterThanOrEqual(5_000)
    expect(elapsed).toBeLessThan(6_000)
  })
})

describe('computeElapsedMs with a monotonic start', () => {
  test('survives the wall clock stepping backwards', () => {
    // The regression this exists for: Windows steps the wall clock back
    // (w32time after resume, WSL2 drift correction, dual-boot RTC). A task
    // stamped before the step gets a startTime in the future, and the reading
    // used to collapse to a permanent "0s" while tokens kept streaming in.
    const startTimeAfterClockWentBack = Date.now() + 60_000
    const monoStart = performance.now() - 5_000

    expect(
      computeElapsedMs(startTimeAfterClockWentBack, 0, undefined, monoStart),
    ).toBeGreaterThanOrEqual(5_000)
  })

  test('prefers the monotonic reading over the wall clock', () => {
    // Wall clock says 100s, monotonic says 5s. The monotonic one wins.
    const elapsed = computeElapsedMs(
      Date.now() - 100_000,
      0,
      undefined,
      performance.now() - 5_000,
    )
    expect(elapsed).toBeGreaterThanOrEqual(5_000)
    expect(elapsed).toBeLessThan(6_000)
  })

  test('endTime still wins, so terminal tasks stay frozen', () => {
    expect(computeElapsedMs(1_000, 0, 10_000, performance.now() - 5_000)).toBe(
      9_000,
    )
  })

  test('still applies the pausedMs guard', () => {
    const elapsed = computeElapsedMs(
      Date.now(),
      999_999,
      undefined,
      performance.now() - 5_000,
    )
    expect(elapsed).toBeGreaterThanOrEqual(5_000)
  })
})
