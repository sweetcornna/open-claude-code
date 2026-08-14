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
import { resetModelStringsForTestingOnly } from '../../../bootstrap/state.js'
import type { SettingsJson } from '../../settings/types.js'

/**
 * The startup notice for a context window that is not what the settings say.
 *
 * Exercised through `getContextWindowNoticeForModel`, which takes the model as
 * an argument: the session-reading wrapper resolves the main-loop model, and
 * standing that up here would measure the developer's own configuration rather
 * than the branch under test.
 */

/**
 * With nothing pinned on a first-party session, `getMainLoopModelSettingsSlot`
 * answers `default` rather than `opus` (the built-in default model cannot be
 * resolved without the subscription chain, so the slot follows the SELECTION,
 * which is the default chain). Configuring every slot mirrors the real machine
 * this was found on and keeps the test off that distinction.
 */
function allSlots(contextTokens: number): SettingsJson {
  return {
    modelSettings: {
      default: { contextTokens },
      haiku: { contextTokens },
      sonnet: { contextTokens },
      opus: { contextTokens },
      fable: { contextTokens },
    },
  } as SettingsJson
}

let userSettings: SettingsJson = {}
let initialSettings: SettingsJson = { modelType: 'anthropic' }

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

const { getContextWindowNoticeForModel } = await import(
  '../contextWindowNotice.js'
)

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'OPENAI_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_NOTICE',
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  userSettings = {}
  initialSettings = { modelType: 'anthropic' }
  for (const key of ENV_KEYS) delete process.env[key]
  resetModelStringsForTestingOnly()
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('context window startup notice', () => {
  test('a capped per-tier window is reported with what it was capped to', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    userSettings = allSlots(372_000)

    expect(getContextWindowNoticeForModel('claude-opus-5')).toEqual({
      kind: 'capped',
      model: 'claude-opus-5',
      configured: 372_000,
      window: 200_000,
    })
  })

  test('no notice when the configured window is actually served', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    userSettings = allSlots(128_000)

    expect(getContextWindowNoticeForModel('claude-opus-5')).toBeNull()
    // The `[1m]` opt-in makes the same 372k a legitimate smaller budget.
    userSettings = allSlots(372_000)
    expect(getContextWindowNoticeForModel('claude-opus-5[1m]')).toBeNull()
  })

  test('the factory default never produces a notice', () => {
    // Opus/Fable default to 1M and get clamped to 200k without the suffix. That
    // is occ's own choice, not a user mistake, and warning about it would fire
    // on every Anthropic session on day one.
    process.env.ANTHROPIC_API_KEY = 'test-key'
    expect(getContextWindowNoticeForModel('claude-opus-5')).toBeNull()
  })

  test('an unrecognized model says the window is an assumption', () => {
    initialSettings = { modelType: 'openai' }
    process.env.OPENAI_MODEL = 'internal-llm-v3'

    expect(getContextWindowNoticeForModel('internal-llm-v3')).toEqual({
      kind: 'assumed',
      model: 'internal-llm-v3',
    })
  })

  test('answering the question silences the assumption notice', () => {
    initialSettings = { modelType: 'openai' }
    process.env.OPENAI_MODEL = 'internal-llm-v3'

    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '128000'
    expect(getContextWindowNoticeForModel('internal-llm-v3')).toBeNull()
    delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS

    userSettings = {
      modelSettings: { default: { contextTokens: 128_000 } },
    } as SettingsJson
    expect(getContextWindowNoticeForModel('internal-llm-v3')).toBeNull()
    userSettings = {}

    process.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_NOTICE = '1'
    expect(getContextWindowNoticeForModel('internal-llm-v3')).toBeNull()
  })

  test('a family occ has a table for is not an assumption', () => {
    initialSettings = { modelType: 'gemini' }
    expect(getContextWindowNoticeForModel('gemini-2.5-pro')).toBeNull()
    initialSettings = { modelType: 'anthropic' }
    process.env.ANTHROPIC_API_KEY = 'test-key'
    expect(getContextWindowNoticeForModel('claude-sonnet-5')).toBeNull()
  })
})
