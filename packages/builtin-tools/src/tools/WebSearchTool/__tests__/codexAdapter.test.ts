import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  CodexSearchAdapter,
  extractCodexSearchResults,
} from '../adapters/codexAdapter'
import type { SearchProgress } from '../adapters/types'

// Canned Responses API events. Shapes taken from the three places the API
// reports citations: the streamed annotation, the web_search_call item, and
// the final response object.
const ANNOTATION_EVENT = {
  type: 'response.output_text.annotation.added',
  annotation: {
    type: 'url_citation',
    url: 'https://example.com/cited',
    title: 'Cited page',
  },
}

const SEARCH_CALL_EVENT = {
  type: 'response.output_item.done',
  item: {
    type: 'web_search_call',
    id: 'ws_1',
    action: {
      type: 'search',
      query: 'reciprocal rank fusion',
      sources: [
        { url: 'https://example.org/sourced', title: 'Sourced page' },
        { url: 'https://example.com/cited' },
      ],
    },
  },
}

const COMPLETED_EVENT = {
  type: 'response.completed',
  response: {
    output: [
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'Some prose',
            annotations: [
              {
                type: 'url_citation',
                url: 'https://example.net/final',
                title: 'Final citation',
              },
              { type: 'file_citation', file_id: 'file_1' },
            ],
          },
        ],
      },
    ],
  },
}

function sseBody(events: unknown[]): string {
  return `${events.map(event => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\n`
}

describe('extractCodexSearchResults', () => {
  test('collects citations from annotations, search calls and the final response', () => {
    const results = extractCodexSearchResults([
      ANNOTATION_EVENT,
      SEARCH_CALL_EVENT,
      COMPLETED_EVENT,
    ])

    expect(results).toEqual([
      { title: 'Cited page', url: 'https://example.com/cited' },
      { title: 'Sourced page', url: 'https://example.org/sourced' },
      { title: 'Final citation', url: 'https://example.net/final' },
    ])
  })

  test('keeps the title when a later sighting of the same URL has none', () => {
    const results = extractCodexSearchResults([
      ANNOTATION_EVENT,
      SEARCH_CALL_EVENT,
    ])

    expect(results[0]).toEqual({
      title: 'Cited page',
      url: 'https://example.com/cited',
    })
  })

  test('ignores non-url citations and unrelated events', () => {
    const results = extractCodexSearchResults([
      { type: 'response.created', response: {} },
      {
        type: 'response.output_text.annotation.added',
        annotation: { type: 'file_citation', file_id: 'f1' },
      },
    ])

    expect(results).toEqual([])
  })
})

describe('CodexSearchAdapter.search', () => {
  const originalApiKey = process.env.OPENAI_API_KEY
  const originalAuthMode = process.env.OPENAI_AUTH_MODE
  const originalBaseUrl = process.env.OPENAI_BASE_URL
  const originalModel = process.env.ANTHROPIC_MODEL

  let requests: Array<{ url: string; body: Record<string, unknown> }> = []

  function fetchStub(events: unknown[]): typeof fetch {
    return (async (url: string | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      })
      return new Response(sseBody(events), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch
  }

  beforeEach(() => {
    requests = []
    process.env.OPENAI_API_KEY = 'test-openai-key'
    // The API-key route, not the ChatGPT/Codex backend: no stored credentials
    // are touched by this suite.
    delete process.env.OPENAI_AUTH_MODE
    process.env.OPENAI_BASE_URL = 'https://api.openai.test/v1'
    // Pin the model so getMainLoopModel() never walks into the auth stack,
    // which throws outright when no Anthropic credential is configured.
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929'
  })

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalApiKey
    if (originalAuthMode === undefined) delete process.env.OPENAI_AUTH_MODE
    else process.env.OPENAI_AUTH_MODE = originalAuthMode
    if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = originalBaseUrl
    if (originalModel === undefined) delete process.env.ANTHROPIC_MODEL
    else process.env.ANTHROPIC_MODEL = originalModel
  })

  test('asks the Responses API for the built-in web_search tool', async () => {
    const adapter = new CodexSearchAdapter({
      fetchOverride: fetchStub([SEARCH_CALL_EVENT, COMPLETED_EVENT]),
    })

    await adapter.search('rrf', {})

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://api.openai.test/v1/responses')
    expect(requests[0].body.tools).toEqual([{ type: 'web_search' }])
    // API-key route keeps the output cap; the ChatGPT backend rejects it and
    // the adapter omits it there (buildResponsesRequest owns that shape).
    expect(requests[0].body.max_output_tokens).toBeDefined()
  })

  test('returns the citations the model grounded on', async () => {
    const adapter = new CodexSearchAdapter({
      fetchOverride: fetchStub([SEARCH_CALL_EVENT, COMPLETED_EVENT]),
    })

    const results = await adapter.search('rrf', {})

    expect(results.map(r => r.url)).toEqual([
      'https://example.org/sourced',
      'https://example.com/cited',
      'https://example.net/final',
    ])
  })

  test('reports the query the model actually searched for', async () => {
    const progress: SearchProgress[] = []
    const adapter = new CodexSearchAdapter({
      fetchOverride: fetchStub([SEARCH_CALL_EVENT, COMPLETED_EVENT]),
    })

    await adapter.search('rrf', { onProgress: p => progress.push(p) })

    expect(progress[0]).toEqual({ type: 'query_update', query: 'rrf' })
    expect(progress[1]).toEqual({
      type: 'query_update',
      query: 'reciprocal rank fusion',
    })
    expect(progress.at(-1)).toEqual({
      type: 'search_results_received',
      resultCount: 3,
      query: 'rrf',
    })
  })

  test('filters by domain client-side', async () => {
    const adapter = new CodexSearchAdapter({
      fetchOverride: fetchStub([SEARCH_CALL_EVENT, COMPLETED_EVENT]),
    })

    const results = await adapter.search('rrf', {
      blockedDomains: ['example.com'],
    })

    expect(results.map(r => r.url)).toEqual([
      'https://example.org/sourced',
      'https://example.net/final',
    ])
  })

  test('forceChatGPTAuth falls back to the API key when no ChatGPT login exists', async () => {
    // The extra-source lane sets forceChatGPTAuth, but hasCodexSearchCredentials
    // counts an OPENAI_API_KEY alone as connected. Forcing OAuth unconditionally
    // would make that lane throw on every search instead of using the key it has.
    const adapter = new CodexSearchAdapter({
      forceChatGPTAuth: true,
      fetchOverride: fetchStub([SEARCH_CALL_EVENT, COMPLETED_EVENT]),
    })

    await adapter.search('rrf', {})

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://api.openai.test/v1/responses')
  })

  test('surfaces an API failure so the source can be retired', async () => {
    const failing = (async () =>
      new Response('{"error":{"message":"Unsupported tool: web_search"}}', {
        status: 400,
      })) as unknown as typeof fetch
    const adapter = new CodexSearchAdapter({ fetchOverride: failing })

    await expect(adapter.search('rrf', {})).rejects.toThrow(/web_search/)
  })
})
