import { describe, expect, mock, test } from 'bun:test'
import type { FeatureGateHost } from '../featureGate.js'

async function loadFacade() {
  return import(`../featureGate.ts?case=${Math.random()}`)
}

describe('featureGate facade', () => {
  test('returns default values when no host is registered', async () => {
    const facade = await loadFacade()

    expect(
      facade.getFeatureValue_CACHED_MAY_BE_STALE('test_gate', false),
    ).toBeFalse()
    expect(
      facade.getFeatureValue_CACHED_WITH_REFRESH('test_gate', 'default', 1000),
    ).toBe('default')
  })

  test('delegates feature reads to the registered host', async () => {
    const facade = await loadFacade()
    const stale = mock(
      <T>(_feature: string, defaultValue: T): T => defaultValue,
    )
    const refresh = mock(
      <T>(_feature: string, defaultValue: T, _refreshIntervalMs: number): T =>
        defaultValue,
    )
    const host = {
      getFeatureValue_CACHED_MAY_BE_STALE: stale,
      getFeatureValue_CACHED_WITH_REFRESH: refresh,
    } satisfies FeatureGateHost

    facade.registerFeatureGateHost(host)

    expect(
      facade.getFeatureValue_CACHED_MAY_BE_STALE('stale_gate', true),
    ).toBeTrue()
    expect(
      facade.getFeatureValue_CACHED_WITH_REFRESH('refresh_gate', 7, 5000),
    ).toBe(7)
    expect(stale).toHaveBeenCalledWith('stale_gate', true)
    expect(refresh).toHaveBeenCalledWith('refresh_gate', 7, 5000)
  })
})
