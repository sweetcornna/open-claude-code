/**
 * Tests for the pure half of the OpenCode Console login.
 *
 * Two properties are worth pinning because both fail silently:
 *
 *   - the login clears `OPENCODE_API_KEY`. Precedence is key-over-OAuth, so a
 *     key left behind by an earlier run makes the login that just succeeded
 *     inert, and nothing surfaces that — the session simply keeps billing the
 *     old credential.
 *   - the model step it opens is `credentialEditing: 'locked'` and carries an
 *     EMPTY api key. The wizard writes that field to settings.env, so the one
 *     thing this screen must never do is hand it the access token.
 *
 * Both modules under test are pure; only the log/debug leaves are mocked
 * (shared mocks, per CLAUDE.md), and only because the spec table they read
 * reaches the telemetry bootstrap.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

let plan: typeof import('../loginPlan.js')
let catalog: typeof import('../opencodeCatalog.js')

beforeAll(async () => {
  plan = await import('../loginPlan.js')
  catalog = await import('../opencodeCatalog.js')
})

const ZEN = 'https://opencode.ai/zen/v1'

const NO_PREFILL = { maxContext: '', effort: '' }

describe('buildOpencodeConsoleEnv', () => {
  test('activates the provider and drops a key that would outrank it', () => {
    expect(plan.buildOpencodeConsoleEnv(ZEN)).toEqual({
      OPENCODE_AUTH_MODE: 'opencode',
      OPENCODE_BASE_URL: ZEN,
      OPENCODE_API_KEY: undefined,
      // Absence is the Zen/Go kind, so the marker is cleared rather than left
      // to whatever an earlier Console login on this machine wrote.
      OPENCODE_INFERENCE_PLANE: undefined,
    })
  })

  test('a Console login marks the plane its endpoint came from', () => {
    // `/api/config` named this URL and the token is accepted there and refused
    // at Zen, so the marker is what tells the mirror to stop choosing lanes:
    // that plane serves /chat/completions and answers /messages with 404.
    expect(
      plan.buildOpencodeConsoleEnv(
        'https://console.opencode.ai/inference/openai/v1',
        'console',
      ),
    ).toEqual({
      OPENCODE_AUTH_MODE: 'opencode',
      OPENCODE_BASE_URL: 'https://console.opencode.ai/inference/openai/v1',
      OPENCODE_API_KEY: undefined,
      OPENCODE_INFERENCE_PLANE: 'console',
    })
  })

  test('the base URL is written explicitly, never left to a default', () => {
    // applyOpencodeWire() returns early without OPENCODE_BASE_URL, so an unset
    // value is not "use the default" — it is "do not route this session".
    const env = plan.buildOpencodeConsoleEnv('https://zen.internal/v1')
    expect(env.OPENCODE_BASE_URL).toBe('https://zen.internal/v1')
  })
})

describe('describeOpencodeAccount', () => {
  test('joins whatever the console was willing to say', () => {
    expect(
      plan.describeOpencodeAccount({ email: 'a@b.co', orgName: 'Acme' }),
    ).toBe('a@b.co · Acme')
    expect(plan.describeOpencodeAccount({ orgName: 'Acme' })).toBe('Acme')
  })

  test('an account it could not describe reads as nothing at all', () => {
    // A token that works for inference must not be reported as an empty
    // "Signed in as" line just because /api/user was unreachable.
    expect(plan.describeOpencodeAccount({})).toBeUndefined()
    expect(plan.describeOpencodeAccount({ email: '  ' })).toBeUndefined()
  })
})

describe('buildOpencodeModelStep', () => {
  const models = [{ id: 'claude-opus-5' }, { id: 'gpt-5.6-luna' }]

  test('opens in model-only mode with no credential of its own', () => {
    const step = plan.buildOpencodeModelStep({
      baseUrl: ZEN,
      models,
      prefill: NO_PREFILL,
      env: {},
    })
    expect(step.kind).toBe('opencode')
    expect(step.credentialEditing).toBe('locked')
    // The access token lives in the 0600 file; this field goes to settings.env.
    expect(step.apiKey).toBe('')
    expect(step.baseUrl).toBe(ZEN)
    expect(step.activeField).toBe('model')
  })

  test('seeds the current configuration from the OPENCODE_* keys', () => {
    const step = plan.buildOpencodeModelStep({
      baseUrl: ZEN,
      models,
      prefill: { maxContext: '200000', effort: 'high' },
      env: {
        OPENCODE_MODEL: 'claude-opus-5',
        OPENCODE_DEFAULT_HAIKU_MODEL: 'gpt-5.6-luna',
      },
    })
    expect(step.model).toBe('claude-opus-5')
    expect(step.haikuModel).toBe('gpt-5.6-luna')
    expect(step.sonnetModel).toBe('')
    expect(step.maxContext).toBe('200000')
    expect(step.effort).toBe('high')
  })

  test('drops a configured model this account cannot reach', () => {
    // Entitlement is per-org: a model the plan excludes must not stay selected
    // just because a previous configuration named it, or the first request
    // fails on a value the user was never shown a chance to change.
    const step = plan.buildOpencodeModelStep({
      baseUrl: ZEN,
      models,
      prefill: NO_PREFILL,
      env: {
        OPENCODE_MODEL: 'claude-opus-5',
        OPENCODE_DEFAULT_OPUS_MODEL: 'gpt-5.5-pro',
      },
    })
    expect(step.model).toBe('claude-opus-5')
    expect(step.opusModel).toBe('')
  })

  test('a catalog answer becomes a picker', () => {
    const step = plan.buildOpencodeModelStep({
      baseUrl: ZEN,
      models,
      prefill: NO_PREFILL,
      env: {},
    })
    expect(step.entryMode).toBe('catalog')
    if (step.entryMode === 'catalog') expect(step.models).toEqual(models)
  })

  test('no catalog falls back to typing, keeping the configured values', () => {
    // Nothing was verified against, so nothing may be dropped either.
    const step = plan.buildOpencodeModelStep({
      baseUrl: ZEN,
      models: null,
      prefill: NO_PREFILL,
      fetchError: 'the console was unreachable',
      env: { OPENCODE_MODEL: 'kimi-k3' },
    })
    expect(step.entryMode).toBe('manual')
    if (step.entryMode === 'manual') {
      expect(step.fetchError).toBe('the console was unreachable')
    }
    expect(step.model).toBe('kimi-k3')
  })

  test('an empty catalog is treated as no catalog', () => {
    // `entryMode: 'catalog'` with nothing in it renders a picker with no
    // options, which is a dead end rather than a fallback.
    const step = plan.buildOpencodeModelStep({
      baseUrl: ZEN,
      models: [],
      prefill: NO_PREFILL,
      env: {},
    })
    expect(step.entryMode).toBe('manual')
  })
})

describe('the shipped catalogs', () => {
  test('the lane suffix is the path the request is actually sent to', () => {
    expect(catalog.laneSuffixFor('claude-opus-5')).toBe('/messages')
    expect(catalog.laneSuffixFor('gpt-5.3-codex')).toBe('/responses')
    expect(catalog.laneSuffixFor('deepseek-v4-pro')).toBe('/chat/completions')
    expect(catalog.laneSuffixFor('big-pickle')).toBe('/chat/completions')
  })

  test('labelling never changes the value that gets saved', () => {
    const labelled = catalog.withLaneLabels([
      { id: 'claude-opus-5' },
      { id: 'gpt-5', displayName: 'GPT-5' },
    ])
    expect(labelled?.map(model => model.id)).toEqual(['claude-opus-5', 'gpt-5'])
    // A display name the endpoint supplied is kept, with the lane appended.
    expect(labelled?.[1]?.displayName).toBe('GPT-5 · /responses')
    expect(catalog.withLaneLabels(null)).toBeNull()
  })

  test('the free tier is recognised by rule, not by a list that rots', () => {
    expect(catalog.isFreeZenModel('mimo-v2.5-free')).toBe(true)
    expect(catalog.isFreeZenModel('big-pickle')).toBe(true)
    expect(catalog.isFreeZenModel('claude-opus-5')).toBe(false)
    // The shipped table still has to agree with the rule, or the login screen
    // advertises a count nobody can reproduce.
    expect(
      catalog.OPENCODE_PRODUCTS.zen.models.filter(catalog.isFreeZenModel),
    ).toHaveLength(9)
    // Go has no free tier at all, which is why its credential screen drops the
    // "free models only" row instead of offering an empty picker.
    expect(
      catalog.OPENCODE_PRODUCTS.go.models.filter(catalog.isFreeZenModel),
    ).toHaveLength(0)
  })

  test('every shipped id is a usable option', () => {
    for (const product of ['zen', 'go'] as const) {
      const ids = catalog.OPENCODE_PRODUCTS[product].models
      for (const id of ids) {
        expect(id.trim()).toBe(id)
        expect(id.length).toBeGreaterThan(0)
      }
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  test('the two products are the sizes the service reported', () => {
    // Read off `GET {base}/models` on 2026-08-10. The counts are the cheapest
    // signal that one table was edited without the other.
    expect(catalog.OPENCODE_PRODUCTS.zen.models).toHaveLength(61)
    expect(catalog.OPENCODE_PRODUCTS.go.models).toHaveLength(25)
  })

  test('Go serves no Claude, so no Go id can route to /messages', () => {
    // The lane is derived from the model id (opencodeWire.ts) and Go's
    // /messages only forwards — a `claude-*` id here would produce an upstream
    // "messages must not be empty" with occ nowhere in the message.
    for (const id of catalog.OPENCODE_PRODUCTS.go.models) {
      expect(catalog.laneSuffixFor(id)).not.toBe('/messages')
    }
    expect(catalog.laneSuffixFor('gpt-5.6-luna')).toBe('/responses')
  })
})

describe('which product a base URL names', () => {
  test('the two products are told apart by PATH, not by host', () => {
    // Both live on opencode.ai. A host comparison — which is what
    // usesOfficialEndpoint does — answers "official OpenCode" for either.
    expect(
      catalog.opencodeProductForBaseUrl('https://opencode.ai/zen/v1'),
    ).toBe('zen')
    expect(
      catalog.opencodeProductForBaseUrl('https://opencode.ai/zen/go/v1'),
    ).toBe('go')
  })

  test('an empty base URL is the spec default, which is Zen', () => {
    expect(catalog.opencodeProductForBaseUrl('')).toBe('zen')
    expect(catalog.opencodeProductForBaseUrl(undefined)).toBe('zen')
  })

  test('trailing slashes and whitespace do not change the answer', () => {
    expect(
      catalog.opencodeProductForBaseUrl('  https://opencode.ai/zen/go/v1/  '),
    ).toBe('go')
  })

  test('an unrecognised endpoint is named by neither product', () => {
    // Including unpublished paths on opencode.ai itself: occ can describe the
    // two products it has read, and guessing about a third is how a catalog
    // that does not apply gets offered.
    expect(
      catalog.opencodeProductForBaseUrl('https://opencode.ai/zen/v2'),
    ).toBeUndefined()
    expect(
      catalog.opencodeProductForBaseUrl('https://gateway.example/v1'),
    ).toBeUndefined()
    expect(catalog.opencodeProductForBaseUrl('not a url')).toBeUndefined()
  })
})
