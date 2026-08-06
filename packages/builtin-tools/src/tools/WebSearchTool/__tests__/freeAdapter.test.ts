import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { AbortError } from '@open-claude-code/tool-runtime/errors.js'
import { setupAxiosMock } from '../../../../../../tests/mocks/axios'

// Shared, complete-surface axios mock (tests/mocks/axios.ts). `useStubs` stays
// on for the whole file and `stubs.get` is set by every test, so no request in
// this suite can ever reach the network.
const axiosMock = setupAxiosMock()
axiosMock.useStubs = true
afterAll(() => {
  axiosMock.useStubs = false
})

// Imported AFTER the axios mock is registered so the adapter binds to it.
const {
  FreeSearchAdapter,
  SEARX_INSTANCES,
  appendBelow,
  mergeByReciprocalRank,
  parseBingHtml,
  parseDuckDuckGoHtml,
  parseMojeekHtml,
  parseSearxHtml,
  resolveSearxInstances,
  unwrapDuckDuckGoUrl,
} = await import('../adapters/freeAdapter')

// ── Fixtures ───────────────────────────────────────────────────────────────

const SHARED_URL = 'https://shared.example.com/page'

const DDG_HTML = `
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fddg&amp;rut=abc">DuckDuckGo Result &amp; Friends</a>
    </h2>
    <a class="result__snippet" href="https://example.com/ddg">DDG <b>snippet</b> text</a>
  </div>
</div>
<div class="result results_links result--ad">
  <h2 class="result__title"><a class="result__a" href="https://ads.example.com/x">Sponsored row</a></h2>
  <a class="result__snippet">Buy things</a>
</div>
<div class="result results_links web-result">
  <div class="links_main result__body">
    <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fshared.example.com%2Fpage">Shared result</a></h2>
    <a class="result__snippet">Short</a>
  </div>
</div>
`

const MOJEEK_HTML = `
<ul class="results-standard">
  <li>
    <h2><a class="title" href="https://shared.example.com/page">Shared result</a></h2>
    <p class="s">Mojeek snippet for the shared page, the longest one around</p>
  </li>
  <li>
    <h2><a class="title" href="https://mojeek.example.org/only">Mojeek only</a></h2>
    <p class="s">Only Mojeek indexed this</p>
  </li>
</ul>
`

function bingRedirect(target: string): string {
  const encoded = Buffer.from(target, 'utf-8')
    .toString('base64')
    .replace(/=+$/, '')
  return `https://www.bing.com/ck/a?!&&p=1&u=a1${encoded}&ntb=1`
}

const BING_HTML = `
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="${bingRedirect(SHARED_URL)}">Shared result</a></h2>
    <div class="b_caption"><p class="b_lineclamp2">Bing snippet</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="${bingRedirect('https://bing.example.net/only')}">Bing only</a></h2>
    <div class="b_caption"><p>Caption fallback snippet</p></div>
  </li>
</ol>
`

const SEARX_HTML = `
<article class="result result-default">
  <a href="https://searx.example.net/page" class="url_header">searx.example.net</a>
  <h3><a href="https://searx.example.net/page">Searx rescued result</a></h3>
  <p class="content">Rescued snippet</p>
</article>
<article class="result result-ad">
  <h3><a href="https://ads.example/x">Ad row</a></h3>
</article>
`

// ── Routing helper ─────────────────────────────────────────────────────────

let requestedUrls: string[] = []

/**
 * Route every GET by host. Hosts absent from the map answer with an empty
 * body, so an unrouted engine degrades to "no results" instead of hitting the
 * real network.
 */
function routeByHost(routes: Record<string, string | Error>): void {
  axiosMock.stubs.get = (url: string) => {
    requestedUrls.push(url)
    for (const [fragment, response] of Object.entries(routes)) {
      if (url.includes(fragment)) {
        return response instanceof Error
          ? Promise.reject(response)
          : Promise.resolve({ data: response })
      }
    }
    return Promise.resolve({ data: '' })
  }
}

const ALL_ENGINES_OK = {
  'html.duckduckgo.com': DDG_HTML,
  'www.mojeek.com': MOJEEK_HTML,
  'www4.bing.com': BING_HTML,
}

beforeEach(() => {
  requestedUrls = []
  axiosMock.stubs = {}
  axiosMock.useStubs = true
})

// ── Parsers ────────────────────────────────────────────────────────────────

