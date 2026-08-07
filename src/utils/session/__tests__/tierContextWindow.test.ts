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

const { getContextWindowForModel } = await import('../context.js')

afterEach(() => {
  userSettings = {}
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
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
