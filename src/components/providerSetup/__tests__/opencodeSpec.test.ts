/**
 * Tests for the OpenCode entry in the provider setup spec table.
 *
 * Kept separate from specs.test.ts because what is worth pinning here is
 * different: OpenCode is the one provider where the model choice decides the
 * WIRE PROTOCOL, where the auth-mode key is an activation switch rather than a
 * credential marker, and where the base URL selects between two PRODUCTS —
 * Zen (pay-as-you-go) and Go (subscription) — that share a host. All three are
 * invisible in the UI and all three fail silently: a session that lands on
 * /chat/completions with a `claude-*` tier set, a form that refuses to edit the
 * API key it wrote itself while claiming a subscription the user never signed
 * into, or a Go subscriber offered Zen's catalog and billed to a credit
 * balance they never funded.
 *
 * Only the log/debug leaves are mock.module'd (shared mocks, per CLAUDE.md);
 * everything asserted below is pure data.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

let specs: typeof import('../specs.js')
let catalog: typeof import('../../opencodeLogin/opencodeCatalog.js')
let providerUrl: typeof import('src/utils/network/providerUrl.js')

beforeAll(async () => {
  specs = await import('../specs.js')
  catalog = await import('../../opencodeLogin/opencodeCatalog.js')
  providerUrl = await import('src/utils/network/providerUrl.js')
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
  test('writes the OPENCODE_* keys and nobody else’s', () => {
    const spec = specs.PROVIDER_SETUP_SPECS.opencode
    expect(spec.modelType).toBe('opencode')
    expect(spec.env.baseUrl).toBe('OPENCODE_BASE_URL')
    expect(spec.env.apiKey).toBe('OPENCODE_API_KEY')
    expect(spec.env.model).toBe('OPENCODE_MODEL')
    expect(spec.env.tiers).toEqual({
      haiku_model: 'OPENCODE_DEFAULT_HAIKU_MODEL',
      sonnet_model: 'OPENCODE_DEFAULT_SONNET_MODEL',
      opus_model: 'OPENCODE_DEFAULT_OPUS_MODEL',
      fable_model: 'OPENCODE_DEFAULT_FABLE_MODEL',
    })
  })

  test('the default base URL is the Zen inference plane', () => {
    expect(specs.PROVIDER_SETUP_SPECS.opencode.defaultBaseUrl).toBe(
      'https://opencode.ai/zen/v1',
    )
  })

  test('the URL grammar keeps the /v1 segment the base URL needs', () => {
    // The Anthropic grammar strips a trailing `/v1`, which would silently
    // retarget every request at …/zen. The /messages lane re-derives its own
    // version segment at request time, so `openai` is the right grammar for
    // BOTH lanes here.
    const spec = specs.PROVIDER_SETUP_SPECS.opencode
    expect(spec.urlKind).toBe('openai')
    expect(
      providerUrl.normalizeProviderBaseURL(spec.defaultBaseUrl, spec.urlKind),
    ).toBe(spec.defaultBaseUrl)
    // …and the resource forms a user might paste still reduce to it.
    for (const pasted of [
      'https://opencode.ai/zen/v1/models',
      'https://opencode.ai/zen/v1/chat/completions',
      'https://opencode.ai/zen/v1/responses',
    ]) {
      expect(providerUrl.normalizeProviderBaseURL(pasted, spec.urlKind)).toBe(
        spec.defaultBaseUrl,
      )
    }
  })
})

describe('form shape', () => {
  test('the default model is mandatory — it is what picks the lane', () => {
    const spec = specs.PROVIDER_SETUP_SPECS.opencode
    expect(spec.defaultModelField).toBe('required')
    expect(spec.validate(values())?.field).toBe('model')
    expect(spec.validate(values({ model: 'claude-opus-5' }))).toBeNull()
    // Tier models are not a substitute: the lane is read off OPENCODE_MODEL
    // alone, so a form satisfied by tiers would leave it unset and fall to
    // /chat/completions with four Anthropic tiers configured.
    expect(
      spec.validate(
        values({
          haiku_model: 'claude-haiku-4-5',
          sonnet_model: 'claude-sonnet-5',
          opus_model: 'claude-opus-5',
          fable_model: 'claude-fable-5',
        }),
      )?.field,
    ).toBe('model')
  })

  test('neither the base URL nor a key is demanded up front', () => {
    const spec = specs.PROVIDER_SETUP_SPECS.opencode
    expect(spec.hasEndpointStep).toBe(true)
    expect(spec.baseUrlRequired).toBe(false)
    // The free tier answers for `Authorization: Bearer public` with no account
    // at all, so an empty key must drop through to the catalog, not error.
    expect(spec.apiKeyRequired).toBe(false)
  })

  test('all four tier slots are offered', () => {
    expect([...specs.PROVIDER_SETUP_SPECS.opencode.tiers]).toEqual([
      'haiku_model',
      'sonnet_model',
      'opus_model',
      'fable_model',
    ])
  })
})

describe('save-time extras', () => {
  test('the auth mode is SET, not cleared — it is what activates OpenCode', () => {
    // Every other provider's *_AUTH_MODE entry here clears a subscription
    // route. OpenCode's is the switch that points the session at OpenCode at all
    // (opencodeWire.ts), so a key session has to write it too or the mirror
    // never runs and requests go to the previous provider's host.
    expect(specs.PROVIDER_SETUP_SPECS.opencode.extraEnv?.({})).toEqual({
      OPENCODE_AUTH_MODE: 'opencode',
    })
  })
})

describe('subscription-authenticated sessions', () => {
  test('the Console login owns the credentials only while no key is set', () => {
    const spec = specs.PROVIDER_SETUP_SPECS.opencode
    expect(spec.subscriptionAuth?.envKey).toBe('OPENCODE_AUTH_MODE')
    expect(spec.subscriptionAuth?.onlyWhenUnset).toBe('OPENCODE_API_KEY')
    expect(
      specs.activeSubscriptionAuth(spec, { OPENCODE_AUTH_MODE: 'opencode' })
        ?.label,
    ).toBe('OpenCode Console subscription')
    // With a key present the credential is the form's own, and locking it out
    // would leave the user unable to edit what they typed themselves.
    expect(
      specs.activeSubscriptionAuth(spec, {
        OPENCODE_AUTH_MODE: 'opencode',
        OPENCODE_API_KEY: 'zen-key',
      }),
    ).toBeUndefined()
    // Whitespace is not a key.
    expect(
      specs.activeSubscriptionAuth(spec, {
        OPENCODE_AUTH_MODE: 'opencode',
        OPENCODE_API_KEY: '   ',
      }),
    ).toBeDefined()
    expect(specs.activeSubscriptionAuth(spec, {})).toBeUndefined()
  })

  test('onlyWhenUnset does not disturb the providers that omit it', () => {
    for (const kind of ['openai', 'gemini'] as const) {
      expect(
        specs.PROVIDER_SETUP_SPECS[kind].subscriptionAuth?.onlyWhenUnset,
      ).toBeUndefined()
    }
    expect(
      specs.activeSubscriptionAuth(specs.PROVIDER_SETUP_SPECS.openai, {
        OPENAI_AUTH_MODE: 'chatgpt',
        OPENAI_API_KEY: 'sk-test',
      })?.mode,
    ).toBe('chatgpt')
  })

  test('a subscription only renames the heading — the model stays required', () => {
    const spec = specs.PROVIDER_SETUP_SPECS.opencode
    const active = specs.specForSubscriptionAuth(
      spec,
      specs.activeSubscriptionAuth(spec, { OPENCODE_AUTH_MODE: 'opencode' }),
    )
    expect(active.title({})).toBe('OpenCode Zen — Models')
    // Unlike ChatGPT, whose backend maps each tier itself, Zen has no per-tier
    // resolution — and the lane still comes from OPENCODE_MODEL.
    expect(active.defaultModelField).toBe('required')
    expect(active.env).toEqual(spec.env)
  })
})

describe('the shipped catalogs', () => {
  const presetIds = (baseUrl: string): string[] =>
    (specs.PROVIDER_SETUP_SPECS.opencode.presetModels?.({ baseUrl }) ?? []).map(
      model => model.id,
    )

  test('official endpoints get the read-off-the-service table', () => {
    const spec = specs.PROVIDER_SETUP_SPECS.opencode
    const models = spec.presetModels?.({ baseUrl: '' }) ?? []
    expect(models).toHaveLength(catalog.OPENCODE_PRODUCTS.zen.models.length)
    expect(models.map(model => model.id)).toContain('claude-opus-5')
    expect(models.every(model => model.id.length > 0)).toBe(true)
    // An explicitly typed official base URL is the same endpoint.
    expect(
      spec.presetModels?.({ baseUrl: 'https://opencode.ai/zen/v1' }),
    ).toHaveLength(catalog.OPENCODE_PRODUCTS.zen.models.length)
  })

  test('a Go base URL gets Go’s table, never Zen’s', () => {
    // THE regression this file exists to catch. The old gate was
    // usesOfficialEndpoint(context, 'opencode.ai'), which compares hosts —
    // and both products live on that host. A Go subscriber whose /models
    // fetch failed was therefore offered Zen's 61 models; picking one bills
    // the Zen credit balance and answers "Insufficient balance", a message
    // that mentions neither product.
    const ids = presetIds('https://opencode.ai/zen/go/v1')
    expect(ids).toEqual([...catalog.OPENCODE_PRODUCTS.go.models])
    expect(ids).toHaveLength(25)
    expect(ids.some(id => id.startsWith('claude-'))).toBe(false)
    expect(ids).toContain('kimi-k3')
    // …and the Zen-only ids are absent, not merely outnumbered.
    for (const zenOnly of ['claude-opus-5', 'gemini-3.1-pro', 'gpt-5.5-pro']) {
      expect(ids).not.toContain(zenOnly)
    }
  })

  test('a resource path under either product still resolves to it', () => {
    // What the wizard hands presetModels is the normalized base URL, but a
    // pasted `…/models` or `…/chat/completions` reduces to the same base, so
    // both spellings have to land on the same table.
    for (const pasted of [
      'https://opencode.ai/zen/go/v1',
      'https://opencode.ai/zen/go/v1/',
    ]) {
      expect(presetIds(pasted)).toHaveLength(25)
    }
    expect(
      providerUrl.normalizeProviderBaseURL(
        'https://opencode.ai/zen/go/v1/chat/completions',
        specs.PROVIDER_SETUP_SPECS.opencode.urlKind,
      ),
    ).toBe('https://opencode.ai/zen/go/v1')
  })

  test('a custom endpoint never inherits either catalog', () => {
    // A compatible wire protocol is not catalog ownership: a self-hosted
    // deployment serves its own models, and offering it OpenCode's would let
    // the user save one that endpoint cannot answer for. An unpublished path
    // on opencode.ai itself is in the same position.
    expect(presetIds('https://gateway.example/v1')).toEqual([])
    expect(presetIds('https://opencode.ai/zen/v2')).toEqual([])
    expect(presetIds('https://opencode.ai/')).toEqual([])
  })

  test('every option shows the wire protocol it will be sent on', () => {
    const models = specs.PROVIDER_SETUP_SPECS.opencode.presetModels?.({
      baseUrl: '',
    })
    const labelOf = (id: string): string | undefined =>
      models?.find(model => model.id === id)?.displayName
    expect(labelOf('claude-opus-5')).toBe('claude-opus-5 · /messages')
    expect(labelOf('gpt-5.6-luna')).toBe('gpt-5.6-luna · /responses')
    expect(labelOf('kimi-k3')).toBe('kimi-k3 · /chat/completions')
    expect(labelOf('mimo-v2.5-free')).toBe('mimo-v2.5-free · /chat/completions')
  })
})

describe('naming the endpoint on screen', () => {
  const spec = (): import('../specs.js').ProviderSetupSpec =>
    specs.PROVIDER_SETUP_SPECS.opencode

  test('the heading says which product, not just “OpenCode”', () => {
    expect(spec().title({ baseUrl: 'https://opencode.ai/zen/v1' })).toBe(
      'OpenCode Zen Setup',
    )
    expect(spec().title({ baseUrl: 'https://opencode.ai/zen/go/v1' })).toBe(
      'OpenCode Go Setup',
    )
    // Nothing is claimed about an endpoint occ has not read.
    expect(spec().title({ baseUrl: 'https://gateway.example/v1' })).toBe(
      'OpenCode Setup',
    )
  })

  test('the endpoint hint names the other product and its URL', () => {
    // The two are one path segment apart, and the wrong one is reported only
    // as a CreditsError from the other balance — so switching has to be a
    // matter of pasting the URL that is already on screen.
    const go = spec().endpointHint({ baseUrl: 'https://opencode.ai/zen/go/v1' })
    expect(go).toContain('OpenCode Go')
    expect(go).toContain('flat monthly subscription')
    expect(go).toContain('https://opencode.ai/zen/v1')
    const zen = spec().endpointHint({ baseUrl: '' })
    expect(zen).toContain('pay-as-you-go')
    expect(zen).toContain('https://opencode.ai/zen/go/v1')
  })

  test('a subscription session keeps the product in the heading', () => {
    // The endpoint step is skipped in this mode, so the title is the only
    // place left that says which endpoint the session talks to.
    const active = specs.specForSubscriptionAuth(
      spec(),
      specs.activeSubscriptionAuth(spec(), { OPENCODE_AUTH_MODE: 'opencode' }),
    )
    expect(active.title({ baseUrl: 'https://opencode.ai/zen/go/v1' })).toBe(
      'OpenCode Go — Models',
    )
  })
})
