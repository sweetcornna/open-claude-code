import { describe, expect, test } from 'bun:test'
import {
  FORCED_GC_COOLDOWN_MS,
  FORCED_GC_RSS_THRESHOLD,
  shouldForceGc,
} from 'src/cli/headlessGc.js'

const MB = 1024 * 1024

describe('shouldForceGc', () => {
  test('does not force a GC below the threshold', () => {
    expect(shouldForceGc(400 * MB, 1_000, undefined)).toBe(false)
    expect(shouldForceGc(FORCED_GC_RSS_THRESHOLD, 1_000, undefined)).toBe(false)
  })

  test('does not force a GC at the ~682MB baseline from the memory analysis', () => {
    // docs/memory-peak-analysis.md: the process RSS baseline is ~682MB, which
    // the old 350MB threshold sat below — forcing a major GC on every tick.
    expect(shouldForceGc(682 * MB, 1_000, undefined)).toBe(false)
  })

  test('forces a GC above the threshold when none has run yet', () => {
    expect(shouldForceGc(FORCED_GC_RSS_THRESHOLD + 1, 1_000, undefined)).toBe(
      true,
    )
    expect(shouldForceGc(1_800 * MB, 1_000, undefined)).toBe(true)
  })

  test('forces a GC above the threshold once the cooldown has elapsed', () => {
    const last = 100_000
    expect(shouldForceGc(1_800 * MB, last + FORCED_GC_COOLDOWN_MS, last)).toBe(
      true,
    )
    expect(
      shouldForceGc(1_800 * MB, last + FORCED_GC_COOLDOWN_MS + 1, last),
    ).toBe(true)
  })

  test('does not force a GC above the threshold within the cooldown', () => {
    const last = 100_000
    expect(shouldForceGc(1_800 * MB, last + 1_000, last)).toBe(false)
    expect(
      shouldForceGc(1_800 * MB, last + FORCED_GC_COOLDOWN_MS - 1, last),
    ).toBe(false)
  })

  test('threshold sits above the documented baseline', () => {
    expect(FORCED_GC_RSS_THRESHOLD).toBeGreaterThan(682 * MB)
  })
})
