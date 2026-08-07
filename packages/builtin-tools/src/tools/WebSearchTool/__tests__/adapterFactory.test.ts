import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  registerSearchCredentialProbe,
  resetSearchCredentialProbe,
  type SearchCredentialFamily,
} from '@open-claude-code/tool-runtime/searchCredentials.js'
import * as realProviders from 'src/utils/model/providers.js'
import * as realSettings from 'src/utils/settings/settings.js'
import { makeSharedModuleMock } from '../../../../../../tests/mocks/sharedModuleMock'

// Captured BEFORE the mock is registered: bun's mock.module patches the live
// module namespace, so `realSettings.getSettings_DEPRECATED` would resolve to
// the delegating wrapper afterwards and an override calling it would recurse
// forever.
const realGetSettings = realSettings.getSettings_DEPRECATED

// Complete-surface mocks (CLAUDE.md): every export delegates to the real
// module unless a test overrides it, so nothing downstream sees a hole.
// Registered BEFORE the factory is imported so it binds to them.
const settingsMock = makeSharedModuleMock(
  'src/utils/settings/settings.js',
  realSettings,
).setup()
const providersMock = makeSharedModuleMock(
  'src/utils/model/providers.js',
  realProviders,
).setup()

const { createAdapter, resetAdapterCache } = await import('../adapters/index')
const { resetSourceAvailability, markSourceUnavailable, SourceHealthAdapter } =
  await import('../adapters/searchSources')

const originalWebSearchAdapter = process.env.WEB_SEARCH_ADAPTER

/**
 * Env the DeepSeek routing reads. Saved and cleared per test: primarySourceId()
 * consults it directly (a DeepSeek session answers 'firstParty' for the
 * protocol while being nobody's Anthropic), so a developer machine configured
 * for DeepSeek would otherwise change what every scenario below means.
 */
const DEEPSEEK_ENV_KEYS = [
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_WIRE_API',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE',
] as const
const savedDeepSeekEnv = new Map<string, string | undefined>()

function withDeepSeekEnv(env: Record<string, string> = {}): void {
  for (const key of DEEPSEEK_ENV_KEYS) delete process.env[key]
  Object.assign(process.env, env)
}

type Provider = ReturnType<typeof realProviders.getAPIProvider>

/** Provider, credentials and settings for one scenario. */
function scenario(options: {
  provider: Provider
  credentials?: SearchCredentialFamily[]
  settingsAdapter?: string
  sources?: Record<string, boolean>
}): void {
  providersMock.set({ getAPIProvider: () => options.provider })
  const owned = new Set(options.credentials ?? [])
  // Credentials come through the tool-runtime facade, so the test registers a
  // probe instead of mocking the host auth stack.
  registerSearchCredentialProbe(family => owned.has(family))
  settingsMock.set({
    getSettings_DEPRECATED: () =>
      ({
        ...realGetSettings(),
        webSearchAdapter: options.settingsAdapter,
        webSearchSources: options.sources,
      }) as ReturnType<typeof realGetSettings>,
  })
  resetAdapterCache()
}

/**
 * Read a `private readonly` construction flag. Which route an adapter takes is
 * decided at construction and only observable over the network otherwise —
 * this keeps the factory's contract testable without standing up a server.
 */
function privateField(adapter: unknown, field: string): unknown {
  return (adapter as unknown as Record<string, unknown>)[field]
}

function laneName(lane: unknown): string {
  const adapter =
    lane instanceof SourceHealthAdapter ? lane.inner : (lane as object)
  return (adapter as { constructor: { name: string } }).constructor.name
}

/** Class names of the lanes the returned adapter would run, in merge order. */
function lanes(adapter: unknown): string[] {
  const record = adapter as {
    primary?: unknown
    enhancers?: unknown[]
    constructor: { name: string }
  }
  if (record.constructor.name !== 'AggregateSearchAdapter') {
    return [laneName(adapter)]
  }
  const names: string[] = []
  if (record.primary) names.push(laneName(record.primary))
  for (const enhancer of record.enhancers ?? []) names.push(laneName(enhancer))
  return names
}

beforeEach(() => {
  delete process.env.WEB_SEARCH_ADAPTER
  for (const key of DEEPSEEK_ENV_KEYS) {
    savedDeepSeekEnv.set(key, process.env[key])
    delete process.env[key]
  }
  resetSourceAvailability()
  resetAdapterCache()
})

