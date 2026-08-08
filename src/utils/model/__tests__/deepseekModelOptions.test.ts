import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { resetModelStringsForTestingOnly } from 'src/bootstrap/state.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from 'src/utils/settings/settingsCache.js'
import { setBedrockInferenceProfilesForTestingOnly } from '../bedrock.js'
import { applyDeepSeekAnthropicWire } from '../deepseekWire.js'
import {
  getMarketingNameForModel,
  getPublicModelDisplayName,
  renderDefaultModelSetting,
} from '../model.js'
import { getModelOptions } from '../modelOptions.js'
import {
  isThirdPartyModelCatalog,
  servesAnthropicModels,
} from '../providers.js'

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
  // The whole CLAUDE_CODE_USE_* family, not just the one key the Bedrock case
  // below sets. getAPIProvider() checks these before anything else this file
  // configures, so a single leftover — from an earlier file in the shard, or
  // from the environment of a developer who actually uses Bedrock — turns every
  // "plain first-party session" case here into a Bedrock/Vertex/… one.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'USER_TYPE',
] as const

const saved: Record<string, string | undefined> = {}

// The Bedrock case at the bottom reaches initModelStrings(), which fires a real
// ListInferenceProfiles call at AWS without awaiting it. An empty list is what
// getBedrockModelStrings() already falls back on, so the assertions are
// unchanged — the socket is not.
beforeAll(() => setBedrockInferenceProfilesForTestingOnly(async () => []))
afterAll(() => setBedrockInferenceProfilesForTestingOnly(null))

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

  test('an unconfigured tier is never offered as an Anthropic model id', () => {
    // ALL_MODEL_CONFIGS maps every tier onto the same `claude-*` string for
    // openai/gemini/grok, so a tier with nothing pinned used to resolve to a
    // literal `claude-fable-5` and appear as a selectable row labelled "Fable".
    // DeepSeek silently remaps that to its own checkpoint; every other
    // OpenAI-compatible endpoint 404s on it.
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
    process.env.OPENAI_API_KEY = 'sk-test'
    applyDeepSeekAnthropicWire()
    const options = getModelOptions()

    expect(
      options.some(
        o => typeof o.value === 'string' && o.value.includes('claude-'),
      ),
    ).toBe(false)
    expect(
      options.some(
        o => o.label.includes('Fable 5') || o.label.includes('Opus 5'),
      ),
    ).toBe(false)
    // The tiers are still listed — by alias, so the row and its per-tier
    // settings agree — and say plainly that nothing is configured.
    const fable = options.find(o => o.value === 'fable')
    expect(fable?.label).toBe('Fable')
    expect(fable?.description).toContain('no model configured')
  })

  test('display names never claim an Anthropic model this session cannot serve', () => {
    deepseekSession()

    expect(servesAnthropicModels()).toBe(false)
    expect(getPublicModelDisplayName('claude-fable-5[1m]')).toBeNull()
    // Also reaches the system prompt ("You are powered by the model named …"),
    // so a wrong answer here misinforms the model about its own identity.
    expect(getMarketingNameForModel('claude-fable-5')).toBeUndefined()
    expect(renderDefaultModelSetting('fable')).toBe('deepseek-v4-pro')
  })

  test('a custom Anthropic-compatible endpoint uses its own model identity', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://opencode.ai/zen/go/v1'
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    process.env.ANTHROPIC_MODEL = 'deepseek-v4-flash'

    expect(isThirdPartyModelCatalog()).toBe(true)
    expect(servesAnthropicModels()).toBe(false)
    const options = getModelOptions()
    expect(options[0]?.description).toContain('deepseek-v4-flash')
    expect(
      options.some(
        option =>
          typeof option.value === 'string' && option.value.includes('claude-'),
      ),
    ).toBe(false)
  })

  test('a first-party session still gets Anthropic’s list', () => {
    // A key of some kind is required before the auth layer will answer at all;
    // an API key keeps this on the PAYG branch without touching the keychain.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const options = getModelOptions()

    expect(options.some(o => o.label.startsWith('Opus'))).toBe(true)
    expect(options.some(o => o.description.includes('per Mtok'))).toBe(true)
    // Anthropic's own models keep their marketing names, everywhere.
    expect(servesAnthropicModels()).toBe(true)
    expect(getMarketingNameForModel('claude-fable-5')).toBe('Fable 5')
    expect(getPublicModelDisplayName('claude-opus-5')).toBe('Opus 5')
  })

  test('Bedrock keeps Anthropic’s list and names — it serves real Claude', () => {
    // isThirdPartyModelCatalog() is true there (separate billing, different
    // beta support) but the checkpoints ARE Anthropic's, so calling
    // us.anthropic.claude-opus-5-v1 "Opus 5" is correct and must not regress.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    // Cleanup is the shared afterEach, which restores the key's previous value
    // instead of deleting it: an unconditional `delete` here wiped a real
    // Bedrock user's own CLAUDE_CODE_USE_BEDROCK for the rest of the process.
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(isThirdPartyModelCatalog()).toBe(true)
    expect(servesAnthropicModels()).toBe(true)
    expect(getModelOptions().some(o => o.label.startsWith('Opus'))).toBe(true)
    expect(getMarketingNameForModel('claude-opus-5')).toBe('Opus 5')
  })
})
