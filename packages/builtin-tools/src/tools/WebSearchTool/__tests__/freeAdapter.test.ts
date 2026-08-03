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
  mergeByReciprocalRank,
  parseBingHtml,
  parseDuckDuckGoHtml,
  parseMojeekHtml,
  parseSearxHtml,
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
