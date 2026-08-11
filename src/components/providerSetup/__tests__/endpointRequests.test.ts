/**
 * Tests for what step 1 asks the endpoint, and for the one answer that stops
 * the flow there.
 *
 * Two things are pinned. The first is that a spec WITHOUT a credential check
 * takes exactly the path it always took — one request, the same arguments, the
 * same fallback when there is no key — because five of the six providers have
 * no check and must not pay for OpenCode's problem. The second is that a
 * refusal never becomes a step-2 status: step 1 is the last place where
 * "nothing has been written yet" is free, and letting a refused credential
 * through produces the failure this whole mechanism exists to prevent (a REPL
 * that names a model and answers `Invalid API key` to everything).
 *
 * No probe is mocked. `runEndpointRequests` takes the spec as data, so both
 * halves are injected as plain functions — which is also the only way to test
 * a WRONG credential, since the live service cannot be asked on a user's
 * behalf. Only the log/debug leaves are mock.module'd, per CLAUDE.md.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

let endpointRequests: typeof import('../endpointRequests.js')
let specs: typeof import('../specs.js')

beforeAll(async () => {
  endpointRequests = await import('../endpointRequests.js')
  specs = await import('../specs.js')
})

type Spec = import('../specs.js').ProviderSetupSpec

/** A spec is data; overriding two fields needs no mocking machinery. */
function specWith(overrides: Partial<Spec>): Spec {
  return { ...specs.PROVIDER_SETUP_SPECS.openai, ...overrides }
}

describe('providers that declare no credential check', () => {
  test('every provider but OpenCode leaves the hook unset', () => {
    // The gate for "unaffected": an absent hook is an absent call, so the five
    // other providers run the exact request sequence they ran before.
    for (const [kind, spec] of Object.entries(specs.PROVIDER_SETUP_SPECS)) {
      if (kind === 'opencode') continue
      expect(spec.verifyCredential).toBeUndefined()
    }
  })

  test('the catalog answer is handed straight through', async () => {
    const seen: unknown[] = []
    const outcome = await endpointRequests.runEndpointRequests({
      spec: specWith({
        fetchModels: async args => {
          seen.push(args)
          return [{ id: 'gpt-5.5' }]
        },
      }),
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    })

    expect(outcome).toEqual({
      proceed: true,
      models: [{ id: 'gpt-5.5' }],
      failureReason: 'the request failed',
    })
    expect(seen).toHaveLength(1)
  })

  test('a keyless provider still skips the request instead of erroring', async () => {
    // Keyless local gateways (a vLLM behind a compatible shim) were
    // configurable before the wizard existed; `apiKeyRequired: false` is what
    // keeps them that way, and the reason shown is what step 2 prints.
    let called = false
    const outcome = await endpointRequests.runEndpointRequests({
      spec: specWith({
        apiKeyRequired: false,
        fetchModels: async () => {
          called = true
          return null
        },
      }),
      baseURL: 'http://localhost:8000/v1',
      apiKey: '',
    })

    expect(called).toBe(false)
    expect(outcome).toEqual({
      proceed: true,
      models: null,
      failureReason:
        'no API key was provided, so the model list could not be requested',
    })
  })

  test('the fetcher’s own reason survives to step 2', async () => {
    const outcome = await endpointRequests.runEndpointRequests({
      spec: specWith({
        fetchModels: async ({ onError }) => {
          onError?.('the /models endpoint was not found (HTTP 404)')
          return null
        },
      }),
      baseURL: 'https://gw.example/v1',
      apiKey: 'sk-test',
    })

    expect(outcome).toEqual({
      proceed: true,
      models: null,
      failureReason: 'the /models endpoint was not found (HTTP 404)',
    })
  })
})

describe('a spec that does declare one', () => {
  test('a refusal never becomes a step-2 status', async () => {
    // THE regression. Reaching step 2 is what makes a bad credential
    // configurable: the model picker fills from a /models request that needs no
    // credential, and the save that follows writes modelType, the endpoint and
    // the key before anything has ever sent it.
    const outcome = await endpointRequests.runEndpointRequests({
      spec: specWith({
        fetchModels: async () => [{ id: 'claude-opus-5' }],
        verifyCredential: async () => ({
          ok: false,
          message: 'OpenCode Go refused this API key.',
        }),
      }),
      baseURL: 'https://opencode.ai/zen/go/v1',
      apiKey: 'bad-key',
    })

    expect(outcome).toEqual({
      proceed: false,
      message: 'OpenCode Go refused this API key.',
    })
  })

  test('an accepted credential proceeds with the catalog intact', async () => {
    const outcome = await endpointRequests.runEndpointRequests({
      spec: specWith({
        fetchModels: async () => [{ id: 'kimi-k3' }],
        verifyCredential: async () => ({ ok: true }),
      }),
      baseURL: 'https://opencode.ai/zen/go/v1',
      apiKey: 'good-key',
    })

    expect(outcome).toEqual({
      proceed: true,
      models: [{ id: 'kimi-k3' }],
      failureReason: 'the request failed',
    })
  })

  test('the check is given the catalog, the endpoint and the abort signal', async () => {
    // The catalog is not decoration: a probe has to name a model the endpoint
    // serves, and the signal is what makes Esc abort the request rather than
    // leave it running behind a screen that is gone.
    const controller = new AbortController()
    let args: unknown
    await endpointRequests.runEndpointRequests({
      spec: specWith({
        fetchModels: async () => [{ id: 'kimi-k3' }],
        verifyCredential: async received => {
          args = received
          return { ok: true }
        },
      }),
      baseURL: 'https://opencode.ai/zen/go/v1',
      apiKey: 'good-key',
      signal: controller.signal,
    })

    expect(args).toEqual({
      baseURL: 'https://opencode.ai/zen/go/v1',
      apiKey: 'good-key',
      models: [{ id: 'kimi-k3' }],
      signal: controller.signal,
    })
  })

  test('an empty key is checked too — that is the whole Go case', async () => {
    // Skipping the check when the model request was skipped would hand Go
    // subscribers the original bug back: Go has no free tier, so a session
    // configured with no credential cannot answer one request.
    let checked = false
    const outcome = await endpointRequests.runEndpointRequests({
      spec: specWith({
        apiKeyRequired: false,
        fetchModels: async () => null,
        verifyCredential: async ({ models }) => {
          checked = true
          expect(models).toBeNull()
          return { ok: false, message: 'no free tier here' }
        },
      }),
      baseURL: 'https://opencode.ai/zen/go/v1',
      apiKey: '',
    })

    expect(checked).toBe(true)
    expect(outcome).toEqual({ proceed: false, message: 'no free tier here' })
  })
})