describe('parseDuckDuckGoHtml', () => {
  test('unwraps the /l/?uddg= redirect and decodes entities', () => {
    const results = parseDuckDuckGoHtml(DDG_HTML)

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: 'DuckDuckGo Result & Friends',
      url: 'https://example.com/ddg',
      snippet: 'DDG snippet text',
    })
  })

  test('skips ad rows', () => {
    const urls = parseDuckDuckGoHtml(DDG_HTML).map(r => r.url)
    expect(urls).not.toContain('https://ads.example.com/x')
  })

  test('returns nothing for a gate/interstitial shell', () => {
    expect(parseDuckDuckGoHtml('<html><body>captcha</body></html>')).toEqual([])
  })
})

describe('unwrapDuckDuckGoUrl', () => {
  test('decodes the target exactly once, preserving literal %xx', () => {
    const wrapped =
      '//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FC%252B%252B'
    expect(unwrapDuckDuckGoUrl(wrapped)).toBe(
      'https://en.wikipedia.org/wiki/C%2B%2B',
    )
  })

  test('passes non-redirect URLs through', () => {
    expect(unwrapDuckDuckGoUrl('https://example.com/x')).toBe(
      'https://example.com/x',
    )
  })
})

describe('parseMojeekHtml', () => {
  test('extracts title, url and p.s snippet from the organic list', () => {
    const results = parseMojeekHtml(MOJEEK_HTML)

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: 'Shared result',
      url: SHARED_URL,
      snippet: 'Mojeek snippet for the shared page, the longest one around',
    })
    expect(results[1].url).toBe('https://mojeek.example.org/only')
  })
})

describe('parseBingHtml', () => {
  test('resolves b_algo rows through the ck/a redirect', () => {
    const results = parseBingHtml(BING_HTML)

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: 'Shared result',
      url: SHARED_URL,
      snippet: 'Bing snippet',
    })
    expect(results[1].url).toBe('https://bing.example.net/only')
    expect(results[1].snippet).toBe('Caption fallback snippet')
  })
})

describe('parseSearxHtml', () => {
  test('reads h3 anchors and skips result-ad articles', () => {
    const results = parseSearxHtml(SEARX_HTML)

    expect(results).toEqual([
      {
        title: 'Searx rescued result',
        url: 'https://searx.example.net/page',
        snippet: 'Rescued snippet',
      },
    ])
  })
})

// ── Merge ──────────────────────────────────────────────────────────────────

describe('mergeByReciprocalRank', () => {
  test('ranks a URL several engines agree on above single-engine hits', () => {
    const merged = mergeByReciprocalRank(
      [
        parseDuckDuckGoHtml(DDG_HTML),
        parseMojeekHtml(MOJEEK_HTML),
        parseBingHtml(BING_HTML),
      ],
      8,
    )

    expect(merged[0].url).toBe(SHARED_URL)
    // Longest snippet across the engines that saw the URL wins.
    expect(merged[0].snippet).toBe(
      'Mojeek snippet for the shared page, the longest one around',
    )
    expect(merged.map(r => r.url)).toContain('https://mojeek.example.org/only')
  })

  test('drops syndicated copies on the same canonical host', () => {
    const merged = mergeByReciprocalRank(
      [
        [{ title: 'Same Story', url: 'https://www.bbc.co.uk/news/x' }],
        [{ title: 'Same Story', url: 'https://amp.bbc.com/news/x' }],
      ],
      8,
    )

    expect(merged).toHaveLength(1)
  })

  test('keeps the same title on genuinely different hosts', () => {
    const merged = mergeByReciprocalRank(
      [
        [{ title: 'Wire Story', url: 'https://reuters.com/a' }],
        [{ title: 'Wire Story', url: 'https://apnews.com/b' }],
      ],
      8,
    )

    expect(merged).toHaveLength(2)
  })

  test('keeps same-host titles whose digits differ', () => {
    const merged = mergeByReciprocalRank(
      [
        [
          { title: 'Python 3.13 released', url: 'https://python.org/a' },
          { title: 'Python 3.12 released', url: 'https://python.org/b' },
        ],
      ],
      8,
    )

    expect(merged).toHaveLength(2)
  })

  test('collapses exact-duplicate URLs and honours the limit', () => {
    const merged = mergeByReciprocalRank(
      [
        [
          { title: 'A', url: 'https://a.example/x/' },
          { title: 'B', url: 'https://b.example/x' },
          { title: 'C', url: 'https://c.example/x' },
        ],
        [{ title: 'A', url: 'https://a.example/x#frag' }],
      ],
      2,
    )

    expect(merged).toHaveLength(2)
    expect(merged[0].url).toBe('https://a.example/x')
  })
})

