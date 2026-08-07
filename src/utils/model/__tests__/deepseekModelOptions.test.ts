import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resetModelStringsForTestingOnly } from 'src/bootstrap/state.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from 'src/utils/settings/settingsCache.js'
import { applyDeepSeekAnthropicWire } from '../deepseekWire.js'
import { getModelOptions } from '../modelOptions.js'
import { isThirdPartyModelCatalog } from '../providers.js'

/**
 * A DeepSeek session must be offered DeepSeek models.
 *
 * Routing DeepSeek over its Anthropic-compatible endpoint made
 * `getAPIProvider()` answer 'firstParty', and ~forty places spelled "is this
 * Anthropic's own catalog" as `getAPIProvider() !== 'firstParty'`. The picker
 * was one of them, so `/model` started listing Opus 5, Fable and Haiku at
 * Anthropic's rate card to users whose key only reaches api.deepseek.com.
 *
 * No mock.module here on purpose: settings go through the module's own
 * setSessionSettingsCache setter, and everything else this path reads is
 * process.env.
 */

const ENV_KEYS = [
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_WIRE_API',
  'OPENAI_DEFAULT_HAIKU_MODEL',
  'OPENAI_DEFAULT_SONNET_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'OPENAI_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE',
  'USER_TYPE',
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  resetSettingsCache()
  setSessionSettingsCache({ settings: {}, errors: [] })
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] !== undefined) process.env[key] = saved[key]
    else delete process.env[key]
  }
  resetSettingsCache()
  resetModelStringsForTestingOnly()
})

/** The env a DeepSeek login actually writes, plus the startup mirror. */
function deepseekSession(): void {
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
  process.env.OPENAI_API_KEY = 'sk-test'
  process.env.OPENAI_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash'
  process.env.OPENAI_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro'
  process.env.OPENAI_DEFAULT_OPUS_MODEL = 'deepseek-v4-pro'
  process.env.OPENAI_DEFAULT_FABLE_MODEL = 'deepseek-v4-pro'
  applyDeepSeekAnthropicWire()
}

describe('isThirdPartyModelCatalog', () => {
  test('true for a DeepSeek session even though the wire is firstParty', () => {
    deepseekSession()
    expect(isThirdPartyModelCatalog()).toBe(true)
  })

  test('false for a plain first-party session', () => {
    expect(isThirdPartyModelCatalog()).toBe(false)
  })

  test('false once the wire is opted out of and no other 3P config remains', () => {
    process.env.CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE = '0'
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
    process.env.OPENAI_API_KEY = 'sk-test'
    // modelType is unset in this session's settings, so nothing else marks it
    // as third party — the point is that the helper follows the opt-out.
    expect(isThirdPartyModelCatalog()).toBe(false)
  })
})

describe('/model options for a DeepSeek session', () => {
  test('lists the user’s tier models, not Anthropic’s', () => {
    deepseekSession()
    const options = getModelOptions()
    const byValue = new Map(options.map(o => [o.value, o]))

    expect(byValue.get('sonnet')?.label).toBe('deepseek-v4-pro')
    expect(byValue.get('opus')?.label).toBe('deepseek-v4-pro')
    expect(byValue.get('fable')?.label).toBe('deepseek-v4-pro')
    expect(byValue.get('haiku')?.label).toBe('deepseek-v4-flash')
  })

  test('offers no Anthropic model and quotes no Anthropic price', () => {
    deepseekSession()
    const options = getModelOptions()

    expect(
      options.some(
        o => typeof o.value === 'string' && o.value.includes('claude-'),
      ),
    ).toBe(false)
    expect(
      options.some(
        o => o.description.includes('per Mtok') && o.description.includes('$'),
      ),
    ).toBe(false)
  })

  test('surfaces the DeepSeek preset catalog so both checkpoints are reachable', () => {
    deepseekSession()
    const values = getModelOptions().map(o => o.value)

    expect(values).toContain('deepseek-v4-pro')
    expect(values).toContain('deepseek-v4-flash')
  })

  test('a first-party session still gets Anthropic’s list', () => {
    // A key of some kind is required before the auth layer will answer at all;
    // an API key keeps this on the PAYG branch without touching the keychain.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const options = getModelOptions()

    expect(options.some(o => o.label.startsWith('Opus'))).toBe(true)
    expect(options.some(o => o.description.includes('per Mtok'))).toBe(true)
  })
})
