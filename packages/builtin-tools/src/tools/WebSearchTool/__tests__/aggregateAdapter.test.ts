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
  test('gives lane 0 rank 1 and drops URLs an earlier lane already had', () => {
    const merged = mergeSearchLanes([PRIMARY_HITS, ENHANCER_HITS], 8)

    expect(merged.map(r => r.url)).toEqual([
      'https://a.example/one',
      'https://shared.example/page',
      'https://b.example/two',
    ])
  })

  test('interleaves lanes instead of draining them in order', () => {
    const merged = mergeSearchLanes(
      [
        [
          { title: 'p1', url: 'https://p.example/1' },
          { title: 'p2', url: 'https://p.example/2' },
        ],
        [
          { title: 'q1', url: 'https://q.example/1' },
          { title: 'q2', url: 'https://q.example/2' },
        ],
      ],
      4,
    )

    expect(merged.map(r => r.url)).toEqual([
      'https://p.example/1',
      'https://q.example/1',
      'https://p.example/2',
      'https://q.example/2',
    ])
  })

  test('a verbose lane cannot starve a later one out of the budget', () => {
    // The shape that made WebSearch return irrelevant hits: a grounding lane
    // with plenty of low-value results ahead of the SERP lane holding the
    // actual answer. That answer must still make the cut.
    const grounding = Array.from({ length: 8 }, (_, i) => ({
      title: 'github.com',
      url: `https://github.com/owner/repo/issues/${i}`,
    }))
    const serp = [{ title: 'The answer', url: 'https://docs.example/answer' }]

    const merged = mergeSearchLanes([grounding, serp], 8)

    expect(merged.map(r => r.url)).toContain('https://docs.example/answer')
    expect(merged[1]?.url).toBe('https://docs.example/answer')
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

  test('drains the remaining lanes once the others are exhausted', () => {
    const merged = mergeSearchLanes(
      [
        [{ title: 'only', url: 'https://short.example/1' }],
        [
          { title: 'a', url: 'https://long.example/1' },
          { title: 'b', url: 'https://long.example/2' },
          { title: 'c', url: 'https://long.example/3' },
        ],
      ],
      8,
    )

    expect(merged.map(r => r.url)).toEqual([
      'https://short.example/1',
      'https://long.example/1',
      'https://long.example/2',
      'https://long.example/3',
    ])
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

  test('interleaves several enhancer lanes behind the primary', async () => {
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
      'https://g.example/1',
      'https://shared.example/page',
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

  test('aborts an enhancer that misses the grace window', async () => {
    let aborted = false
    const slowEnhancer: WebSearchAdapter = {
      async search(_query, options): Promise<SearchResult[]> {
        return new Promise(resolve => {
          options.signal?.addEventListener(
            'abort',
            () => {
              aborted = true
              resolve(ENHANCER_HITS)
            },
            { once: true },
          )
        })
      },
    }
    const adapter = new AggregateSearchAdapter({
      primary: lane(PRIMARY_HITS),
      enhancers: [slowEnhancer],
      graceMs: 5,
    })

    const results = await adapter.search('q', {})

    expect(aborted).toBe(true)
    expect(results).toHaveLength(PRIMARY_HITS.length)
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