// ── Adapter ────────────────────────────────────────────────────────────────

describe('FreeSearchAdapter.search', () => {
  test('fans out across the keyless engines and merges the buckets', async () => {
    routeByHost(ALL_ENGINES_OK)

    const results = await new FreeSearchAdapter().search('rrf', {})

    expect(requestedUrls.some(u => u.includes('html.duckduckgo.com'))).toBe(
      true,
    )
    expect(requestedUrls.some(u => u.includes('www.mojeek.com'))).toBe(true)
    expect(requestedUrls.some(u => u.includes('www4.bing.com'))).toBe(true)
    expect(results[0].url).toBe(SHARED_URL)
    expect(results.map(r => r.url)).toEqual([
      SHARED_URL,
      'https://example.com/ddg',
      'https://mojeek.example.org/only',
      'https://bing.example.net/only',
    ])
  })

  test('reports progress before and after the fan-out', async () => {
    routeByHost(ALL_ENGINES_OK)

    const progress: unknown[] = []
    await new FreeSearchAdapter().search('rrf', {
      onProgress: p => progress.push(p),
    })

    expect(progress).toEqual([
      { type: 'query_update', query: 'rrf' },
      { type: 'search_results_received', resultCount: 4, query: 'rrf' },
    ])
  })

  test('does not rescue when the run is healthy', async () => {
    routeByHost(ALL_ENGINES_OK)

    await new FreeSearchAdapter().search('rrf', {})

    for (const instance of SEARX_INSTANCES) {
      expect(requestedUrls.some(u => u.startsWith(instance))).toBe(false)
    }
  })

  test('survives one engine erroring out', async () => {
    routeByHost({
      ...ALL_ENGINES_OK,
      'www4.bing.com': new Error('bing gate'),
    })

    const results = await new FreeSearchAdapter().search('rrf', {})

    expect(results.length).toBeGreaterThan(0)
    expect(results.map(r => r.url)).toContain('https://example.com/ddg')
  })

  test('falls back to the SearXNG rescue pass when every engine is empty', async () => {
    routeByHost({
      searx: SEARX_HTML,
      etsi: SEARX_HTML,
      priv: SEARX_HTML,
      opnxng: SEARX_HTML,
      baresearch: SEARX_HTML,
      inetol: SEARX_HTML,
      rhscz: SEARX_HTML,
      hbubli: SEARX_HTML,
    })

    const results = await new FreeSearchAdapter().search('rrf', {})

    expect(results).toEqual([
      {
        title: 'Searx rescued result',
        url: 'https://searx.example.net/page',
        snippet: 'Rescued snippet',
      },
    ])
  })

  test('rethrows the first engine error when everything failed and the rescue found nothing', async () => {
    routeByHost({
      'html.duckduckgo.com': new Error('ddg down'),
      'www.mojeek.com': new Error('mojeek down'),
      'www4.bing.com': new Error('bing down'),
    })

    await expect(new FreeSearchAdapter().search('rrf', {})).rejects.toThrow(
      'ddg down',
    )
  })

  test('returns an empty list (no throw) when engines answer but match nothing', async () => {
    routeByHost({})

    const results = await new FreeSearchAdapter().search('rrf', {})

    expect(results).toEqual([])
  })

  test('filters by allowedDomains, including subdomains', async () => {
    routeByHost(ALL_ENGINES_OK)

    const results = await new FreeSearchAdapter().search('rrf', {
      allowedDomains: ['example.com'],
    })

    expect(results.map(r => r.url)).toEqual([
      SHARED_URL,
      'https://example.com/ddg',
    ])
  })

  test('filters by blockedDomains', async () => {
    routeByHost(ALL_ENGINES_OK)

    const results = await new FreeSearchAdapter().search('rrf', {
      blockedDomains: ['shared.example.com'],
    })

    expect(results.map(r => r.url)).not.toContain(SHARED_URL)
  })

  test('honours numResults', async () => {
    routeByHost(ALL_ENGINES_OK)

    const results = await new FreeSearchAdapter().search('rrf', {
      numResults: 2,
    })

    expect(results).toHaveLength(2)
  })

  test('throws AbortError when the signal is already aborted', async () => {
    routeByHost(ALL_ENGINES_OK)

    const controller = new AbortController()
    controller.abort()

    await expect(
      new FreeSearchAdapter().search('rrf', { signal: controller.signal }),
    ).rejects.toThrow(AbortError)
    expect(requestedUrls).toHaveLength(0)
  })

  test('throws AbortError when a request is cancelled mid-flight', async () => {
    const cancelled = new Error('canceled') as Error & { __CANCEL__?: boolean }
    cancelled.__CANCEL__ = true
    routeByHost({
      'html.duckduckgo.com': cancelled,
      'www.mojeek.com': cancelled,
      'www4.bing.com': cancelled,
    })
    axiosMock.stubs.isCancel = e =>
      (e as { __CANCEL__?: boolean })?.__CANCEL__ === true

    await expect(new FreeSearchAdapter().search('rrf', {})).rejects.toThrow(
      AbortError,
    )
  })
})

