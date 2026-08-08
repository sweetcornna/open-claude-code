import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { makeSharedModuleMock } from '../../../../tests/mocks/sharedModuleMock.js'
import * as realSettings from 'src/utils/settings/settings.js'
import type { SettingsJson } from '../../settings/types.js'
import {
  resetModelStringsForTestingOnly,
  setMainLoopModelOverride,
} from '../../../bootstrap/state.js'

let userSettings: SettingsJson = {}
let initialSettings: SettingsJson = { modelType: 'openai' }

const settingsMock = makeSharedModuleMock(
  'src/utils/settings/settings.js',
  realSettings,
).setup({
  getInitialSettings: () => initialSettings,
  getSettings_DEPRECATED: () => initialSettings,
  getSettingsForSource: source =>
    source === 'userSettings' ? userSettings : null,
})

const { getDefaultEffortForModel, resolveAppliedEffort } = await import(
  '../effort.js'
)
const { getDefaultMainLoopModel } = await import('../model.js')
const ENV_KEYS = [
  'USER_TYPE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'OPENAI_MODEL',
  'OPENAI_DEFAULT_HAIKU_MODEL',
  'OPENAI_DEFAULT_SONNET_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'OPENAI_DEFAULT_FABLE_MODEL',
  'GEMINI_DEFAULT_HAIKU_MODEL',
  'GEMINI_DEFAULT_SONNET_MODEL',
  'GEMINI_DEFAULT_OPUS_MODEL',
  'GEMINI_DEFAULT_FABLE_MODEL',
  'GROK_DEFAULT_HAIKU_MODEL',
  'GROK_DEFAULT_SONNET_MODEL',
  'GROK_DEFAULT_OPUS_MODEL',
  'GROK_DEFAULT_FABLE_MODEL',
] as const
const savedEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>

// The provider-derived model-string cache is only re-derived while it is null,
// so whatever fills it first owns it for the rest of the process. This file
// pins modelType to 'openai' and then resolves default models, which caches the
// OpenAI column — clear it on both edges so neither this file's settings mock
// nor an earlier file's provider decides the other's answers.
beforeEach(() => {
  userSettings = {}
  initialSettings = { modelType: 'openai' }
  setMainLoopModelOverride(undefined)
  resetModelStringsForTestingOnly()
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  userSettings = {}
  initialSettings = { modelType: 'openai' }
  setMainLoopModelOverride(undefined)
  resetModelStringsForTestingOnly()
  for (const key of ENV_KEYS) delete process.env[key]
})

afterAll(() => {
  settingsMock.reset()
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('OpenAI model effort defaults', () => {
  // These used to assert low / medium, which came from
  // getDefaultOpenAIReasoningEffort. The per-tier layer now supplies the
  // default for every model that supports effort, and GPT's factory value is
  // `xhigh` — a deliberate behaviour change, called out in the CHANGELOG
  // because it raises reasoning-token spend for GPT users. The old
  // sol-vs-terra split survives only as the fallback for models where
  // modelSupportsEffort() is false.
  test('gpt-5.6-sol variants take the GPT family default', () => {
    expect(getDefaultEffortForModel('gpt-5.6-sol')).toBe('xhigh')
    expect(getDefaultEffortForModel('gpt-5.6-sol-preview')).toBe('xhigh')
  })

  test('gpt-5.6-terra takes the same family default', () => {
    expect(getDefaultEffortForModel('gpt-5.6-terra')).toBe('xhigh')
  })

  test('provider default effort stays independent from a same-id sonnet alias', () => {
    process.env.OPENAI_MODEL = 'gpt-5.6-sol'
    process.env.OPENAI_DEFAULT_SONNET_MODEL = 'gpt-5.6-sol'
    userSettings = {
      modelSettings: {
        default: { effort: 'low' },
        sonnet: { effort: 'max' },
      },
    } as SettingsJson

    setMainLoopModelOverride(null)
    expect(resolveAppliedEffort('gpt-5.6-sol', undefined)).toBe('low')

    setMainLoopModelOverride('sonnet')
    expect(resolveAppliedEffort('gpt-5.6-sol', undefined)).toBe('max')
  })

  test('main-loop alias does not leak its effort into another model', () => {
    process.env.OPENAI_DEFAULT_SONNET_MODEL = 'gpt-5.6-sol'
    process.env.OPENAI_DEFAULT_HAIKU_MODEL = 'gpt-5.6-terra'
    userSettings = {
      modelSettings: {
        haiku: { effort: 'low' },
        sonnet: { effort: 'max' },
      },
    } as SettingsJson

    setMainLoopModelOverride('sonnet')
    expect(resolveAppliedEffort('gpt-5.6-terra', undefined)).toBe('low')
  })

  test('first-party default selection uses the default slot', () => {
    initialSettings = { modelType: 'anthropic' }
    process.env.ANTHROPIC_API_KEY = 'test-key'
    userSettings = {
      modelSettings: { default: { effort: 'low' } },
    } as SettingsJson
    setMainLoopModelOverride(null)

    expect(resolveAppliedEffort(getDefaultMainLoopModel(), undefined)).toBe(
      'low',
    )
  })
})