afterEach(() => {
  if (originalWebSearchAdapter === undefined) {
    delete process.env.WEB_SEARCH_ADAPTER
  } else {
    process.env.WEB_SEARCH_ADAPTER = originalWebSearchAdapter
  }
  for (const [key, value] of savedDeepSeekEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

afterAll(() => {
  settingsMock.reset()
  providersMock.reset()
  resetSearchCredentialProbe()
  resetSourceAvailability()
  resetAdapterCache()
})

describe('createAdapter — explicit selection', () => {
  test('WEB_SEARCH_ADAPTER pins one backend and skips aggregation', () => {
    scenario({ provider: 'firstParty', credentials: ['anthropic'] })

    for (const [env, expected] of [
      ['api', 'ApiSearchAdapter'],
      ['bing', 'BingSearchAdapter'],
      ['brave', 'BraveSearchAdapter'],
      ['codex', 'CodexSearchAdapter'],
      ['exa', 'ExaSearchAdapter'],
      ['free', 'FreeSearchAdapter'],
      ['gemini', 'GeminiSearchAdapter'],
    ] as const) {
      process.env.WEB_SEARCH_ADAPTER = env
      resetAdapterCache()
      expect(createAdapter().constructor.name).toBe(expected)
    }
  })

  test('an explicitly named provider source still knows it is off-provider', () => {
    // Regression: naming a source does not make it the session's provider.
    // Built bare, the Gemini adapter skipped the Antigravity route a Google
    // login had made available and sent an empty x-goog-api-key — 403.
    scenario({ provider: 'openai', credentials: ['codex', 'gemini'] })
    process.env.WEB_SEARCH_ADAPTER = 'gemini'

    expect(privateField(createAdapter(), 'asExtraSource')).toBe(true)
  })

  test('an explicitly named source that IS the provider leads normally', () => {
    scenario({ provider: 'gemini', credentials: ['gemini'] })
    process.env.WEB_SEARCH_ADAPTER = 'gemini'

    expect(privateField(createAdapter(), 'asExtraSource')).toBe(false)
  })

  test('explicit "api" off-provider uses the standalone Anthropic call', () => {
    // ApiSearchAdapter rides the session query pipeline, which would route an
    // Anthropic web_search tool at whatever provider the main loop is using.
    scenario({ provider: 'openai', credentials: ['anthropic'] })
    process.env.WEB_SEARCH_ADAPTER = 'api'

    expect(createAdapter().constructor.name).toBe(
      'AnthropicDirectSearchAdapter',
    )
  })

  test('explicit "codex" off-provider prefers the connected ChatGPT account', () => {
    scenario({ provider: 'gemini', credentials: ['codex', 'gemini'] })
    process.env.WEB_SEARCH_ADAPTER = 'codex'

    expect(privateField(createAdapter(), 'forceChatGPTAuth')).toBe(true)
  })

  test('env beats settings', () => {
    scenario({
      provider: 'firstParty',
      credentials: ['anthropic'],
      settingsAdapter: 'exa',
    })
    process.env.WEB_SEARCH_ADAPTER = 'bing'

    expect(createAdapter().constructor.name).toBe('BingSearchAdapter')
  })

  test('settings.webSearchAdapter pins a backend when no env var is set', () => {
    scenario({
      provider: 'firstParty',
      credentials: ['anthropic'],
      settingsAdapter: 'brave',
    })

    expect(createAdapter().constructor.name).toBe('BraveSearchAdapter')
  })

  test('a stale "tavily" settings value falls back to aggregation, silently', () => {
    scenario({
      provider: 'firstParty',
      credentials: ['anthropic'],
      settingsAdapter: 'tavily',
    })

    expect(lanes(createAdapter())).toEqual([
      'ApiSearchAdapter',
      'FreeSearchAdapter',
    ])
  })

  test('reuses the instance until the selection changes', () => {
    scenario({ provider: 'firstParty', credentials: ['anthropic'] })
    process.env.WEB_SEARCH_ADAPTER = 'brave'

    const first = createAdapter()
    expect(createAdapter()).toBe(first)

    process.env.WEB_SEARCH_ADAPTER = 'bing'
    expect(createAdapter()).not.toBe(first)
  })
})

describe('createAdapter — default aggregation', () => {
  test('firstParty leads with Anthropic and enhances with free', () => {
    scenario({ provider: 'firstParty', credentials: ['anthropic'] })

    expect(lanes(createAdapter())).toEqual([
      'ApiSearchAdapter',
      'FreeSearchAdapter',
    ])
  })

  test('openai leads with codex', () => {
    scenario({ provider: 'openai', credentials: ['codex'] })

    expect(lanes(createAdapter())).toEqual([
      'CodexSearchAdapter',
      'FreeSearchAdapter',
    ])
  })

  test('gemini leads with gemini', () => {
    scenario({ provider: 'gemini', credentials: ['gemini'] })

    expect(lanes(createAdapter())).toEqual([
      'GeminiSearchAdapter',
      'FreeSearchAdapter',
    ])
  })

  test('a provider with no search layer of its own runs free alone', () => {
    scenario({ provider: 'grok' })

    expect(createAdapter().constructor.name).toBe('SourceHealthAdapter')
    expect(lanes(createAdapter())).toEqual(['FreeSearchAdapter'])
  })

  test('connected accounts join as extra lanes even off-provider', () => {
    scenario({
      provider: 'openai',
      credentials: ['codex', 'anthropic', 'gemini'],
    })

    // codex leads; anthropic/gemini join as enhancers in registry order, free
    // last. Anthropic off-provider uses the standalone Messages call.
    expect(lanes(createAdapter())).toEqual([
      'CodexSearchAdapter',
      'AnthropicDirectSearchAdapter',
      'GeminiSearchAdapter',
      'FreeSearchAdapter',
    ])
  })

  test('the provider family is never searched twice', () => {
    scenario({ provider: 'gemini', credentials: ['gemini', 'anthropic'] })

    const laneNames = lanes(createAdapter())
    expect(
      laneNames.filter(name => name === 'GeminiSearchAdapter'),
    ).toHaveLength(1)
    expect(laneNames).toEqual([
      'GeminiSearchAdapter',
      'AnthropicDirectSearchAdapter',
      'FreeSearchAdapter',
    ])
  })

  test('sources without credentials stay out of the aggregation', () => {
    scenario({ provider: 'firstParty', credentials: ['anthropic'] })

    const laneNames = lanes(createAdapter())
    expect(laneNames).not.toContain('CodexSearchAdapter')
    expect(laneNames).not.toContain('GeminiSearchAdapter')
  })

  test('an explicit off switch beats the credential default', () => {
    scenario({
      provider: 'firstParty',
      credentials: ['anthropic'],
      sources: { free: false },
    })

    expect(lanes(createAdapter())).toEqual(['ApiSearchAdapter'])
  })

  test('an explicit on switch does NOT summon a lane with no credentials', () => {
    // The switch records a preference, not a capability. A codex lane with no
    // OpenAI credentials behind it can only fail or come back silently empty,
    // and an empty result set reaches the model as "the web has no answer".
    scenario({ provider: 'grok', sources: { codex: true } })

    expect(lanes(createAdapter())).toEqual(['FreeSearchAdapter'])
  })

  test('an explicit on switch keeps a lane whose credentials are present', () => {
    scenario({
      provider: 'grok',
      credentials: ['codex'],
      sources: { codex: true },
    })

    expect(lanes(createAdapter())).toEqual([
      'CodexSearchAdapter',
      'FreeSearchAdapter',
    ])
  })

  test('a source retired as unavailable drops out', () => {
    scenario({ provider: 'openai', credentials: ['codex', 'anthropic'] })
    markSourceUnavailable('anthropic')
    resetAdapterCache()

    expect(lanes(createAdapter())).toEqual([
      'CodexSearchAdapter',
      'FreeSearchAdapter',
    ])
  })

  test('a DeepSeek session leads with DeepSeek, not with "Anthropic"', () => {
    // getAPIProvider() answers 'firstParty' here because that is the PROTOCOL.
    // Naming the lane `anthropic` on the strength of it would show a connected
    // Anthropic row in /search-setting whose every byte goes to
    // api.deepseek.com — and would run the same endpoint twice, once per name.
    withDeepSeekEnv({
      OPENAI_BASE_URL: 'https://api.deepseek.com',
      OPENAI_API_KEY: 'sk-test',
    })
    scenario({ provider: 'firstParty', credentials: ['deepseek'] })

    expect(lanes(createAdapter())).toEqual([
      'ApiSearchAdapter',
      'FreeSearchAdapter',
    ])
  })

  test('DeepSeek on an OpenAI wire still contributes a lane', () => {
    // OPENAI_WIRE_API is about what the MAIN LOOP speaks; a search source is its
    // own lane. The chat wire has no built-in search at all, so this session is
    // the one with the most to gain from the /anthropic endpoint.
    withDeepSeekEnv({
      OPENAI_BASE_URL: 'https://api.deepseek.com',
      OPENAI_API_KEY: 'sk-test',
      OPENAI_WIRE_API: 'chat',
    })
    scenario({ provider: 'openai', credentials: ['deepseek'] })

    // codex is the openai provider's source but holds no credentials, so there
    // is no primary lane — deepseek and free aggregate on their own.
    expect(lanes(createAdapter())).toEqual([
      'DeepSeekDirectSearchAdapter',
      'FreeSearchAdapter',
    ])
  })

  test('every connected source is still a separate parallel lane', () => {
    // The registry grew a fifth source; adding one must add a lane, never
    // replace the aggregation with a single pick.
    withDeepSeekEnv({
      OPENAI_BASE_URL: 'https://api.deepseek.com',
      OPENAI_API_KEY: 'sk-test',
    })
    scenario({
      provider: 'firstParty',
      credentials: ['deepseek', 'gemini', 'codex'],
    })

    expect(lanes(createAdapter())).toEqual([
      'ApiSearchAdapter',
      'GeminiSearchAdapter',
      'CodexSearchAdapter',
      'FreeSearchAdapter',
    ])
  })

  test('turning the provider source off leaves the other lanes running', () => {
    scenario({
      provider: 'firstParty',
      credentials: ['anthropic'],
      sources: { anthropic: false },
    })

    expect(lanes(createAdapter())).toEqual(['FreeSearchAdapter'])
  })
})
