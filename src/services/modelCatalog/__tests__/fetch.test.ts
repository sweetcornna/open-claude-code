import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)

const {
  buildAnthropicAuthHeaders,
  fetchProviderModels,
  parseAnthropicModelsResponse,
  parseGeminiModelsResponse,
} = await import('../fetch.js')

const { clearOpenAIClientCache } = await import(
  'src/services/api/openai/client.js'
)
const { clearGrokClientCache } = await import('src/services/api/grok/client.js')

/**
 * Every provider covered here authenticates from the environment, so the
 * fetchers can be driven end to end with an injected fetch and no
 * process-global mock of the auth chain. The Anthropic path reads
 * src/utils/auth/auth.ts (keychain-backed, side-effectful when called), so it
 * is covered through its pure seams instead — see CLAUDE.md on mock.module
 * pollution.
 */
const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_AUTH_MODE',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
  'GEMINI_API_KEY',
  'GEMINI_BASE_URL',
  'GROK_API_KEY',
  'XAI_API_KEY',
  'GROK_BASE_URL',
] as const

const savedEnv: Record<string, string | undefined> = {}

/**
 * getOpenAIClient/getGrokClient memoize the client the first time they are
 * called WITHOUT a fetch override, and the cache hit short-circuits before the
 * override is read. Any earlier test file in the process that built a client
 * would therefore make these tests reach the real network. Clear both caches
 * around every case; the next production call just rebuilds them.
 */