// ── Gate detection ─────────────────────────────────────────────────────────

/** DuckDuckGo's real 202 anomaly page: zero rows, and no literal "captcha". */
const DDG_ANOMALY_HTML =
  '<div class="anomaly-modal__mask"><p>Select all squares containing a duck</p></div>'

/** Bing's CAPTCHA shell, which keeps a normal-looking <title>. */
const BING_CAPTCHA_HTML =
  '<title>rrf - Search</title><div class="captcha_header">Verification required</div>'

describe('FreeSearchAdapter gate handling', () => {
  test('treats a walled engine as failed rather than as an empty result set', async () => {
    // Only DDG is walled; the other two answer normally. Without gate
    // detection this run looks perfectly healthy and DDG's absence is
    // invisible.
    routeByHost({
      'html.duckduckgo.com': DDG_ANOMALY_HTML,
      'www.mojeek.com': MOJEEK_HTML,
      'www4.bing.com': BING_HTML,
    })

    const results = await new FreeSearchAdapter().search('rrf', {})

    expect(results.map(r => r.url)).toContain('https://mojeek.example.org/only')
    expect(results.map(r => r.url)).not.toContain('https://example.com/ddg')
  })

  test('surfaces the gate reason when every engine is walled and nothing recovers', async () => {
    routeByHost({
      'html.duckduckgo.com': DDG_ANOMALY_HTML,
      'www.mojeek.com': BING_CAPTCHA_HTML,
      'www4.bing.com': BING_CAPTCHA_HTML,
    })

    // A silent `[]` here would reach the model as "the web has no answer".
    await expect(new FreeSearchAdapter().search('rrf', {})).rejects.toThrow(
      /gated/,
    )
  })

  test('prefers the gate error over a transport error from another lane', async () => {
    routeByHost({
      'html.duckduckgo.com': new Error('socket hang up'),
      'www.mojeek.com': BING_CAPTCHA_HTML,
      'www4.bing.com': new Error('socket hang up'),
    })

    await expect(new FreeSearchAdapter().search('rrf', {})).rejects.toThrow(
      /mojeek was captcha-gated/,
    )
  })
})

// ── Backstop tier (keyless JSON APIs) ──────────────────────────────────────

const WIKIPEDIA_BODY = JSON.stringify({
  query: { search: [{ title: 'Reciprocal rank fusion', snippet: 'A method' }] },
})
const HN_BODY = JSON.stringify({
  hits: [
    { objectID: '9', title: 'RRF explained', url: 'https://hn.example/rrf' },
  ],
})
const SE_BODY = JSON.stringify({
  items: [
    {
      title: 'How does RRF work?',
      link: 'https://stackoverflow.com/questions/9',
      tags: ['search'],
      score: 4,
      answer_count: 1,
    },
  ],
})

const API_TIER_OK = {
  'en.wikipedia.org': WIKIPEDIA_BODY,
  'hn.algolia.com': HN_BODY,
  'api.stackexchange.com': SE_BODY,
}

const API_HOSTS = Object.keys(API_TIER_OK)

