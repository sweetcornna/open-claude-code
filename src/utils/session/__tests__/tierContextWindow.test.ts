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
 * The per-tier arm of getContextWindowForModel.
 *
 * Kept out of contextWindowOverride.test.ts on purpose: that file documents
 * that it only exercises the CLAUDE_CODE_MAX_CONTEXT_TOKENS fast path, because
 * anything deeper reads the developer's real settings.json and the assertion
 * would measure their machine. Here the settings source is mocked through the
 * shared complete-surface helper, so the deeper path is safe to assert.
 */

let userSettings: SettingsJson = {}

const settingsMock = setupSettingsMock()
beforeAll(() =>
  settingsMock.set({
    getSettingsForSource: source =>
      source === 'userSettings' ? userSettings : null,
    getInitialSettings: () => ({}) as SettingsJson,
  }),
)
afterAll(() => settingsMock.reset())

const { getContextWindowForModel, supportsContextWindow } = await import(
  '../context.js'
)

const TIER_ENV = [
  'OPENAI_DEFAULT_OPUS_MODEL',
  'OPENAI_DEFAULT_SONNET_MODEL',
] as const

afterEach(() => {
  userSettings = {}
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  for (const key of TIER_ENV) delete process.env[key]
})

describe('per-tier context window', () => {
  test('env still wins over a per-tier setting', () => {
    userSettings = {
      modelSettings: { opus: { contextTokens: 1_000_000 } },
    } as SettingsJson
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '128000'

    expect(getContextWindowForModel('claude-opus-5')).toBe(128_000)
  })

  test('a per-tier value below 1M is taken as-is', () => {
    userSettings = {
      modelSettings: { sonnet: { contextTokens: 150_000 } },
    } as SettingsJson

    expect(getContextWindowForModel('claude-sonnet-5')).toBe(150_000)
  })

  test('1M is honoured for a model that supports it', () => {
    userSettings = {
      modelSettings: { opus: { contextTokens: 1_000_000 } },
    } as SettingsJson

    expect(getContextWindowForModel('claude-opus-5')).toBe(1_000_000)
  })

  test('1M is NOT honoured for a model that cannot do it', () => {
    // Widening the local accounting without the capability would stop
    // auto-compact from ever firing and turn a compaction into a hard
    // prompt-too-long at the real limit.
    userSettings = {
      modelSettings: { haiku: { contextTokens: 1_000_000 } },
    } as SettingsJson

    expect(getContextWindowForModel('claude-haiku-4-5')).toBe(200_000)
  })

  test('a third-party 1M is honoured — the [1m] gate is an Anthropic fact', () => {
    // No beta header exists to forget on someone else's endpoint, and the user
    // pointing at it knows its window better than a capability table that has
    // never heard of the checkpoint. Clamping these to 200k is how "set the max
    // context for this tier" did nothing on every provider whose 1M model is
    // not called Claude.
    process.env.OPENAI_DEFAULT_OPUS_MODEL = 'glm-5.2'
    userSettings = {
      modelSettings: { opus: { contextTokens: 1_000_000 } },
    } as SettingsJson

    expect(getContextWindowForModel('glm-5.2')).toBe(1_000_000)
  })

  test('supportsContextWindow states the rule the picker offers rungs from', () => {
    expect(supportsContextWindow('claude-haiku-4-5', 200_000)).toBe(true)
    expect(supportsContextWindow('claude-haiku-4-5', 1_000_000)).toBe(false)
    expect(supportsContextWindow('claude-opus-5', 1_000_000)).toBe(true)
    expect(supportsContextWindow('claude-haiku-4-5[1m]', 1_000_000)).toBe(true)
    expect(supportsContextWindow('deepseek-v4-pro', 1_000_000)).toBe(true)
  })

  test('the family default needs the [1m] opt-in before it reports 1M', () => {
    // Without the suffix betas.ts sends no context-1m header, so the API still
    // cuts off at 200k. Reporting 1M here would leave auto-compact idle right
    // up to a hard prompt-too-long. apply1mContextOptIn is what adds the
    // suffix in a real session.
    expect(getContextWindowForModel('claude-opus-5')).toBe(200_000)
    expect(getContextWindowForModel('claude-opus-5[1m]')).toBe(1_000_000)
    expect(getContextWindowForModel('claude-haiku-4-5')).toBe(200_000)
  })
})
