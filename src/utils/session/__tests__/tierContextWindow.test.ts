import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'
import {
  resetModelStringsForTestingOnly,
  setMainLoopModelOverride,
} from '../../../bootstrap/state.js'
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
let initialSettings: SettingsJson = { modelType: 'openai' }

const settingsMock = setupSettingsMock()
beforeAll(() =>
  settingsMock.set({
    getSettingsForSource: source =>
      source === 'userSettings' ? userSettings : null,
    getInitialSettings: () => initialSettings,
    getSettings_DEPRECATED: () => initialSettings,
  }),
)
afterAll(() => settingsMock.reset())

const { getContextWindowForModel, supportsContextWindow } = await import(
  '../context.js'
)
const { apply1mContextOptIn, getDefaultMainLoopModel } = await import(
  '../../model/model.js'
)
const { clearBetasCaches, getModelBetas } = await import('../../model/betas.js')
const { CONTEXT_1M_BETA_HEADER } = await import('../../../constants/betas.js')

// ANTHROPIC_MODEL and ANTHROPIC_BASE_URL are in here even though no test sets
// them: the slot resolver reads both to work out what the default chain
// resolves to, so an ambient value on the developer's machine (or left behind
// by another file in the same process) would decide these assertions.
const TIER_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'OPENAI_MODEL',
  'OPENAI_DEFAULT_HAIKU_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'OPENAI_DEFAULT_SONNET_MODEL',
  // Listed rather than blind-deleted in afterEach: these two are the highest
  // priority context knob there is, so dropping a developer's own value on the
  // floor changes every later file's idea of the window.
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
] as const
const savedTierEnv = Object.fromEntries(
  TIER_ENV.map(key => [key, process.env[key]]),
)

beforeEach(() => {
  for (const key of TIER_ENV) delete process.env[key]
  // getDefaultMainLoopModel() below fills the provider-derived model-string
  // cache under this file's mocked settings, and nothing re-derives it while it
  // is non-null.
  resetModelStringsForTestingOnly()
  clearBetasCaches()
})

afterAll(() => {
  for (const key of TIER_ENV) {
    const value = savedTierEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  clearBetasCaches()
})

afterEach(() => {
  userSettings = {}
  initialSettings = { modelType: 'openai' }
  setMainLoopModelOverride(undefined)
  resetModelStringsForTestingOnly()
  clearBetasCaches()
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

    // Explicit, because the tier slot is now keyed on the SELECTION and not on
    // the id: with nothing selected, this third-party session's default chain
    // also resolves to claude-sonnet-5, and that is the `default` slot's model.
    // See the next test for that half.
    setMainLoopModelOverride('sonnet')
    expect(getContextWindowForModel('claude-sonnet-5')).toBe(150_000)
  })

  test('a session with no OPENAI_MODEL still reaches the default slot', () => {
    // The regression this pins: getProviderPrimaryModel() is undefined without
    // OPENAI_MODEL, and the old provider-default test then answered false for
    // every third-party session — so `modelSettings.default` was dead config
    // for exactly the users the slot was added for. Without a primary model the
    // default chain falls back to the Sonnet-class tier, which is what the
    // session runs; the reverse-looked-up `sonnet` slot must not win over it.
    process.env.OPENAI_DEFAULT_SONNET_MODEL = 'glm-5.2'
    userSettings = {
      modelSettings: {
        default: { contextTokens: 128_000 },
        sonnet: { contextTokens: 272_000 },
      },
    } as SettingsJson

    expect(getContextWindowForModel('glm-5.2')).toBe(128_000)
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

  test('provider default context stays independent from a same-id sonnet alias', () => {
    process.env.OPENAI_MODEL = 'gpt-5.6-sol'
    process.env.OPENAI_DEFAULT_SONNET_MODEL = 'gpt-5.6-sol'
    userSettings = {
      modelSettings: {
        default: { contextTokens: 128_000 },
        sonnet: { contextTokens: 272_000 },
      },
    } as SettingsJson

    setMainLoopModelOverride(null)
    expect(getContextWindowForModel('gpt-5.6-sol')).toBe(128_000)

    setMainLoopModelOverride('sonnet')
    expect(getContextWindowForModel('gpt-5.6-sol')).toBe(272_000)
  })

  test('main-loop alias does not leak its context into another model', () => {
    process.env.OPENAI_DEFAULT_SONNET_MODEL = 'gpt-5.6-sol'
    process.env.OPENAI_DEFAULT_HAIKU_MODEL = 'gpt-5.6-terra'
    userSettings = {
      modelSettings: {
        haiku: { contextTokens: 128_000 },
        sonnet: { contextTokens: 272_000 },
      },
    } as SettingsJson

    setMainLoopModelOverride('sonnet')
    expect(getContextWindowForModel('gpt-5.6-terra')).toBe(128_000)
  })

  test('first-party default selection uses the default slot', () => {
    initialSettings = { modelType: 'anthropic' }
    process.env.ANTHROPIC_API_KEY = 'test-key'
    userSettings = {
      modelSettings: { default: { contextTokens: 128_000 } },
    } as SettingsJson
    setMainLoopModelOverride(null)

    expect(getContextWindowForModel(getDefaultMainLoopModel())).toBe(128_000)
  })

  test('agent slots keep context accounting and the 1M beta aligned', () => {
    initialSettings = { modelType: 'anthropic' }
    process.env.ANTHROPIC_API_KEY = 'test-key'
    userSettings = {
      modelSettings: {
        default: { contextTokens: 1_000_000 },
        sonnet: { contextTokens: 200_000 },
      },
    } as SettingsJson
    setMainLoopModelOverride(null)

    const explicitSonnet = apply1mContextOptIn(
      'claude-sonnet-5',
      undefined,
      'sonnet',
    )
    expect(explicitSonnet).toBe('claude-sonnet-5')
    expect(getContextWindowForModel(explicitSonnet, undefined, 'sonnet')).toBe(
      200_000,
    )
    expect(getModelBetas(explicitSonnet)).not.toContain(CONTEXT_1M_BETA_HEADER)

    const inheritedOpus = apply1mContextOptIn(
      'claude-opus-5',
      undefined,
      'default',
    )
    expect(inheritedOpus).toBe('claude-opus-5[1m]')
    expect(getContextWindowForModel(inheritedOpus, undefined, 'default')).toBe(
      1_000_000,
    )
    expect(getModelBetas(inheritedOpus)).toContain(CONTEXT_1M_BETA_HEADER)
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