describe('FreeSearchAdapter keyless API backstop', () => {
  test('does not touch the API tier when the SERP tier is healthy', async () => {
    routeByHost({ ...ALL_ENGINES_OK, ...API_TIER_OK })

    await new FreeSearchAdapter().search('rrf', {})

    // The quotas here are small (Stack Exchange 300/day, GitHub 10/min); the
    // happy path must never spend them.
    for (const host of API_HOSTS) {
      expect(requestedUrls.some(u => u.includes(host))).toBe(false)
    }
  })

  test('answers from the API tier when every SERP engine is walled', async () => {
    routeByHost({
      'html.duckduckgo.com': DDG_ANOMALY_HTML,
      'www.mojeek.com': BING_CAPTCHA_HTML,
      'www4.bing.com': BING_CAPTCHA_HTML,
      ...API_TIER_OK,
    })

    const results = await new FreeSearchAdapter().search('rrf', {})

    expect(results.length).toBeGreaterThan(0)
    expect(results.map(r => r.url)).toContain(
      'https://en.wikipedia.org/wiki/Reciprocal_rank_fusion',
    )
  })

  test('appends below the web results instead of displacing them', async () => {
    // DDG alone answers with two hits — sparse, and the run is unhealthy
    // because the other two engines returned nothing, so the backstop runs.
    routeByHost({ 'html.duckduckgo.com': DDG_HTML, ...API_TIER_OK })

    const results = await new FreeSearchAdapter().search('rrf', {})

    // DDG is the only lane answering, so its own ranking is the web order.
    expect(results.slice(0, 2).map(r => r.url)).toEqual([
      'https://example.com/ddg',
      SHARED_URL,
    ])
    expect(results.slice(2).map(r => r.url)).toContain(
      'https://en.wikipedia.org/wiki/Reciprocal_rank_fusion',
    )
  })

  test('routes narrow engines by query, keeping them off unrelated searches', async () => {
    routeByHost({ ...API_TIER_OK })

    await new FreeSearchAdapter().search('weather in tokyo', {})
    expect(requestedUrls.some(u => u.includes('api.github.com'))).toBe(false)

    requestedUrls = []
    await new FreeSearchAdapter().search('rust cli library', {})
    expect(requestedUrls.some(u => u.includes('api.github.com'))).toBe(true)
  })

  test('still honours numResults across the tier boundary', async () => {
    routeByHost({ 'html.duckduckgo.com': DDG_HTML, ...API_TIER_OK })

    const results = await new FreeSearchAdapter().search('rrf', {
      numResults: 3,
    })

    expect(results).toHaveLength(3)
  })

  test('applies domain filtering to backstop results too', async () => {
    routeByHost({
      'html.duckduckgo.com': DDG_ANOMALY_HTML,
      'www.mojeek.com': BING_CAPTCHA_HTML,
      'www4.bing.com': BING_CAPTCHA_HTML,
      ...API_TIER_OK,
    })

    const results = await new FreeSearchAdapter().search('rrf', {
      blockedDomains: ['en.wikipedia.org'],
    })

    expect(results.map(r => r.url)).not.toContain(
      'https://en.wikipedia.org/wiki/Reciprocal_rank_fusion',
    )
  })
})

// ── Helpers ────────────────────────────────────────────────────────────────

describe('appendBelow', () => {
  const hit = (url: string): { title: string; url: string } => ({
    title: url,
    url,
  })

  test('keeps every primary result ahead of the extras', () => {
    expect(
      appendBelow(
        [hit('https://a.example')],
        [hit('https://b.example')],
        8,
      ).map(r => r.url),
    ).toEqual(['https://a.example', 'https://b.example'])
  })

  test('drops extras that duplicate a primary URL after normalization', () => {
    expect(
      appendBelow(
        [hit('https://a.example/p')],
        [hit('https://a.example/p/?utm_source=x'), hit('https://b.example')],
        8,
      ).map(r => r.url),
    ).toEqual(['https://a.example/p', 'https://b.example'])
  })

  test('never exceeds the limit, and never truncates the primary list', () => {
    const primary = [hit('https://a.example'), hit('https://b.example')]
    expect(appendBelow(primary, [hit('https://c.example')], 2)).toHaveLength(2)
    expect(appendBelow(primary, [hit('https://c.example')], 1)).toHaveLength(2)
  })
})

describe('resolveSearxInstances', () => {
  const original = process.env.OCC_SEARX_INSTANCES

  afterAll(() => {
    if (original === undefined) delete process.env.OCC_SEARX_INSTANCES
    else process.env.OCC_SEARX_INSTANCES = original
  })

  test('falls back to the built-in shortlist', () => {
    delete process.env.OCC_SEARX_INSTANCES
    expect(resolveSearxInstances()).toEqual(SEARX_INSTANCES)
  })

  test('accepts comma- and space-separated pins', () => {
    process.env.OCC_SEARX_INSTANCES = 'https://a.example, https://b.example'
    expect(resolveSearxInstances()).toEqual([
      'https://a.example',
      'https://b.example',
    ])
  })

  test('ignores a blank value', () => {
    process.env.OCC_SEARX_INSTANCES = '   '
    expect(resolveSearxInstances()).toEqual(SEARX_INSTANCES)
  })
})
