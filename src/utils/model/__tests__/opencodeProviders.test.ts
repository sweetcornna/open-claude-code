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
 * OpenCode Zen against the three questions providers.ts keeps apart.
 *
 * Zen is the configuration where they visibly come apart: one account, one base
 * URL, three wire protocols, and a catalog that is Zen's own while some of the
 * models behind it are real Anthropic checkpoints. Reading any one of the three
 * answers off another gets a user-visible lie — a `/messages` session listed at
 * Anthropic's rate card, or a `claude-opus-5` that is genuinely Opus 5 refused
 * the `[1m]` opt-in and renamed to nothing in the system prompt.
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
  getAPIProvider,
  isThirdPartyAnthropicEndpoint,
  isThirdPartyModelCatalog,
  servesAnthropicModels,
} = await import('../providers.js')
const { applyOpencodeWire } = await import('../opencodeWire.js')
const { getMarketingNameForModel } = await import('../model.js')

const ZEN = 'https://opencode.ai/zen/v1'

const ENV = [
  'OPENCODE_AUTH_MODE',
  'OPENCODE_BASE_URL',
  'OPENCODE_MODEL',
  'OPENCODE_WIRE_API',
  // Everything applyOpencodeWire() can claim. A case that mirrors and then
  // fails an assertion would otherwise leave the lane keys pointed at Zen for
  // the rest of the shard.
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_WIRE_API',
  // getAPIProvider() reads these before anything this file sets, so a leftover
  // from an earlier file in the shard would decide every case here.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'USER_TYPE',
] as const
const saved = Object.fromEntries(ENV.map(key => [key, process.env[key]]))

/** Configure a Zen session for `model`, without applying the mirror. */
function zenSession(model: string): void {
  process.env.OPENCODE_AUTH_MODE = 'opencode'
  process.env.OPENCODE_BASE_URL = ZEN
  process.env.OPENCODE_MODEL = model
}

beforeEach(() => {
  for (const key of ENV) delete process.env[key]
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  settings = {}
  for (const key of ENV) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetModelStringsForTestingOnly()
  // Release the mirror's module-level claim ledger too: with the env restored
  // it finds no OpenCode configuration, so this is a pure release. Skipping it
  // leaves isOpencodeMirroredValue() vouching for this file's values forever.
  applyOpencodeWire()
})

describe('getAPIProvider follows the lane', () => {
  test('a Claude model on Zen is the Anthropic client', () => {
    zenSession('claude-opus-5')
    expect(getAPIProvider(settings)).toBe('firstParty')
  })

  test('a GPT model on Zen is the OpenAI client', () => {
    zenSession('gpt-5.6-codex')
    expect(getAPIProvider(settings)).toBe('openai')
  })

  test('everything else on Zen is the OpenAI client', () => {
    zenSession('qwen3-max')
    expect(getAPIProvider(settings)).toBe('openai')
  })

  test('an explicit OPENCODE_WIRE_API pin wins over the model family', () => {
    zenSession('claude-opus-5')
    process.env.OPENCODE_WIRE_API = 'chat'
    expect(getAPIProvider(settings)).toBe('openai')
  })

  test('the lane outranks settings.modelType', () => {
    // The wizard records the lane's family in settings.modelType, so on
    // /messages that key says 'anthropic' and on the other two it says
    // 'openai'. Reading it first would put a /messages session through the
    // OpenAI client the moment the two disagreed.
    zenSession('claude-opus-5')
    settings = { modelType: 'openai' } as SettingsJson
    expect(getAPIProvider(settings)).toBe('firstParty')
  })

  test('leaves a session that is not OpenCode alone', () => {
    process.env.OPENCODE_MODEL = 'claude-opus-5'
    process.env.OPENCODE_BASE_URL = ZEN
    // No OPENCODE_AUTH_MODE: the keys are configuration nobody activated.
    expect(getAPIProvider(settings)).toBe('firstParty')
    expect(isThirdPartyModelCatalog()).toBe(false)
  })
})

describe('whose catalog and whose rate card', () => {
  test('every lane is a third-party catalog', () => {
    for (const model of ['claude-opus-5', 'gpt-5.6-codex', 'qwen3-max']) {
      zenSession(model)
      expect(isThirdPartyModelCatalog()).toBe(true)
    }
  })

  test('the /messages lane is third party even though the wire is firstParty', () => {
    // The regression this guards: isThirdPartyModelCatalog() derived its answer
    // from the wire question plus isThirdPartyAnthropicEndpoint(), and BOTH say
    // "Anthropic" here. Zen would have been listed and priced as Anthropic's
    // own catalog while every token was billed by OpenCode.
    zenSession('claude-opus-5')
    expect(getAPIProvider(settings)).toBe('firstParty')
    expect(isThirdPartyAnthropicEndpoint()).toBe(false)
    expect(isThirdPartyModelCatalog()).toBe(true)
  })
})

describe('whether a claude-* id means what it says', () => {
  test('yes on the /messages lane — Zen proxies the real checkpoint', () => {
    zenSession('claude-opus-5')
    expect(servesAnthropicModels()).toBe(true)
    // Which is what keeps the `[1m]` opt-in (wantsTierWideContext gates on
    // this) and the marketing name the system prompt reads.
    expect(getMarketingNameForModel('claude-opus-5')).toBe('Opus 5')
  })

  test('no for a model Anthropic does not make', () => {
    zenSession('gpt-5.6-codex')
    expect(servesAnthropicModels()).toBe(false)
    expect(getMarketingNameForModel('claude-opus-5')).toBeUndefined()
  })

  test('no when an explicit pin puts a non-Claude id on /messages', () => {
    zenSession('kimi-k2-thinking')
    process.env.OPENCODE_WIRE_API = 'messages'
    expect(getAPIProvider(settings)).toBe('firstParty')
    expect(isThirdPartyAnthropicEndpoint()).toBe(true)
    expect(servesAnthropicModels()).toBe(false)
  })

  test('the OpenAI lanes are never an Anthropic endpoint', () => {
    zenSession('gemini-3-pro')
    expect(isThirdPartyAnthropicEndpoint()).toBe(true)
  })
})

describe('the mirror does not change the answers', () => {
  test('a mirrored ANTHROPIC_BASE_URL is still read as Zen, not as a gateway', () => {
    // isThirdPartyAnthropicEndpoint() answers before it looks at
    // ANTHROPIC_BASE_URL, so the mirror's own write cannot make the function
    // stop agreeing with itself after the first apply.
    zenSession('claude-opus-5')
    applyOpencodeWire()

    expect(process.env.ANTHROPIC_BASE_URL).toBe(ZEN)
    expect(getAPIProvider(settings)).toBe('firstParty')
    expect(isThirdPartyAnthropicEndpoint()).toBe(false)
    expect(isThirdPartyModelCatalog()).toBe(true)
    expect(servesAnthropicModels()).toBe(true)
  })

  test('a mirrored OPENAI_BASE_URL keeps the OpenAI lane third party', () => {
    zenSession('gpt-5.6-codex')
    applyOpencodeWire()

    expect(process.env.OPENAI_BASE_URL).toBe(ZEN)
    expect(process.env.OPENAI_WIRE_API).toBe('responses')
    expect(getAPIProvider(settings)).toBe('openai')
    expect(isThirdPartyModelCatalog()).toBe(true)
    expect(servesAnthropicModels()).toBe(false)
  })
})
