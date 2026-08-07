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
  formatContextTokens,
  getTierContextTokens,
  getTierEffort,
  hasTierOverride,
  getResolvedTierSettings,
} = await import('../tierSettings.js')

const TIER_ENV = [
  'OPENAI_DEFAULT_HAIKU_MODEL',
  'OPENAI_DEFAULT_SONNET_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'OPENAI_DEFAULT_FABLE_MODEL',
] as const

afterEach(() => {
  userSettings = {}
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  for (const key of TIER_ENV) delete process.env[key]
})

describe('per-tier overrides', () => {
  test('fall back to the provider default when unset', () => {
    expect(getTierEffort('claude-opus-5')).toBe('xhigh')
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
    expect(getTierEffort('claude-sonnet-5')).toBe('xhigh')
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

  test('a model that names no tier and is pinned to none gets its family default', () => {
    userSettings = {
      modelSettings: { opus: { effort: 'low' } },
    } as SettingsJson
    // Nothing connects deepseek-v4-pro to the opus alias, so the override
    // must not apply.
    expect(getTierEffort('deepseek-v4-pro')).toBe('max')
  })

  test('a third-party id pinned to a tier picks up that tier’s override', () => {
    // The whole point of per-tier settings: this is the case where the model
    // id names no tier, which used to make every value below unreachable.
    process.env.OPENAI_DEFAULT_OPUS_MODEL = 'deepseek-v4-pro'
    userSettings = {
      modelSettings: { opus: { effort: 'low', contextTokens: 128_000 } },
    } as SettingsJson

    expect(getTierEffort('deepseek-v4-pro')).toBe('low')
    expect(getTierContextTokens('deepseek-v4-pro')).toBe(128_000)
  })

  test('when several tiers share an id, the configured one wins', () => {
    for (const key of TIER_ENV) process.env[key] = 'deepseek-v4-flash'
    userSettings = {
      modelSettings: { sonnet: { effort: 'low', contextTokens: 272_000 } },
    } as SettingsJson

    // 'fable' is the most capable candidate, but only 'sonnet' was configured.
    expect(getTierEffort('deepseek-v4-flash')).toBe('low')
    expect(getTierContextTokens('deepseek-v4-flash')).toBe(272_000)
  })

  test('when several tiers share an id and none is configured, the default holds', () => {
    for (const key of TIER_ENV) process.env[key] = 'deepseek-v4-flash'
    expect(getTierEffort('deepseek-v4-flash')).toBe('max')
    expect(getTierContextTokens('deepseek-v4-flash')).toBe(1_000_000)
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

  test('formatContextTokens renders the units the pickers show', () => {
    expect(formatContextTokens(1_000_000)).toBe('1M')
    expect(formatContextTokens(1_500_000)).toBe('1.5M')
    expect(formatContextTokens(272_000)).toBe('272k')
    expect(formatContextTokens(900)).toBe('900')
  })

  test('getResolvedTierSettings returns both axes together', () => {
    userSettings = {
      modelSettings: { fable: { contextTokens: 500_000 } },
    } as SettingsJson
    expect(getResolvedTierSettings('claude-fable-5')).toEqual({
      effort: 'xhigh',
      contextTokens: 500_000,
    })
  })
})
