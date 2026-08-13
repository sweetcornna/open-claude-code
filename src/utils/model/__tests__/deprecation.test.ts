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

let settings: SettingsJson = {}

const settingsMock = setupSettingsMock()
beforeAll(() =>
  settingsMock.set({
    getInitialSettings: () => settings,
    getSettings_DEPRECATED: () => settings,
    getSettingsForSource: () => null,
  }),
)
afterAll(() => settingsMock.reset())

const { getModelDeprecationWarning } = await import('../deprecation.js')

const PROVIDER_ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
] as const
const savedEnv = Object.fromEntries(
  PROVIDER_ENV_KEYS.map(key => [key, process.env[key]]),
)

afterEach(() => {
  settings = {}
  for (const key of PROVIDER_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('getModelDeprecationWarning', () => {
  test.each([
    [
      'claude-3-opus-20240229',
      'Claude 3 Opus was retired on January 5, 2026. Switch to claude-opus-4-8.',
    ],
    [
      'claude-3-7-sonnet-20250219',
      'Claude 3.7 Sonnet was retired on February 19, 2026. Switch to claude-sonnet-4-6.',
    ],
    [
      'claude-3-5-haiku-20241022',
      'Claude 3.5 Haiku was retired on February 19, 2026. Switch to claude-haiku-4-5-20251001.',
    ],
  ])('names the first-party replacement for %s', (model, expected) => {
    expect(getModelDeprecationWarning(model)).toBe(`⚠ ${expected}`)
  })

  test('does not label third-party catalog models as retired Claude models', () => {
    settings = { modelType: 'openai' }

    expect(getModelDeprecationWarning('claude-3-7-sonnet-20250219')).toBeNull()
  })

  test('keeps provider-specific retirement dates without inventing a replacement', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'

    expect(getModelDeprecationWarning('claude-3-7-sonnet-20250219')).toBe(
      '⚠ Claude 3.7 Sonnet was retired on April 28, 2026.',
    )
  })

  test('keeps Foundry retirement dates without borrowing first-party advice', () => {
    process.env.CLAUDE_CODE_USE_FOUNDRY = '1'

    expect(getModelDeprecationWarning('claude-3-7-sonnet')).toBe(
      '⚠ Claude 3.7 Sonnet was retired on February 19, 2026.',
    )
  })

  test('returns null for current and empty model selections', () => {
    expect(getModelDeprecationWarning('claude-sonnet-4-6')).toBeNull()
    expect(getModelDeprecationWarning(null)).toBeNull()
  })
})
