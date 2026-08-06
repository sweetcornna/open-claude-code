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
import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

let specs: typeof import('../specs.js')

beforeAll(async () => {
  specs = await import('../specs.js')
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

  test('no other provider writes extra env', () => {
    for (const kind of ['anthropic', 'gemini', 'grok'] as const) {
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
  test('never writes OPENAI_MODEL — that key would defeat /model <id>', () => {
    // The whole point of configuring a China provider is that one key makes the
    // catalog switchable. OPENAI_MODEL outranks both the family aliases and an
    // explicit `/model <id>`, so it must stay unset; `omitted` is what stops the
    // wizard from writing it.
    expect(specs.PROVIDER_SETUP_SPECS.china.defaultModelField).toBe('omitted')
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

  test('all four tiers are offered and nothing is mandatory', () => {
    const spec = specs.PROVIDER_SETUP_SPECS.china
    expect([...spec.tiers]).toEqual([
      'haiku_model',
      'sonnet_model',
      'opus_model',
      'fable_model',
    ])
    expect(spec.validate(values())).toBeNull()
  })
})
