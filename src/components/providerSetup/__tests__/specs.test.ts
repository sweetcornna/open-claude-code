/**
 * Tests for the provider setup spec table.
 *
 * The table is what four hand-written forms collapsed into, so the value here
 * is pinning the things those forms used to state individually: which env keys
 * each provider owns, and which model fields it insists on. A wrong env key is
 * invisible in the UI — the form saves happily and the session then talks to
 * the wrong endpoint or ignores a tier override.
 *
 * Only the log/debug leaves are mock.module'd (shared mocks, per CLAUDE.md).
 */
import { beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

let specs: typeof import('../specs.js')
let chatgptAuth: typeof import('src/services/api/openai/chatgptAuth.js')
let openaiClient: typeof import('src/services/api/openai/client.js')

beforeAll(async () => {
  specs = await import('../specs.js')
  // Imported here, not mocked: afterSave reaches them through a dynamic
  // import, which resolves to this same live namespace, so a spy restored in
  // the test that installs it is enough — and one that does not leak a
  // process-global module replacement onto every file loaded afterwards.
  chatgptAuth = await import('src/services/api/openai/chatgptAuth.js')
  openaiClient = await import('src/services/api/openai/client.js')
})

type Values = import('../specs.js').ProviderSetupValues

function values(overrides: Partial<Values> = {}): Values {
  return {
    model: '',
    haiku_model: '',
    sonnet_model: '',
    opus_model: '',
    fable_model: '',
    maxContext: '',
    effort: '',
    ...overrides,
  }
}

describe('env key ownership', () => {
  test.each([
    ['openai', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI'],
    [
      'anthropic',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_MODEL',
      'ANTHROPIC',
    ],
    ['gemini', 'GEMINI_BASE_URL', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI'],
    ['grok', 'GROK_BASE_URL', 'GROK_API_KEY', 'GROK_MODEL', 'GROK'],
  ] as const)('%s writes its own keys and nobody else’s', (kind, baseUrl, apiKey, model, prefix) => {
    const spec = specs.PROVIDER_SETUP_SPECS[kind]
    expect(spec.env.baseUrl).toBe(baseUrl)
    expect(spec.env.apiKey).toBe(apiKey)
    expect(spec.env.model).toBe(model)
    expect(spec.env.tiers).toEqual({
      haiku_model: `${prefix}_DEFAULT_HAIKU_MODEL`,
      sonnet_model: `${prefix}_DEFAULT_SONNET_MODEL`,
      opus_model: `${prefix}_DEFAULT_OPUS_MODEL`,
      fable_model: `${prefix}_DEFAULT_FABLE_MODEL`,
    })
  })

  test('every provider offers all four tier slots', () => {
    for (const spec of Object.values(specs.PROVIDER_SETUP_SPECS)) {
      expect([...spec.tiers]).toEqual([
        'haiku_model',
        'sonnet_model',
        'opus_model',
        'fable_model',
      ])
    }
  })

  test('the default base URLs match what each provider uses at runtime', () => {
    // Only used for the model-list request when the field is left empty; a
    // wrong one sends the probe to the wrong host and reads as "endpoint
    // broken" to the user.
    expect(specs.PROVIDER_SETUP_SPECS.openai.defaultBaseUrl).toBe(
      'https://api.openai.com/v1',
    )
    expect(specs.PROVIDER_SETUP_SPECS.anthropic.defaultBaseUrl).toBe(
      'https://api.anthropic.com',
    )
    expect(specs.PROVIDER_SETUP_SPECS.gemini.defaultBaseUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta',
    )
    expect(specs.PROVIDER_SETUP_SPECS.grok.defaultBaseUrl).toBe(
      'https://api.x.ai/v1',
    )
  })
})

describe('validation', () => {
  test('OpenAI requires a default model — there is no family fallback', () => {
    const spec = specs.PROVIDER_SETUP_SPECS.openai
    expect(spec.validate(values())?.field).toBe('model')
    expect(spec.validate(values({ model: 'gpt-5.5' }))).toBeNull()
  })

  test('Gemini accepts either a default model or all three base tiers', () => {
    const spec = specs.PROVIDER_SETUP_SPECS.gemini
    expect(spec.validate(values({ model: 'gemini-3-pro' }))).toBeNull()
    expect(
      spec.validate(
        values({
          haiku_model: 'gemini-3-flash',
          sonnet_model: 'gemini-3-pro',
          opus_model: 'gemini-3-pro',
        }),
      ),
    ).toBeNull()
  })

  test('Gemini points at the first tier that is still missing', () => {
    const spec = specs.PROVIDER_SETUP_SPECS.gemini
    expect(spec.validate(values())?.field).toBe('haiku_model')
    expect(spec.validate(values({ haiku_model: 'a' }))?.field).toBe(
      'sonnet_model',
    )
    expect(
      spec.validate(values({ haiku_model: 'a', sonnet_model: 'b' }))?.field,
    ).toBe('opus_model')
  })

  test('Gemini does not require Fable — unset it falls back to the primary key', () => {
    const spec = specs.PROVIDER_SETUP_SPECS.gemini
    expect(
      spec.validate(
        values({ haiku_model: 'a', sonnet_model: 'b', opus_model: 'c' }),
      ),
    ).toBeNull()
  })

  test.each([
    'anthropic',
    'grok',
  ] as const)('%s accepts an empty form — it has built-in family defaults', kind => {
    expect(specs.PROVIDER_SETUP_SPECS[kind].validate(values())).toBeNull()
  })
})

describe('save-time extras', () => {
  test('OpenAI records the wire protocol and clears ChatGPT auth mode', () => {
    // Leaving OPENAI_AUTH_MODE set would keep routing to the Codex backend
    // even though the user just configured a plain API key.
    const spec = specs.PROVIDER_SETUP_SPECS.openai
    expect(spec.extraEnv?.({ wireApi: 'responses' })).toEqual({
      OPENAI_WIRE_API: 'responses',
      OPENAI_AUTH_MODE: undefined,
    })
  })

  test('Gemini API setup clears an earlier Antigravity route', () => {
    expect(specs.PROVIDER_SETUP_SPECS.gemini.extraEnv?.({})).toEqual({
      GEMINI_AUTH_MODE: undefined,
    })
  })

  test('a China preset drops a wire protocol nobody chose here', () => {
    // The preset table settles the endpoint; the form never asks which OpenAI
    // wire to speak. A leftover OPENAI_WIRE_API from an earlier OpenAI login
    // therefore reads as an explicit choice that was never made — and for
    // DeepSeek that phantom choice vetoes the Anthropic Messages wire the
    // session is supposed to default to. The group sweep cannot catch it: this
    // spec's own modelType is 'openai', so the OpenAI group is skipped.
    expect(
      Object.keys(specs.PROVIDER_SETUP_SPECS.china.extraEnv?.({}) ?? {}),
    ).toContain('OPENAI_WIRE_API')
    expect(
      specs.PROVIDER_SETUP_SPECS.china.extraEnv?.({}).OPENAI_WIRE_API,
    ).toBeUndefined()
  })

  test('Anthropic and Grok write no extra env', () => {
    for (const kind of ['anthropic', 'grok'] as const) {
      expect(specs.PROVIDER_SETUP_SPECS[kind].extraEnv).toBeUndefined()
    }
  })

  test('only OpenAI demands a base URL and an API key up front', () => {
    const spec = specs.PROVIDER_SETUP_SPECS.openai
    expect(spec.baseUrlRequired).toBe(true)
    expect(spec.apiKeyRequired).toBe(true)
    for (const kind of ['anthropic', 'gemini', 'grok'] as const) {
      // Keyless local gateways stayed configurable: an empty key skips the
      // catalog request instead of blocking the form.
      expect(specs.PROVIDER_SETUP_SPECS[kind].baseUrlRequired).toBe(false)
      expect(specs.PROVIDER_SETUP_SPECS[kind].apiKeyRequired).toBe(false)
    }
  })
})

describe('the China preset spec', () => {
  test('writes an independent provider default model', () => {
    expect(specs.PROVIDER_SETUP_SPECS.china.defaultModelField).toBe('required')
    expect(specs.PROVIDER_SETUP_SPECS.china.env.model).toBe('OPENAI_MODEL')
  })

  test('joins at the model step — the endpoint comes from a table, not a form', () => {
    expect(specs.PROVIDER_SETUP_SPECS.china.hasEndpointStep).toBe(false)
    for (const kind of ['openai', 'anthropic', 'gemini', 'grok'] as const) {
      expect(specs.PROVIDER_SETUP_SPECS[kind].hasEndpointStep).toBe(true)
    }
  })

  test('writes the OpenAI-compatible keys, since that is the wire it speaks', () => {
    const spec = specs.PROVIDER_SETUP_SPECS.china
    expect(spec.modelType).toBe('openai')
    expect(spec.env.baseUrl).toBe('OPENAI_BASE_URL')
    expect(spec.env.apiKey).toBe('OPENAI_API_KEY')
    expect(spec.env.tiers.fable_model).toBe('OPENAI_DEFAULT_FABLE_MODEL')
  })

  test('clears ChatGPT auth mode, like the OpenAI spec', () => {
    expect(specs.PROVIDER_SETUP_SPECS.china.extraEnv?.({})).toEqual({
      OPENAI_AUTH_MODE: undefined,
    })
  })

  test('all four tiers are offered and the default is mandatory', () => {
    const spec = specs.PROVIDER_SETUP_SPECS.china
    expect([...spec.tiers]).toEqual([
      'haiku_model',
      'sonnet_model',
      'opus_model',
      'fable_model',
    ])
    expect(spec.validate(values())).toEqual({
      message: 'Choose a default model for requests that do not select a tier.',
      field: 'model',
    })
    expect(spec.validate(values({ model: 'deepseek-v4-pro' }))).toBeNull()
  })
})

describe('subscription-authenticated sessions', () => {
  test('only the two providers that have a subscription login declare one', () => {
    // A China preset is an API key like any other, and Anthropic/Grok have no
    // subscription path at all — declaring one would make their forms stop
    // writing the credentials they are the only source of.
    expect(specs.PROVIDER_SETUP_SPECS.openai.subscriptionAuth?.envKey).toBe(
      'OPENAI_AUTH_MODE',
    )
    expect(specs.PROVIDER_SETUP_SPECS.gemini.subscriptionAuth?.envKey).toBe(
      'GEMINI_AUTH_MODE',
    )
    for (const kind of ['anthropic', 'grok', 'china'] as const) {
      expect(specs.PROVIDER_SETUP_SPECS[kind].subscriptionAuth).toBeUndefined()
    }
  })

  test('the auth mode has to actually be set, and be one occ knows', () => {
    const spec = specs.PROVIDER_SETUP_SPECS.openai
    expect(specs.activeSubscriptionAuth(spec, {})).toBeUndefined()
    // An unknown value is not a licence to stop writing credentials.
    expect(
      specs.activeSubscriptionAuth(spec, {
        OPENAI_AUTH_MODE: 'something-else',
      }),
    ).toBeUndefined()
    expect(
      specs.activeSubscriptionAuth(spec, { OPENAI_AUTH_MODE: 'chatgpt' })
        ?.label,
    ).toBe('ChatGPT subscription')
    expect(
      specs.activeSubscriptionAuth(specs.PROVIDER_SETUP_SPECS.gemini, {
        GEMINI_AUTH_MODE: 'antigravity',
      })?.mode,
    ).toBe('antigravity')
  })

  test('the overrides are merged in, and only while the mode is active', () => {
    const spec = specs.PROVIDER_SETUP_SPECS.openai
    const active = specs.specForSubscriptionAuth(
      spec,
      specs.activeSubscriptionAuth(spec, { OPENAI_AUTH_MODE: 'chatgpt' }),
    )
    expect(active.defaultModelField).toBe('optional')
    expect(active.title({})).toBe('ChatGPT Subscription — Models')
    // Same env keys — a ChatGPT session is still the OpenAI family.
    expect(active.env).toEqual(spec.env)
    expect(specs.specForSubscriptionAuth(spec, undefined)).toBe(spec)
    expect(spec.defaultModelField).toBe('required')
  })

  test('a model-only save does not log the user out of ChatGPT', () => {
    // afterSave is shared by both paths; only the one that just wrote an API
    // key supersedes the subscription. Deleting the tokens on the other one is
    // how /models-setting used to end a working session.
    const spec = specs.PROVIDER_SETUP_SPECS.openai
    const clear = spyOn(
      openaiClient,
      'clearOpenAIClientCache',
    ).mockImplementation(() => {})
    const remove = spyOn(chatgptAuth, 'removeChatGPTAuth').mockResolvedValue(
      undefined as never,
    )
    try {
      return Promise.resolve(spec.afterSave?.({ credentialsConfigured: false }))
        .then(() => {
          // The cached client still has to go: it was built from the old env.
          expect(clear).toHaveBeenCalled()
          expect(remove).not.toHaveBeenCalled()
          return spec.afterSave?.({ credentialsConfigured: true })
        })
        .then(() => {
          expect(remove).toHaveBeenCalled()
        })
        .finally(() => {
          clear.mockRestore()
          remove.mockRestore()
        })
    } catch (error) {
      clear.mockRestore()
      remove.mockRestore()
      throw error
    }
  })
})

describe('built-in model tables', () => {
  test('only the providers occ maintains a table for have one', () => {
    // Gemini and Grok are deliberately absent: inventing third-party model ids
    // here means hand-maintaining a list that goes stale, which is the problem
    // endpoint discovery exists to avoid.
    expect(specs.PROVIDER_SETUP_SPECS.openai.presetModels).toBeDefined()
    expect(specs.PROVIDER_SETUP_SPECS.anthropic.presetModels).toBeDefined()
    expect(specs.PROVIDER_SETUP_SPECS.gemini.presetModels).toBeUndefined()
    expect(specs.PROVIDER_SETUP_SPECS.grok.presetModels).toBeUndefined()
    // The China presets carry their catalog on the status instead.
    expect(specs.PROVIDER_SETUP_SPECS.china.presetModels).toBeUndefined()
  })

  test('official endpoints fall back to their maintained model tables', () => {
    const anthropic =
      specs.PROVIDER_SETUP_SPECS.anthropic.presetModels?.({ baseUrl: '' }) ?? []
    expect(anthropic.length).toBeGreaterThan(0)
    expect(anthropic.every(m => m.id.startsWith('claude-'))).toBe(true)
    expect(anthropic.map(m => m.id)).toContain('claude-opus-5')

    const openai =
      specs.PROVIDER_SETUP_SPECS.openai.presetModels?.({ baseUrl: '' }) ?? []
    expect(openai.length).toBeGreaterThan(0)
    expect(openai.every(m => m.id.startsWith('gpt-'))).toBe(true)
  })

  test('custom compatible endpoints never inherit a protocol vendor catalog', () => {
    expect(
      specs.PROVIDER_SETUP_SPECS.openai.presetModels?.({
        baseUrl: 'https://gateway.example/v1',
      }),
    ).toEqual([])
    expect(
      specs.PROVIDER_SETUP_SPECS.anthropic.presetModels?.({
        baseUrl: 'https://opencode.ai/zen/go/v1',
      }),
    ).toEqual([])
  })

  test('every entry is a usable option — an empty id would render a blank row', () => {
    for (const kind of ['openai', 'anthropic'] as const) {
      for (const model of specs.PROVIDER_SETUP_SPECS[kind].presetModels?.({
        baseUrl: '',
      }) ?? []) {
        expect(model.id.length).toBeGreaterThan(0)
      }
    }
  })
})
