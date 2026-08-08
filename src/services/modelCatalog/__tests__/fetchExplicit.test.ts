/**
 * Tests for the explicit-credential model-list fetchers used by the provider
 * setup wizard.
 *
 * These run before anything is written to settings, on a base URL and key the
 * user just typed, so the interesting surface is the failure vocabulary: every
 * reason string here is shown verbatim in the step-2 "could not fetch" banner
 * and is what tells the user whether to fix the URL, the key, or just type the
 * model name.
 *
 * `fetchImpl` is injected, so nothing here touches the network. Only the
 * log/debug leaves are mock.module'd (shared mocks, per CLAUDE.md).
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

let explicit: typeof import('../fetchExplicit.js')

beforeAll(async () => {
  explicit = await import('../fetchExplicit.js')
})

type FetchCall = { url: string; init: RequestInit | undefined }

function makeFetch(
  response: { status?: number; body?: unknown; invalidJson?: boolean } | Error,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (response instanceof Error) throw response
    return {
      ok: (response.status ?? 200) >= 200 && (response.status ?? 200) < 300,
      status: response.status ?? 200,
      json: async () => {
        if (response.invalidJson) throw new Error('Unexpected token')
        return response.body
      },
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function capture(): { onError: (reason: string) => void; reasons: string[] } {
  const reasons: string[] = []
  return { onError: reason => reasons.push(reason), reasons }
}

describe('fetchAnthropicCompatibleModelsWith', () => {
  test('parses the model list and sends Anthropic auth headers', async () => {
    const { fetchImpl, calls } = makeFetch({
      body: {
        data: [
          { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
          { id: 'claude-haiku-4-5', created_at: '2026-01-02T00:00:00Z' },
        ],
      },
    })

    const models = await explicit.fetchAnthropicCompatibleModelsWith({
      baseURL: 'https://gw.example.com',
      apiKey: 'sk-test',
      fetchImpl,
    })

    expect(models).toEqual([
      { id: 'claude-opus-5', displayName: 'Claude Opus 5' },
      { id: 'claude-haiku-4-5', created: 1767312000 },
    ])
    expect(calls[0]?.url).toBe('https://gw.example.com/v1/models?limit=200')
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  test('does not double version or resource paths and preserves query values', async () => {
    const { fetchImpl, calls } = makeFetch({ body: { data: [{ id: 'm' }] } })
    await explicit.fetchAnthropicCompatibleModelsWith({
      baseURL:
        'https://gw.example.com/Tenant/V1/MESSAGES/?api-version=AbC#wrong',
      apiKey: 'sk-test',
      fetchImpl,
    })
    expect(calls[0]?.url).toBe(
      'https://gw.example.com/Tenant/v1/models?api-version=AbC&limit=200',
    )
  })

  test.each([
    [401, 'authentication failed (HTTP 401)'],
    [403, 'authentication failed (HTTP 403)'],
    [404, 'the /models endpoint was not found (HTTP 404)'],
    [500, 'the server returned HTTP 500'],
  ])('reports HTTP %i as a user-readable reason', async (status, reason) => {
    const { fetchImpl } = makeFetch({ status })
    const { onError, reasons } = capture()

    const models = await explicit.fetchAnthropicCompatibleModelsWith({
      baseURL: 'https://gw.example.com',
      apiKey: 'sk-test',
      fetchImpl,
      onError,
    })

    expect(models).toBeNull()
    expect(reasons).toEqual([reason])
  })

  test('an endpoint that answers with the wrong shape is not a crash', async () => {
    const { fetchImpl } = makeFetch({ body: { error: 'nope' } })
    const { onError, reasons } = capture()

    expect(
      await explicit.fetchAnthropicCompatibleModelsWith({
        baseURL: 'https://gw.example.com',
        apiKey: 'sk-test',
        fetchImpl,
        onError,
      }),
    ).toBeNull()
    expect(reasons).toEqual(['the model list was not in the expected format'])
  })

  test('an empty list is a failure, not an empty picker', async () => {
    const { fetchImpl } = makeFetch({ body: { data: [] } })
    const { onError, reasons } = capture()

    expect(
      await explicit.fetchAnthropicCompatibleModelsWith({
        baseURL: 'https://gw.example.com',
        apiKey: 'sk-test',
        fetchImpl,
        onError,
      }),
    ).toBeNull()
    expect(reasons).toEqual(['the server returned an empty model list'])
  })

  test('a non-JSON body is reported rather than thrown', async () => {
    const { fetchImpl } = makeFetch({ invalidJson: true })
    const { onError, reasons } = capture()

    expect(
      await explicit.fetchAnthropicCompatibleModelsWith({
        baseURL: 'https://gw.example.com',
        apiKey: 'sk-test',
        fetchImpl,
        onError,
      }),
    ).toBeNull()
    expect(reasons).toEqual(['the server returned a response that is not JSON'])
  })

  test('a network failure is reported rather than thrown', async () => {
    const { fetchImpl } = makeFetch(new Error('getaddrinfo ENOTFOUND gw'))
    const { onError, reasons } = capture()

    expect(
      await explicit.fetchAnthropicCompatibleModelsWith({
        baseURL: 'https://gw.example.com',
        apiKey: 'sk-test',
        fetchImpl,
        onError,
      }),
    ).toBeNull()
    expect(reasons).toEqual(['getaddrinfo ENOTFOUND gw'])
  })

  test.each([
    [{ baseURL: '', apiKey: 'k' }, 'the base URL is empty'],
    [{ baseURL: 'https://gw', apiKey: '' }, 'the API key is empty'],
    [{ baseURL: 'not a url', apiKey: 'k' }, 'the base URL is not a valid URL'],
  ])('rejects bad input before touching the network', async (args, reason) => {
    const { fetchImpl, calls } = makeFetch({ body: { data: [{ id: 'm' }] } })
    const { onError, reasons } = capture()

    expect(
      await explicit.fetchAnthropicCompatibleModelsWith({
        ...args,
        fetchImpl,
        onError,
      }),
    ).toBeNull()
    expect(reasons).toEqual([reason])
    expect(calls).toEqual([])
  })
})

describe('fetchGeminiModelsWith', () => {
  test('strips the models/ prefix and drops non-generation models', async () => {
    const { fetchImpl, calls } = makeFetch({
      body: {
        models: [
          {
            name: 'models/gemini-3-pro',
            displayName: 'Gemini 3 Pro',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/text-embedding-004',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
      },
    })

    const models = await explicit.fetchGeminiModelsWith({
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'goog-key',
      fetchImpl,
    })

    expect(models).toEqual([
      { id: 'gemini-3-pro', displayName: 'Gemini 3 Pro' },
    ])
    expect(calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
    )
    expect(
      (calls[0]?.init?.headers as Record<string, string>)['x-goog-api-key'],
    ).toBe('goog-key')
  })

  test('canonicalizes a complete Gemini resource URL', async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { models: [{ name: 'models/gemini-pro' }] },
    })
    await explicit.fetchGeminiModelsWith({
      baseURL:
        'https://gateway.example/v1beta/models/gemini-old:generateContent?tenant=AbC#wrong',
      apiKey: 'goog-key',
      fetchImpl,
    })
    expect(calls[0]?.url).toBe(
      'https://gateway.example/v1beta/models?tenant=AbC&pageSize=200',
    )
  })

  test('a list with only embedding models reads as empty, not as success', async () => {
    const { fetchImpl } = makeFetch({
      body: {
        models: [
          {
            name: 'models/text-embedding-004',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
      },
    })
    const { onError, reasons } = capture()

    expect(
      await explicit.fetchGeminiModelsWith({
        baseURL: 'https://gw.example.com/v1beta',
        apiKey: 'goog-key',
        fetchImpl,
        onError,
      }),
    ).toBeNull()
    expect(reasons).toEqual(['the server returned an empty model list'])
  })
})

describe('describeOpenAICompatibleModelsFetchError', () => {
  test("unwraps Node fetch's cause — 'fetch failed' alone is not actionable", () => {
    // This string is shown verbatim in the setup form's fallback banner, and
    // it is what tells the user whether the URL, the port, or the network is
    // at fault.
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:9'),
    })
    expect(explicit.describeOpenAICompatibleModelsFetchError(error)).toBe(
      'fetch failed (connect ECONNREFUSED 127.0.0.1:9)',
    )
  })

  test('a cause that merely repeats the message is not appended twice', () => {
    const error = Object.assign(new Error('boom'), { cause: new Error('boom') })
    expect(explicit.describeOpenAICompatibleModelsFetchError(error)).toBe(
      'boom',
    )
  })

  test('an HTTP status still wins over the transport vocabulary', () => {
    expect(
      explicit.describeOpenAICompatibleModelsFetchError({ status: 401 }),
    ).toBe('authentication failed (HTTP 401)')
  })
})
