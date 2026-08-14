/**
 * `settings.enforceAvailableModels` extends the availableModels allowlist to
 * the "Default" tier selection.
 *
 * Both the resolver under test and `isModelAllowed` read settings through
 * `getSettings_DEPRECATED`, so the shared full-surface settings mock drives
 * the table. Reset in afterAll — the override must not outlive this suite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { mock } from 'bun:test'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const settingsMock = setupSettingsMock()

const { getDefaultMainLoopModelSetting } = await import('../model.js')

type Settings = {
  availableModels?: string[]
  enforceAvailableModels?: boolean
}

function withSettings(settings: Settings): void {
  settingsMock.set({ getSettings_DEPRECATED: () => settings })
}

beforeAll(() => {
  // Keep the tier resolution deterministic and off the subscription chain.
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-5'
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5'
})

afterAll(() => {
  settingsMock.reset()
  delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
})

describe('enforceAvailableModels', () => {
  test('is inert when the flag is absent', () => {
    withSettings({ availableModels: ['haiku'] })
    // Without the flag the tier default is handed out unchecked, even though
    // it is not in the allowlist.
    expect(getDefaultMainLoopModelSetting()).not.toContain('haiku')
  })

  test('is inert when availableModels is unset', () => {
    withSettings({ enforceAvailableModels: true })
    const unrestricted = getDefaultMainLoopModelSetting()
    expect(unrestricted).toBeTruthy()
  })

  test('is inert when availableModels is empty', () => {
    withSettings({ enforceAvailableModels: true, availableModels: [] })
    withSettings({ availableModels: [] })
    const withEmpty = getDefaultMainLoopModelSetting()
    withSettings({})
    expect(withEmpty).toBe(getDefaultMainLoopModelSetting())
  })

  test('substitutes the first allowed entry when the default is disallowed', () => {
    withSettings({
      enforceAvailableModels: true,
      availableModels: ['haiku', 'opus'],
    })
    expect(getDefaultMainLoopModelSetting()).toBe('haiku')
  })

  test('ordering of availableModels picks the substitute', () => {
    withSettings({
      enforceAvailableModels: true,
      availableModels: ['opus', 'haiku'],
    })
    expect(getDefaultMainLoopModelSetting()).toBe('opus')
  })

  test('leaves the default alone when it is already allowed', () => {
    withSettings({ availableModels: undefined })
    const tierDefault = getDefaultMainLoopModelSetting()

    withSettings({
      enforceAvailableModels: true,
      availableModels: [tierDefault, 'haiku'],
    })
    expect(getDefaultMainLoopModelSetting()).toBe(tierDefault)
  })

  test('blank allowlist entries are skipped', () => {
    withSettings({
      enforceAvailableModels: true,
      availableModels: ['   ', 'haiku'],
    })
    expect(getDefaultMainLoopModelSetting()).toBe('haiku')
  })
})
