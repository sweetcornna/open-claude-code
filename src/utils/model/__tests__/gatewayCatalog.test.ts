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
 * A custom ANTHROPIC_BASE_URL is not evidence of a third-party catalog.
 *
 * LiteLLM, corporate gateways and SSO-terminating proxies all set it and all
 * forward to Anthropic. Reading "not api.anthropic.com" as "somebody else's
 * models" took the Anthropic-only beta headers, the `[1m]` opt-in, the marketing
 * name in the system prompt, Fast mode, the legacy-model remap and the rate card
 * away from users who changed nothing but a hostname — and, through
 * getProviderPrimaryModel(), collapsed their whole tier ladder onto whatever
 * ANTHROPIC_MODEL said.
 */

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

const {
  isThirdPartyModelCatalog,
  servesAnthropicModels,
  isThirdPartyAnthropicEndpoint,
} = await import('../providers.js')
const {
  getDefaultOpusModel,
  getDefaultFableModel,
  getDefaultSonnetModel,
  getDefaultHaikuModel,
  getMainLoopModel,
  getMainLoopModelSettingsSlot,
  getUserSpecifiedModelSetting,
} = await import('../model.js')
const { applyDeepSeekAnthropicWire } = await import('../deepseekWire.js')

const ENV = [
  // Every key applyDeepSeekAnthropicWire() can claim has to be in here. The
  // last case calls it, and an assertion failing before its manual second call
  // used to leave ANTHROPIC_API_KEY / the tier pins pointed at DeepSeek for the
  // rest of the shard.
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_WIRE_API',
  'CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE',
  // getAPIProvider() reads the CLAUDE_CODE_USE_* family before any of the keys
  // above, so a leftover from an earlier file in this shard (or a Bedrock
  // user's own environment) decides every "plain Anthropic gateway" case here
  // before the test gets a say.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'USER_TYPE',
] as const
const saved = Object.fromEntries(ENV.map(key => [key, process.env[key]]))

beforeEach(() => {
  for (const key of ENV) delete process.env[key]
  // getDefault*Model() reads the provider-derived model-string cache, which is
  // only re-derived while it is null. Anything that populated it under another
  // provider stays until someone clears it.
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  settings = {}
  setMainLoopModelOverride(undefined)
  for (const key of ENV) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetModelStringsForTestingOnly()
  // Drop the mirror's module-level claim ledger as well. With the env restored
  // above it finds no DeepSeek configuration, releases nothing it no longer
  // owns and rebuilds an empty map — otherwise isDeepSeekMirroredApiKey() /
  // isDeepSeekMirroredModel() keep answering true for this file's values in
  // every later file.
  applyDeepSeekAnthropicWire()
})

describe('a plain Anthropic gateway', () => {
  test('is not a third-party catalog when the model is a Claude id', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://litellm.corp.example'
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5'

    expect(isThirdPartyAnthropicEndpoint()).toBe(false)
    expect(isThirdPartyModelCatalog()).toBe(false)
    expect(servesAnthropicModels()).toBe(true)
  })

  test('is not a third-party catalog when nothing is pinned', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.corp.example/anthropic'

    expect(isThirdPartyAnthropicEndpoint()).toBe(false)
    expect(isThirdPartyModelCatalog()).toBe(false)
    expect(servesAnthropicModels()).toBe(true)
    expect(getDefaultHaikuModel()).toContain('claude')
    expect(getDefaultSonnetModel()).toContain('claude')
    expect(getDefaultOpusModel()).toContain('claude')
    expect(getDefaultFableModel()).toContain('claude')
  })

  test('stays Anthropic when every tier-only pin is a Claude id', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.corp.example/anthropic'
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-gateway'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-gateway'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-gateway'
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'claude-fable-gateway'

    expect(isThirdPartyAnthropicEndpoint()).toBe(false)
    expect(isThirdPartyModelCatalog()).toBe(false)
    expect(servesAnthropicModels()).toBe(true)
    expect(getDefaultHaikuModel()).toBe('claude-haiku-gateway')
    expect(getDefaultSonnetModel()).toBe('claude-sonnet-gateway')
    expect(getDefaultOpusModel()).toBe('claude-opus-gateway')
    expect(getDefaultFableModel()).toBe('claude-fable-gateway')
  })

  test('reads a settings.model pin the same way as the env one', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.corp.example'
    settings = { model: 'opus' } as SettingsJson

    expect(isThirdPartyModelCatalog()).toBe(false)
  })

  test('keeps the tier ladder instead of collapsing it onto ANTHROPIC_MODEL', () => {
    // The regression: getProviderPrimaryModel() returned ANTHROPIC_MODEL for any
    // non-official base URL, and every getDefault*Model() falls back to it — so
    // `/model opus` answered with the pinned Sonnet and the small/fast model
    // became the expensive one.
    process.env.ANTHROPIC_BASE_URL = 'https://litellm.corp.example'
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5'

    expect(getDefaultOpusModel()).not.toBe('claude-sonnet-4-5')
    expect(getDefaultHaikuModel()).not.toBe('claude-sonnet-4-5')
  })
})

