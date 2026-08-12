import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { GeminiStreamChunk } from '@ant/model-provider'
import { registerAPIRetryHost } from '@open-claude-code/tool-runtime/apiRetry.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { occConfigDir } from 'src/config/paths.js'
import { retryOpenAIRequest } from 'src/services/api/openai/retry.js'
import {
  pinSearchCredential,
  reloadPinnedSearchCredentials,
} from 'src/services/search/searchCredentialStore.js'
import { findAntigravityModelOption } from 'src/utils/model/antigravityModels.js'
import {
  extractGeminiSearchResults,
  GeminiSearchAdapter,
  isGroundingRedirectUrl,
  resolveGeminiSearchModel,
} from '../adapters/geminiAdapter'
import type { SearchProgress } from '../adapters/types'

const REDIRECT_HOST = 'https://vertexaisearch.cloud.google.com'
const REDIRECT_A = `${REDIRECT_HOST}/grounding-api-redirect/AAAA`
const REDIRECT_B = `${REDIRECT_HOST}/grounding-api-redirect/BBBB`

const GROUNDED_CHUNK: GeminiStreamChunk = {
  candidates: [
    {
      content: { role: 'model', parts: [{ text: 'RRF fuses rankings.' }] },
      groundingMetadata: {
        webSearchQueries: ['reciprocal rank fusion'],
        groundingChunks: [
          {
            web: { uri: REDIRECT_A, title: 'elastic.co', domain: 'elastic.co' },
          },
          { web: { uri: REDIRECT_B, title: 'learn.microsoft.com' } },
        ],
        groundingSupports: [
          {
            segment: { text: 'RRF fuses rankings.' },
            groundingChunkIndices: [0, 1],
          },
          {
            segment: { text: 'A later, less relevant sentence.' },
            groundingChunkIndices: [0],
          },
        ],
      },
    },
  ],
}

