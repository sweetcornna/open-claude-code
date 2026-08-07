import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'
import type { SettingsJson } from '../../settings/types.js'

/**
 * The per-tier layer sits between the env override and the built-in provider
 * defaults. These tests pin that ordering, because getting it wrong is
 * invisible: the value simply comes out of the wrong place.
 */

let userSettings: SettingsJson = {}

const settingsMock = setupSettingsMock()
beforeAll(() =>
  settingsMock.set({
    getSettingsForSource: source =>
      source === 'userSettings' ? userSettings : null,
  }),
)
afterAll(() => settingsMock.reset())

const {
  getTierContextTokens,
  getTierEffort,
  hasTierOverride,
  getResolvedTierSettings,
} = await import('../tierSettings.js')

afterEach(() => {
  userSettings = {}
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  delete process.env.CLAUDE_CODE_EFFORT_LEVEL
})

describe('per-tier overrides', () => {
  test('fall back to the provider default when unset', () => {
    expect(getTierEffort('claude-opus-5')).toBe('high')
    expect(getTierContextTokens('claude-sonnet-5')).toBe(200_000)
    expect(getTierEffort('deepseek-v4-pro')).toBe('max')
  })

  test('an override wins over the default, per tier', () => {
    userSettings = {
      modelSettings: { opus: { effort: 'low', contextTokens: 128_000 } },
    } as SettingsJson

    expect(getTierEffort('claude-opus-5')).toBe('low')
    expect(getTierContextTokens('claude-opus-5')).toBe(128_000)
    // A different tier is untouched.
    expect(getTierEffort('claude-sonnet-5')).toBe('high')
    expect(getTierContextTokens('claude-sonnet-5')).toBe(200_000)
  })

  test('one axis can be set without the other', () => {
    userSettings = {
      modelSettings: { haiku: { effort: 'max' } },
    } as SettingsJson

    expect(getTierEffort('claude-haiku-4-5')).toBe('max')
    // context still comes from the default table
    expect(getTierContextTokens('claude-haiku-4-5')).toBe(200_000)
  })

  test('a model that names no tier still gets its family default', () => {
    userSettings = {
      modelSettings: { opus: { effort: 'low' } },
    } as SettingsJson
    // deepseek-v4-pro maps to no tier, so the opus override must not apply.
    expect(getTierEffort('deepseek-v4-pro')).toBe('max')
  })

  test('hasTierOverride reports only explicit configuration', () => {
    expect(hasTierOverride('opus')).toBe(false)
    userSettings = {
      modelSettings: { opus: { effort: 'low' } },
    } as SettingsJson
    expect(hasTierOverride('opus')).toBe(true)
    expect(hasTierOverride('haiku')).toBe(false)
    expect(hasTierOverride(undefined)).toBe(false)
  })

  test('getResolvedTierSettings returns both axes together', () => {
    userSettings = {
      modelSettings: { fable: { contextTokens: 500_000 } },
    } as SettingsJson
    expect(getResolvedTierSettings('claude-fable-5')).toEqual({
      effort: 'high',
      contextTokens: 500_000,
    })
  })
})
