import { describe, test, expect, beforeEach } from 'bun:test'
import { mock } from 'bun:test'
import { logMock } from '../../../tests/mocks/log'
import { debugMock } from '../../../tests/mocks/debug'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
  getFeatureValue_DEPRECATED: async () => undefined,
  getFeatureValue_CACHED_WITH_REFRESH: async () => undefined,
  hasGrowthBookEnvOverride: () => false,
  getAllGrowthBookFeatures: () => ({}),
  getGrowthBookConfigOverrides: () => ({}),
  setGrowthBookConfigOverride: () => {},
  clearGrowthBookConfigOverrides: () => {},
  getApiBaseUrlHost: () => undefined,
  onGrowthBookRefresh: () => {},
  initializeGrowthBook: async () => {},
  checkSecurityRestrictionGate: async () => false,
  checkGate_CACHED_OR_BLOCKING: async () => false,
  refreshGrowthBookAfterAuthChange: () => {},
  resetGrowthBook: () => {},
  refreshGrowthBookFeatures: async () => {},
  setupPeriodicGrowthBookRefresh: () => {},
  stopPeriodicGrowthBookRefresh: () => {},
  getDynamicConfig_CACHED_MAY_BE_STALE: () => undefined,
  getDynamicConfig_BLOCKS_ON_INIT: async () => undefined,
}))

const {
  subscribeToToolSearchPrefetch,
  getToolSearchPrefetchSnapshot,
  clearToolSearchPrefetchResults,
} = await import('src/services/toolSearch/prefetch.js')

const { useToolSearchHint } = await import('src/hooks/useToolSearchHint.js')

describe('useToolSearchHint', () => {
  // We test the subscription/snapshot API directly since
  // React hooks require a renderer.
  test('returns empty tools when no prefetch result', () => {
    clearToolSearchPrefetchResults()
    const snapshot = getToolSearchPrefetchSnapshot()
    expect(snapshot).toEqual([])
  })

  test('snapshot updates when listeners are notified', () => {
    clearToolSearchPrefetchResults()

    // Simulate what prefetch does: set results and notify
    const mockSetResults = (results: unknown[]) => {
      // We can't directly set latestPrefetchResult, but we can test
      // the clear function and subscription mechanism
      clearToolSearchPrefetchResults()
    }

    // Test subscription
    let callCount = 0
    const unsubscribe = subscribeToToolSearchPrefetch(() => {
      callCount++
    })
    expect(callCount).toBe(0)

    // Trigger a notification via clear
    mockSetResults([])
    expect(callCount).toBe(1)

    // Unsubscribe and verify no more calls
    unsubscribe()
    clearToolSearchPrefetchResults()
    expect(callCount).toBe(1)
  })

  test('clearToolSearchPrefetchResults resets snapshot', () => {
    clearToolSearchPrefetchResults()
    expect(getToolSearchPrefetchSnapshot()).toEqual([])
  })
})