function sseBody(chunks: unknown[]): string {
  return `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}`).join('\n\n')}\n\ndata: [DONE]\n\n`
}

describe('extractGeminiSearchResults', () => {
  test('reads sources out of groundingChunks with their supporting text', () => {
    const results = extractGeminiSearchResults([GROUNDED_CHUNK])

    expect(results).toEqual([
      {
        title: 'elastic.co',
        url: REDIRECT_A,
        snippet: 'RRF fuses rankings.',
      },
      {
        // The one sentence citing this source was already spoken for by
        // REDIRECT_A, and it does not describe this page — no snippet beats a
        // borrowed one.
        title: 'learn.microsoft.com',
        url: REDIRECT_B,
        snippet: undefined,
      },
    ])
  })

  test('never repeats one answer segment across several sources', () => {
    const results = extractGeminiSearchResults([GROUNDED_CHUNK])
    const snippets = results
      .map(result => result.snippet)
      .filter((snippet): snippet is string => Boolean(snippet))

    expect(new Set(snippets).size).toBe(snippets.length)
  })

  test('gives each source its own segment when the answer supplies enough', () => {
    const results = extractGeminiSearchResults([
      {
        candidates: [
          {
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: REDIRECT_A, title: 'a' } },
                { web: { uri: REDIRECT_B, title: 'b' } },
              ],
              groundingSupports: [
                {
                  segment: { text: 'First claim.' },
                  groundingChunkIndices: [0, 1],
                },
                {
                  segment: { text: 'Second claim.' },
                  groundingChunkIndices: [1],
                },
              ],
            },
          },
        ],
      },
    ])

    expect(results.map(result => result.snippet)).toEqual([
      'First claim.',
      'Second claim.',
    ])
  })

  test('collapses the same source seen across streamed chunks', () => {
    const results = extractGeminiSearchResults([GROUNDED_CHUNK, GROUNDED_CHUNK])

    expect(results).toHaveLength(2)
  })

  test('ignores candidates with no grounding metadata', () => {
    expect(
      extractGeminiSearchResults([
        { candidates: [{ content: { parts: [{ text: 'hi' }] } }] },
      ]),
    ).toEqual([])
  })
})

describe('isGroundingRedirectUrl', () => {
  test('recognises the wrapper and leaves publisher URLs alone', () => {
    expect(isGroundingRedirectUrl(REDIRECT_A)).toBe(true)
    expect(isGroundingRedirectUrl('https://elastic.co/guide')).toBe(false)
    expect(isGroundingRedirectUrl('not a url')).toBe(false)
  })
})

describe('resolveGeminiSearchModel', () => {
  const savedModel = process.env.GEMINI_MODEL
  const savedAnthropicModel = process.env.ANTHROPIC_MODEL

  beforeEach(() => {
    delete process.env.GEMINI_MODEL
    // Pin the model so getMainLoopModel() never walks into the auth stack.
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929'
  })

  afterEach(() => {
    if (savedModel === undefined) delete process.env.GEMINI_MODEL
    else process.env.GEMINI_MODEL = savedModel
    if (savedAnthropicModel === undefined) delete process.env.ANTHROPIC_MODEL
    else process.env.ANTHROPIC_MODEL = savedAnthropicModel
  })

  test('the Antigravity default is a model that backend actually serves', () => {
    // Regression: the public-endpoint default (gemini-2.5-flash) went to the
    // Antigravity backend and came back 404 "Requested entity was not found"
    // on every search, silenced by the aggregator.
    const model = resolveGeminiSearchModel(true)
    expect(findAntigravityModelOption(model)).toBeDefined()
  })

  test('the public endpoint keeps its own default', () => {
    expect(resolveGeminiSearchModel(false)).toBe('gemini-2.5-flash')
  })

  test('a public-endpoint GEMINI_MODEL is not forwarded to Antigravity', () => {
    // Left over from an earlier API-key setup — valid there, a 404 here.
    process.env.GEMINI_MODEL = 'gemini-2.5-flash'
    expect(
      findAntigravityModelOption(resolveGeminiSearchModel(true)),
    ).toBeDefined()
    expect(resolveGeminiSearchModel(false)).toBe('gemini-2.5-flash')
  })

  test('an Antigravity GEMINI_MODEL is forwarded as-is', () => {
    process.env.GEMINI_MODEL = 'gemini-3.1-pro-low'
    expect(resolveGeminiSearchModel(true)).toBe('gemini-3.1-pro-low')
  })
})

describe('GeminiSearchAdapter.search', () => {
  const originalApiKey = process.env.GEMINI_API_KEY
  const originalModel = process.env.ANTHROPIC_MODEL

  let headRequests: string[] = []

  /** POST → the SSE stream; HEAD → the redirect target. */
  function fetchStub(chunks: unknown[]): typeof fetch {
    return (async (url: string | URL, init?: RequestInit) => {
      const href = String(url)
      if (init?.method === 'HEAD') {
        headRequests.push(href)
        const target =
          href === REDIRECT_A
            ? 'https://www.elastic.co/guide/rrf.html'
            : 'https://learn.microsoft.com/azure/search/hybrid-rrf'
        // A followed redirect chain leaves `response.url` on the final target.
        return Response.redirect(target, 302)
      }
      return new Response(sseBody(chunks), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch
  }

  beforeEach(() => {
    registerAPIRetryHost({
      retry: (operation, options) =>
        retryOpenAIRequest(operation, {
          ...options,
          delay: async () => {},
        }),
    })
    headRequests = []
    process.env.GEMINI_API_KEY = 'test-gemini-key'
    // Pin the model so getMainLoopModel() never walks into the auth stack,
    // which throws outright when no Anthropic credential is configured.
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929'
  })

  afterEach(() => {
    registerAPIRetryHost(null)
    if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalApiKey
    if (originalModel === undefined) delete process.env.ANTHROPIC_MODEL
    else process.env.ANTHROPIC_MODEL = originalModel
  })

  test('resolves grounding redirects to the publisher URL', async () => {
    const adapter = new GeminiSearchAdapter({
      fetchOverride: fetchStub([GROUNDED_CHUNK]),
    })

    const results = await adapter.search('rrf', {})

    expect(headRequests).toEqual([REDIRECT_A, REDIRECT_B])
    expect(results.map(r => r.url)).toEqual([
      'https://www.elastic.co/guide/rrf.html',
      'https://learn.microsoft.com/azure/search/hybrid-rrf',
    ])
  })

  test('keeps the wrapper when the redirect cannot be resolved', async () => {
    const failingHead = (async (url: string | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') throw new Error('HEAD blocked')
      return new Response(sseBody([GROUNDED_CHUNK]), { status: 200 })
    }) as unknown as typeof fetch

    const results = await new GeminiSearchAdapter({
      fetchOverride: failingHead,
    }).search('rrf', {})

    expect(results.map(r => r.url)).toEqual([REDIRECT_A, REDIRECT_B])
  })

  test('filters on the RESOLVED host, not the redirect wrapper', async () => {
    const adapter = new GeminiSearchAdapter({
      fetchOverride: fetchStub([GROUNDED_CHUNK]),
    })

    const results = await adapter.search('rrf', {
      allowedDomains: ['elastic.co'],
    })

    expect(results.map(r => r.url)).toEqual([
      'https://www.elastic.co/guide/rrf.html',
    ])
  })

  test('reports the queries Gemini actually ran', async () => {
    const progress: SearchProgress[] = []
    const adapter = new GeminiSearchAdapter({
      fetchOverride: fetchStub([GROUNDED_CHUNK]),
    })

    await adapter.search('rrf', { onProgress: p => progress.push(p) })

    expect(progress[0]).toEqual({ type: 'query_update', query: 'rrf' })
    expect(progress[1]).toEqual({
      type: 'query_update',
      query: 'reciprocal rank fusion',
    })
    expect(progress.at(-1)).toEqual({
      type: 'search_results_received',
      resultCount: 2,
      query: 'rrf',
    })
  })

  test('retries a transient API failure before consuming the stream', async () => {
    let postAttempts = 0
    const success = fetchStub([GROUNDED_CHUNK])
    const flaky = (async (url: string | URL, init?: RequestInit) => {
      if (init?.method !== 'HEAD' && ++postAttempts === 1) {
        return new Response('upstream unavailable', { status: 503 })
      }
      return success(url, init)
    }) as unknown as typeof fetch

    const results = await new GeminiSearchAdapter({
      fetchOverride: flaky,
    }).search('rrf', {})

    expect(postAttempts).toBe(2)
    expect(results).toHaveLength(2)
  })

  test('retries a permanent API failure ten times', async () => {
    let attempts = 0
    const failing = (async () => {
      attempts++
      return new Response('web_search is not supported for this project', {
        status: 403,
      })
    }) as unknown as typeof fetch

    await expect(
      new GeminiSearchAdapter({ fetchOverride: failing }).search('rrf', {}),
    ).rejects.toThrow(/403/)
    expect(attempts).toBe(11)
  })
})

/**
 * A credential pinned by /search-setting has to be the one that is sent, not
 * just the one that lights the row. That means two things at once: the key
 * travels in `x-goog-api-key`, and the Antigravity route stands down — pinning
 * would be pointless if a Google login on the same machine kept winning, and it
 * is the pin that survives the `/logout` which revokes that login.
 */
describe('GeminiSearchAdapter.search with a pinned credential', () => {
  const savedConfigDir = process.env.OCC_CONFIG_DIR
  const originalApiKey = process.env.GEMINI_API_KEY
  const originalModel = process.env.ANTHROPIC_MODEL
  let tempDir: string
  let requests: Array<{ url: string; headers: Record<string, string> }> = []

  /** A publisher URL rather than a wrapper, so no HEAD follows the POST. */
  const DIRECT_CHUNK: GeminiStreamChunk = {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: 'RRF fuses rankings.' }] },
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: 'https://example.com/rrf', title: 'example.com' } },
          ],
        },
      },
    ],
  }

  function capturingFetch(): typeof fetch {
    return (async (url: string | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
      })
      return new Response(sseBody([DIRECT_CHUNK]), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch
  }

  beforeEach(() => {
    registerAPIRetryHost({
      retry: (operation, options) =>
        retryOpenAIRequest(operation, { ...options, delay: async () => {} }),
    })
    requests = []
    tempDir = mkdtempSync(join(tmpdir(), 'occ-gemini-pin-'))
    process.env.OCC_CONFIG_DIR = tempDir
    occConfigDir.cache.clear?.()
    reloadPinnedSearchCredentials()
    delete process.env.GEMINI_API_KEY
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929'
  })

  afterEach(() => {
    registerAPIRetryHost(null)
    if (savedConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
    else process.env.OCC_CONFIG_DIR = savedConfigDir
    occConfigDir.cache.clear?.()
    reloadPinnedSearchCredentials()
    rmSync(tempDir, { recursive: true, force: true })
    if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalApiKey
    if (originalModel === undefined) delete process.env.ANTHROPIC_MODEL
    else process.env.ANTHROPIC_MODEL = originalModel
  })

  test('sends the pinned key with GEMINI_API_KEY unset', async () => {
    await pinSearchCredential('gemini', { apiKey: 'AIza-pinned' })

    await new GeminiSearchAdapter({
      asExtraSource: true,
      fetchOverride: capturingFetch(),
    }).search('rrf', {})

    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers['x-goog-api-key']).toBe('AIza-pinned')
    expect(requests[0]?.url).toContain('generativelanguage.googleapis.com')
  })

  test('honours an endpoint carried by the pin', async () => {
    await pinSearchCredential('gemini', {
      apiKey: 'AIza-pinned',
      baseURL: 'https://gemini.example/v1beta',
    })

    await new GeminiSearchAdapter({
      fetchOverride: capturingFetch(),
    }).search('rrf', {})

    expect(requests[0]?.url).toStartWith('https://gemini.example/v1beta/')
  })
})
