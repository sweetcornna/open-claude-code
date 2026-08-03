import { describe, expect, test } from 'bun:test'
import { AbortError } from '@open-claude-code/tool-runtime/errors.js'
import {
  AggregateSearchAdapter,
  mergeSearchLanes,
} from '../adapters/aggregateAdapter'
import type {
  SearchOptions,
  SearchProgress,
  SearchResult,
  WebSearchAdapter,
} from '../adapters/types'

function lane(
  results: SearchResult[],
  options: { delayMs?: number; error?: Error } = {},
): WebSearchAdapter {
  return {
    async search(): Promise<SearchResult[]> {
      if (options.delayMs) {
        await new Promise(resolve => setTimeout(resolve, options.delayMs))
      }
      if (options.error) throw options.error
      return results
    },
  }
}

const PRIMARY_HITS: SearchResult[] = [
  { title: 'Official one', url: 'https://a.example/one', snippet: 'from api' },
  { title: 'Shared', url: 'https://shared.example/page' },
]

const ENHANCER_HITS: SearchResult[] = [
  // Same page as the primary lane's second hit, wearing campaign params.
  { title: 'Shared', url: 'https://shared.example/page/?utm_source=ddg#top' },
  { title: 'Only free found this', url: 'https://b.example/two' },
]

describe('mergeSearchLanes', () => {
  test('keeps lane order and drops URLs a earlier lane already had', () => {
    const merged = mergeSearchLanes([PRIMARY_HITS, ENHANCER_HITS], 8)

    expect(merged.map(r => r.url)).toEqual([
      'https://a.example/one',
      'https://shared.example/page',
      'https://b.example/two',
    ])
  })

  test('normalizes the URL it hands back', () => {
    const merged = mergeSearchLanes(
      [[{ title: 'x', url: 'https://x.example/p/?utm_campaign=q&id=7#frag' }]],
      8,
    )

    expect(merged[0].url).toBe('https://x.example/p?id=7')
  })

  test('honours the result limit', () => {
    expect(mergeSearchLanes([PRIMARY_HITS, ENHANCER_HITS], 2)).toHaveLength(2)
  })
})

describe('AggregateSearchAdapter', () => {
  test('merges the primary lane with the enhancers', async () => {
    const adapter = new AggregateSearchAdapter({
      primary: lane(PRIMARY_HITS),
      enhancers: [lane(ENHANCER_HITS)],
    })

    const results = await adapter.search('q', {})

    expect(results.map(r => r.url)).toEqual([
      'https://a.example/one',
      'https://shared.example/page',
      'https://b.example/two',
    ])
  })

  test('merges several enhancer lanes in order', async () => {
    const adapter = new AggregateSearchAdapter({
      primary: lane(PRIMARY_HITS),
      enhancers: [
        lane([{ title: 'gemini', url: 'https://g.example/1' }]),
        lane(ENHANCER_HITS),
      ],
    })

    const results = await adapter.search('q', {})

    expect(results.map(r => r.url)).toEqual([
      'https://a.example/one',
      'https://shared.example/page',
      'https://g.example/1',
      'https://b.example/two',
    ])
  })

  test('drops an enhancer that misses the grace window', async () => {
    const adapter = new AggregateSearchAdapter({
      primary: lane(PRIMARY_HITS),
      enhancers: [lane(ENHANCER_HITS, { delayMs: 200 })],
      graceMs: 10,
    })

    const results = await adapter.search('q', {})

    expect(results.map(r => r.url)).toEqual([
      'https://a.example/one',
      'https://shared.example/page',
    ])
  })

  test('waits out a slow enhancer when the primary lane came back empty', async () => {
    const adapter = new AggregateSearchAdapter({
      primary: lane([]),
      enhancers: [lane(ENHANCER_HITS, { delayMs: 30 })],
      graceMs: 5,
    })

    const results = await adapter.search('q', {})

    expect(results.map(r => r.url)).toEqual([
      'https://shared.example/page',
      'https://b.example/two',
    ])
  })

  test('a failing primary lane is silent and the enhancers stand alone', async () => {
    const adapter = new AggregateSearchAdapter({
      primary: lane([], { error: new Error('no web_search for this account') }),
      enhancers: [lane(ENHANCER_HITS)],
    })

    const results = await adapter.search('q', {})

    expect(results).toHaveLength(2)
  })

  test('a failing enhancer is silent and the primary lane stands alone', async () => {
    const adapter = new AggregateSearchAdapter({
      primary: lane(PRIMARY_HITS),
      enhancers: [lane([], { error: new Error('scrape blocked') })],
    })

    expect(await adapter.search('q', {})).toHaveLength(2)
  })

  test('runs enhancers alone when there is no primary lane', async () => {
    const adapter = new AggregateSearchAdapter({
      enhancers: [lane(ENHANCER_HITS)],
    })

    expect(await adapter.search('q', {})).toHaveLength(2)
  })

  test('surfaces the error only when every lane failed', async () => {
    const adapter = new AggregateSearchAdapter({
      primary: lane([], { error: new Error('primary down') }),
      enhancers: [lane([], { error: new Error('enhancer down') })],
    })

    await expect(adapter.search('q', {})).rejects.toThrow('primary down')
  })

  test('returns empty (no throw) when lanes simply found nothing', async () => {
    const adapter = new AggregateSearchAdapter({
      primary: lane([]),
      enhancers: [lane([])],
    })

    expect(await adapter.search('q', {})).toEqual([])
  })

  test('propagates an abort instead of swallowing it', async () => {
    const adapter = new AggregateSearchAdapter({
      primary: lane([], { error: new AbortError() }),
      enhancers: [lane(ENHANCER_HITS)],
    })

    await expect(adapter.search('q', {})).rejects.toThrow(AbortError)
  })

  test('reports one result count, and only the primary lane s query updates', async () => {
    const progress: SearchProgress[] = []
    const chattyPrimary: WebSearchAdapter = {
      async search(
        _query: string,
        options: SearchOptions,
      ): Promise<SearchResult[]> {
        options.onProgress?.({ type: 'query_update', query: 'refined query' })
        options.onProgress?.({
          type: 'search_results_received',
          resultCount: 2,
          query: 'refined query',
        })
        return PRIMARY_HITS
      },
    }
    const chattyEnhancer: WebSearchAdapter = {
      async search(
        _query: string,
        options: SearchOptions,
      ): Promise<SearchResult[]> {
        options.onProgress?.({ type: 'query_update', query: 'enhancer query' })
        return ENHANCER_HITS
      },
    }

    const adapter = new AggregateSearchAdapter({
      primary: chattyPrimary,
      enhancers: [chattyEnhancer],
    })
    await adapter.search('q', { onProgress: p => progress.push(p) })

    expect(progress).toEqual([
      { type: 'query_update', query: 'refined query' },
      { type: 'search_results_received', resultCount: 3, query: 'q' },
    ])
  })
})