describe('an endpoint positively identified as somebody else', () => {
  test('a non-Claude tier-only pin makes it third party', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic'
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-gateway'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-4.7'

    expect(isThirdPartyAnthropicEndpoint()).toBe(true)
    expect(isThirdPartyModelCatalog()).toBe(true)
    expect(servesAnthropicModels()).toBe(false)
    expect(getDefaultHaikuModel()).toBe('claude-haiku-gateway')
    expect(getDefaultSonnetModel()).toBe('glm-4.7')
    expect(getMainLoopModel()).toBe('glm-4.7')
  })

  test('a non-Claude model pin makes it third party', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic'
    process.env.ANTHROPIC_MODEL = 'glm-4.7'

    expect(isThirdPartyAnthropicEndpoint()).toBe(true)
    expect(isThirdPartyModelCatalog()).toBe(true)
    expect(servesAnthropicModels()).toBe(false)
    // …and only then does the primary-model fallback apply.
    expect(getDefaultOpusModel()).toBe('glm-4.7')
  })

  test('an alias repointed at a non-Claude checkpoint counts too', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.corp.example'
    process.env.ANTHROPIC_MODEL = 'opus'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'qwen3-max'

    expect(isThirdPartyAnthropicEndpoint()).toBe(true)
  })

  test('a DeepSeek base URL is third party whatever the model is called', () => {
    // DeepSeek's Anthropic line answers to claude-* names and remaps them
    // server-side, so the id alone would say "Anthropic".
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-5'

    expect(isThirdPartyAnthropicEndpoint()).toBe(true)
    expect(servesAnthropicModels()).toBe(false)
  })

  test('the OPENAI_*-configured DeepSeek routing is third party', () => {
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
    process.env.OPENAI_API_KEY = 'sk-test'

    expect(isThirdPartyAnthropicEndpoint()).toBe(true)
    expect(isThirdPartyModelCatalog()).toBe(true)
  })
})

describe('the official endpoint is unaffected', () => {
  test('unset and api.anthropic.com both stay first party', () => {
    expect(isThirdPartyAnthropicEndpoint()).toBe(false)
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    expect(isThirdPartyAnthropicEndpoint()).toBe(false)
    expect(servesAnthropicModels()).toBe(true)
  })
})

describe('getMainLoopModelSettingsSlot follows the selection source', () => {
  test('the provider primary model owns the default slot', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.corp.example'
    process.env.ANTHROPIC_MODEL = 'glm-4.7'

    expect(getMainLoopModelSettingsSlot('glm-4.7')).toBe('default')
  })

  test('a literal alias keeps its own slot even at the same id', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.corp.example'
    process.env.ANTHROPIC_MODEL = 'glm-4.7'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-4.7'

    setMainLoopModelOverride('sonnet')
    expect(getMainLoopModelSettingsSlot('glm-4.7')).toBe('sonnet')
  })

  test('an explicit id equal to the primary model is still the default slot', () => {
    // Otherwise one checkpoint owns two slots and `/model-settings default …`
    // stops applying the moment the user re-picks it by name.
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.corp.example'
    process.env.ANTHROPIC_MODEL = 'glm-4.7'

    setMainLoopModelOverride('glm-4.7')
    expect(getMainLoopModelSettingsSlot('glm-4.7')).toBe('default')
  })

  test('`/model default` restores the default slot', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.corp.example'
    process.env.ANTHROPIC_MODEL = 'glm-4.7'

    setMainLoopModelOverride(null)
    expect(getMainLoopModelSettingsSlot('glm-4.7')).toBe('default')
  })

  test('a model that is not the main-loop selection reverse-looks-up', () => {
    // Sub agents and the small/fast model call straight in with their own id.
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.corp.example'
    process.env.ANTHROPIC_MODEL = 'glm-4.7'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-4.6-air'

    expect(getMainLoopModelSettingsSlot('glm-4.6-air')).toBe('sonnet')
  })

  test('settings.model is an explicit selection', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.corp.example'
    settings = { model: 'sonnet' } as SettingsJson
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-4.6-air'

    expect(getMainLoopModelSettingsSlot('glm-4.6-air')).toBe('sonnet')
  })

  test('a mirrored ANTHROPIC_MODEL does not outrank settings.model', () => {
    // applyDeepSeekAnthropicWire copies OPENAI_MODEL into ANTHROPIC_MODEL, and
    // getUserSpecifiedModelSetting ranks that key above settings.model. Without
    // the mirror bookkeeping, a user pinned to v4-flash was moved to v4-pro the
    // first time a client was built — and the slot followed the wrong model.
    settings = { model: 'deepseek-v4-flash' } as SettingsJson
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
    process.env.OPENAI_API_KEY = 'sk-test'
    process.env.OPENAI_MODEL = 'deepseek-v4-pro'
    applyDeepSeekAnthropicWire()

    expect(process.env.ANTHROPIC_MODEL).toBe('deepseek-v4-pro')
    expect(getUserSpecifiedModelSetting()).toBe('deepseek-v4-flash')
    expect(getMainLoopModel()).toBe('deepseek-v4-flash')

    delete process.env.OPENAI_BASE_URL
    applyDeepSeekAnthropicWire()
  })
})
