import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

import { setupConfigMock } from '../../../../tests/mocks/config.js'
import { purgeCachedRemoteGates } from '../cachedGatePurge.js'

/**
 * The purge runs on every startup with no "already done" flag, so the property
 * that matters is that it writes exactly once: a second run on an
 * already-clean config must be a pure read. Otherwise every launch rewrites
 * ~/.occ.json for no reason.
 */

type FakeConfig = Record<string, unknown>

let fakeConfig: FakeConfig
let writes = 0

const configMock = setupConfigMock()

function installConfig(initial: FakeConfig): void {
  fakeConfig = initial
  writes = 0
  configMock.set({
    getGlobalConfig: () =>
      fakeConfig as unknown as ReturnType<
        typeof import('src/utils/config/config.js').getGlobalConfig
      >,
    saveGlobalConfig: ((updater: (c: FakeConfig) => FakeConfig) => {
      writes++
      fakeConfig = updater(fakeConfig)
    }) as unknown as typeof import('src/utils/config/config.js').saveGlobalConfig,
  })
}

beforeEach(() => {
  installConfig({ cachedStatsigGates: {} })
})

afterAll(() => {
  configMock.reset()
})

describe('purgeCachedRemoteGates', () => {
  test('removes a cached GrowthBook payload', () => {
    installConfig({
      cachedGrowthBookFeatures: { tengu_cobalt_raccoon: true },
      cachedStatsigGates: {},
      theme: 'dark',
    })

    expect(purgeCachedRemoteGates()).toBe(true)
    expect(fakeConfig.cachedGrowthBookFeatures).toBeUndefined()
    expect(writes).toBe(1)
    // Unrelated settings are untouched — this is a targeted delete, not a reset.
    expect(fakeConfig.theme).toBe('dark')
  })

  test('empties the Statsig cache the migration readers still consult', () => {
    installConfig({ cachedStatsigGates: { tengu_some_gate: true } })

    expect(purgeCachedRemoteGates()).toBe(true)
    expect(fakeConfig.cachedStatsigGates).toEqual({})
  })

  test('is a pure read once there is nothing left to purge', () => {
    installConfig({
      cachedGrowthBookFeatures: { tengu_cobalt_raccoon: true },
      cachedStatsigGates: { tengu_some_gate: true },
    })

    expect(purgeCachedRemoteGates()).toBe(true)
    expect(purgeCachedRemoteGates()).toBe(false)
    expect(purgeCachedRemoteGates()).toBe(false)
    expect(writes).toBe(1)
  })

  test('does nothing on a config that never held a payload', () => {
    installConfig({ cachedStatsigGates: {} })

    expect(purgeCachedRemoteGates()).toBe(false)
    expect(writes).toBe(0)
  })

  test('degrades quietly when the config system is not up yet', () => {
    // getGlobalConfig() throws until enableConfigs() has run; init.ts calls the
    // purge right after, but the ordering must not be load-bearing.
    configMock.set({
      getGlobalConfig: () => {
        throw new Error('Config is not enabled')
      },
    })

    expect(purgeCachedRemoteGates()).toBe(false)
  })
})