beforeEach(() => {
  clearOpenAIClientCache()
  clearGrokClientCache()
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  clearOpenAIClientCache()
  clearGrokClientCache()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('buildAnthropicAuthHeaders', () => {
  test('prefers the API key', () => {
    const headers = buildAnthropicAuthHeaders({
      apiKey: 'sk-ant-test',
      oauthToken: 'oauth-token',
      hasProfileScope: true,
    })
    expect(headers?.['x-api-key']).toBe('sk-ant-test')
    expect(headers?.authorization).toBeUndefined()
    expect(headers?.['anthropic-version']).toBe('2023-06-01')
  })

  test('falls back to an OAuth token that carries the profile scope', () => {
    const headers = buildAnthropicAuthHeaders({
      oauthToken: 'oauth-token',
      hasProfileScope: true,
    })
    expect(headers?.authorization).toBe('Bearer oauth-token')
    expect(headers?.['anthropic-beta']).toBe('oauth-2025-04-20')
  })

  test('rejects an OAuth token without the profile scope', () => {
    expect(
      buildAnthropicAuthHeaders({
        oauthToken: 'service-key-token',
        hasProfileScope: false,
      }),
    ).toBeNull()
  })

  test('returns null when nothing is configured', () => {
    expect(buildAnthropicAuthHeaders({})).toBeNull()
    expect(
      buildAnthropicAuthHeaders({ apiKey: null, oauthToken: null }),
    ).toBeNull()
  })
})

describe('parseAnthropicModelsResponse', () => {
  test('maps id, display_name and the ISO created_at', () => {
    expect(
      parseAnthropicModelsResponse({
        data: [
          {
            type: 'model',
            id: 'claude-opus-4-7-20260115',
            display_name: 'Claude Opus 4.7',
            created_at: '2026-01-15T00:00:00Z',
          },
        ],
      }),
    ).toEqual([
      {
        id: 'claude-opus-4-7-20260115',
        displayName: 'Claude Opus 4.7',
        created: Math.floor(Date.parse('2026-01-15T00:00:00Z') / 1000),
      },
    ])
  })

  test('skips entries without an id and tolerates missing fields', () => {
    expect(
      parseAnthropicModelsResponse({ data: [{ id: 'ok' }, {}, 'junk'] }),
    ).toEqual([{ id: 'ok' }])
  })

  test('returns null for a body that is not a model list', () => {
    expect(parseAnthropicModelsResponse(null)).toBeNull()
    expect(parseAnthropicModelsResponse({ error: 'nope' })).toBeNull()
  })
})

describe('parseGeminiModelsResponse', () => {
  test('strips the models/ prefix and keeps the display name', () => {
    expect(
      parseGeminiModelsResponse({
        models: [
          {
            name: 'models/gemini-3-pro',
            displayName: 'Gemini 3 Pro',
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      }),
    ).toEqual([{ id: 'gemini-3-pro', displayName: 'Gemini 3 Pro' }])
  })

  test('drops models that cannot generateContent', () => {
    expect(
      parseGeminiModelsResponse({
        models: [
          {
            name: 'models/embedding-001',
            supportedGenerationMethods: ['embedContent'],
          },
          { name: 'models/gemini-3-flash' },
        ],
      }),
    ).toEqual([{ id: 'gemini-3-flash' }])
  })

  test('returns null for a body that is not a model list', () => {
    expect(parseGeminiModelsResponse({})).toBeNull()
  })
})

describe('fetchProviderModels', () => {
  test('returns null for providers with no /models endpoint', async () => {
    expect(await fetchProviderModels('bedrock')).toBeNull()
    expect(await fetchProviderModels('vertex')).toBeNull()
    expect(await fetchProviderModels('foundry')).toBeNull()
    expect(await fetchProviderModels('nonsense')).toBeNull()
  })

  describe('gemini', () => {
    test('hits v1beta/models with the api key header', async () => {
      process.env.GEMINI_API_KEY = 'gemini-key'
      const seen: Array<{ url: string; key: unknown }> = []
      const models = await fetchProviderModels('gemini', {
        fetchImpl: (async (url: string, init: RequestInit) => {
          seen.push({
            url: String(url),
            key: (init.headers as Record<string, string>)['x-goog-api-key'],
          })
          return jsonResponse({ models: [{ name: 'models/gemini-3-pro' }] })
        }) as unknown as typeof fetch,
      })
      expect(models).toEqual([{ id: 'gemini-3-pro' }])
      expect(seen[0]?.key).toBe('gemini-key')
      expect(seen[0]?.url).toContain(
        'https://generativelanguage.googleapis.com/v1beta/models',
      )
    })

    test('skips silently without an api key', async () => {
      let called = false
      const models = await fetchProviderModels('gemini', {
        fetchImpl: (async () => {
          called = true
          return jsonResponse({})
        }) as unknown as typeof fetch,
      })
      expect(models).toBeNull()
      expect(called).toBe(false)
    })

    test('returns null on a non-2xx response', async () => {
      process.env.GEMINI_API_KEY = 'gemini-key'
      expect(
        await fetchProviderModels('gemini', {
          fetchImpl: (async () =>
            jsonResponse(
              { error: 'forbidden' },
              403,
            )) as unknown as typeof fetch,
        }),
      ).toBeNull()
    })

    test('swallows network errors', async () => {
      process.env.GEMINI_API_KEY = 'gemini-key'
      expect(
        await fetchProviderModels('gemini', {
          fetchImpl: (async () => {
            throw new Error('ECONNREFUSED')
          }) as unknown as typeof fetch,
        }),
      ).toBeNull()
    })
  })

  /**
   * Only the pre-flight skips are asserted here. OpenAI and Grok share one
   * implementation (fetchOpenAICompatibleModels) and the full request/parse
   * path is covered through Grok below — src/utils/__tests__/
   * sideQuery.chatgptAuth.test.ts installs a permanent process-global
   * mock.module for 'src/services/api/openai/client.js' whose fake client
   * exposes only `.chat`, so any assertion here about `models.list` would pass
   * or fail purely on test-file ordering.
   */
  describe('openai', () => {
    test('skips the Codex backend under ChatGPT subscription auth', async () => {
      process.env.OPENAI_API_KEY = 'sk-openai'
      process.env.OPENAI_AUTH_MODE = 'chatgpt'
      let called = false
      const models = await fetchProviderModels('openai', {
        fetchImpl: (async () => {
          called = true
          return jsonResponse({ data: [] })
        }) as unknown as typeof fetch,
      })
      expect(models).toBeNull()
      expect(called).toBe(false)
    })

    test('skips silently without an api key', async () => {
      let called = false
      const models = await fetchProviderModels('openai', {
        fetchImpl: (async () => {
          called = true
          return jsonResponse({ data: [] })
        }) as unknown as typeof fetch,
      })
      expect(models).toBeNull()
      expect(called).toBe(false)
    })
  })

  // Grok drives the same fetchOpenAICompatibleModels implementation the OpenAI
  // provider uses, against an un-mocked client factory.
  describe('grok', () => {
    test('uses the OpenAI-compatible xAI endpoint', async () => {
      process.env.XAI_API_KEY = 'xai-key'
      const urls: string[] = []
      const models = await fetchProviderModels('grok', {
        fetchImpl: (async (input: unknown) => {
          urls.push(String(input))
          return jsonResponse({
            object: 'list',
            data: [
              { id: 'grok-9', object: 'model', created: 222, owned_by: 'xai' },
            ],
          })
        }) as unknown as typeof fetch,
      })
      expect(models).toEqual([{ id: 'grok-9', created: 222 }])
      expect(urls[0]).toContain('api.x.ai')
    })

    test('skips silently without an api key', async () => {
      let called = false
      const models = await fetchProviderModels('grok', {
        fetchImpl: (async () => {
          called = true
          return jsonResponse({ data: [] })
        }) as unknown as typeof fetch,
      })
      expect(models).toBeNull()
      expect(called).toBe(false)
    })

    test('returns null when the endpoint rejects the request', async () => {
      process.env.XAI_API_KEY = 'xai-key'
      expect(
        await fetchProviderModels('grok', {
          fetchImpl: (async () =>
            jsonResponse({ error: 'nope' }, 401)) as unknown as typeof fetch,
        }),
      ).toBeNull()
    })

    test('swallows network errors', async () => {
      process.env.XAI_API_KEY = 'xai-key'
      expect(
        await fetchProviderModels('grok', {
          fetchImpl: (async () => {
            throw new Error('ECONNREFUSED')
          }) as unknown as typeof fetch,
        }),
      ).toBeNull()
    })
  })
})
