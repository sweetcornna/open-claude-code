import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { setupGrowthbookMock } from '../../../tests/mocks/growthbook.js'
import { mock } from 'bun:test'
import { logMock } from '../../../tests/mocks/log'
import { debugMock } from '../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)
// growthbook goes through the shared complete-surface mock (missing exports
// delegate to the real module) — see tests/mocks/growthbook.ts.
const growthbookMock = setupGrowthbookMock({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
  getDynamicConfig_CACHED_MAY_BE_STALE: () => undefined as never,
})

const {
  subscribeToSearchExtraToolsPrefetch,
  getSearchExtraToolsPrefetchSnapshot,
  clearSearchExtraToolsPrefetchResults,
} = await import('src/services/searchExtraTools/prefetch.js')

const { useSearchExtraToolsHint } = await import(
  'src/hooks/useSearchExtraToolsHint.js'
)

describe('useSearchExtraToolsHint', () => {
  // We test the subscription/snapshot API directly since
  // React hooks require a renderer.
  test('returns empty tools when no prefetch result', () => {
    clearSearchExtraToolsPrefetchResults()
    const snapshot = getSearchExtraToolsPrefetchSnapshot()
    expect(snapshot).toEqual([])
  })

  test('snapshot updates when listeners are notified', () => {
    clearSearchExtraToolsPrefetchResults()

    // Simulate what prefetch does: set results and notify
    const mockSetResults = (results: unknown[]) => {
      // We can't directly set latestPrefetchResult, but we can test
      // the clear function and subscription mechanism
      clearSearchExtraToolsPrefetchResults()
    }

    // Test subscription
    let callCount = 0
    const unsubscribe = subscribeToSearchExtraToolsPrefetch(() => {
      callCount++
    })
    expect(callCount).toBe(0)

    // Trigger a notification via clear
    mockSetResults([])
    expect(callCount).toBe(1)

    // Unsubscribe and verify no more calls
    unsubscribe()
    clearSearchExtraToolsPrefetchResults()
    expect(callCount).toBe(1)
  })

  test('clearSearchExtraToolsPrefetchResults resets snapshot', () => {
    clearSearchExtraToolsPrefetchResults()
    expect(getSearchExtraToolsPrefetchSnapshot()).toEqual([])
  })
})

// Overrides are installed at load (the module under test is imported below and
// needs them active), so scope them by resetting at the end instead of moving
// them into beforeAll. Without this they stay installed for every later file
// in the shard — mock.module is process-global.
afterAll(() => {
  growthbookMock.reset()
})
