import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { GeminiStreamChunk } from '@ant/model-provider'
import {
  extractGeminiSearchResults,
  GeminiSearchAdapter,
  isGroundingRedirectUrl,
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
  return `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}`).join('\n\n')}\n\n`
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
        title: 'learn.microsoft.com',
        url: REDIRECT_B,
        snippet: 'RRF fuses rankings.',
      },
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
    headRequests = []
    process.env.GEMINI_API_KEY = 'test-gemini-key'
    // Pin the model so getMainLoopModel() never walks into the auth stack,
    // which throws outright when no Anthropic credential is configured.
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929'
  })

  afterEach(() => {
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

  test('surfaces an API failure so the source can be retired', async () => {
    const failing = (async () =>
      new Response('web_search is not supported for this project', {
        status: 403,
      })) as unknown as typeof fetch

    await expect(
      new GeminiSearchAdapter({ fetchOverride: failing }).search('rrf', {}),
    ).rejects.toThrow(/403/)
  })
})
