/**
 * Keyless JSON/Atom search APIs — the free lane's backstop tier.
 *
 * The SERP scrapers (DuckDuckGo, Mojeek, Bing) share one failure mode: they
 * are HTML endpoints that decide, per client and per IP, whether to serve
 * results or a CAPTCHA. When they all decide "wall" at once the free lane used
 * to return an empty list, which reaches the model as "the web has no answer".
 *
 * These engines have no such gate. They are documented, machine-facing APIs
 * that answer any client with a User-Agent, so they cannot be fingerprinted out
 * of existence the way a scraped SERP can. That makes them a genuinely
 * different KIND of source rather than another site to scrape, which is the
 * point: a tier that fails for unrelated reasons is worth having.
 *
 * Adapted from the keyless API engines free-search-mcp grew in its 0.9 line
 * (sweetcornna/free-search-mcp @ v0.9.2,
 * 3d462eb59287c17a17e78e07025508c299f00202, MIT).
 *
 * Cost discipline — these run only when the SERP tier came back walled or
 * short (see freeAdapter.ts). On the happy path the pool costs nothing, so
 * none of these quotas is ever the reason a search fails:
 *   - Wikipedia / HN Algolia: generous, effectively unlimited here.
 *   - Stack Exchange: 300 requests/day per IP unauthenticated.
 *   - GitHub search: 10 requests/minute unauthenticated.
 *
 * Relevance discipline — a backstop that answers "weather in Tokyo" with
 * machine-learning preprints is its own kind of garbage. Engines whose index
 * only makes sense for a narrow class of query carry a `matches` predicate and
 * sit out everything else; the broad ones always run.
 */

import { decodeHtmlEntities } from './bingAdapter.js'
import type { SearchResult } from './types.js'

/**
 * One keyless API source.
 *
 * `parse` receives the raw response body and must never throw — an engine that
 * changed its schema has to degrade to "no results", not take the tier down.
 * `matches` is the routing gate; omit it for an engine worth asking about
 * anything.
 */
export interface KeylessApiEngine {
  readonly name: string
  buildUrl(query: string, numResults: number): string
  parse(body: string): SearchResult[]
  matches?(query: string): boolean
}

/**
 * Build a routing predicate from ASCII keywords and CJK substrings.
 *
 * The two need different matching rules. `\b` in JavaScript is defined over
 * `[A-Za-z0-9_]`, so there is no word boundary between a CJK character and
 * anything else and `/\b论文\b/` never matches at all — a Chinese query would
 * silently route to nothing. CJK has no inter-word spacing to anchor on
 * anyway, so those terms match as plain substrings.
 */
function keywordMatcher(
  asciiWords: readonly string[],
  cjkTerms: readonly string[] = [],
): (query: string) => boolean {
  const ascii = new RegExp(`\\b(${asciiWords.join('|')})\\b`, 'i')
  return query =>
    ascii.test(query) || cjkTerms.some(term => query.includes(term))
}

/** Strip tags and decode entities from an API-supplied HTML fragment. */
function plainText(value: string | undefined): string | undefined {
  if (!value) return undefined
  const text = decodeHtmlEntities(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
  return text || undefined
}

/** Parse JSON without throwing; a schema change must not sink the tier. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

// ── Wikipedia ──────────────────────────────────────────────────────────────

/**
 * The MediaWiki search API. Returns page titles, not URLs, so the canonical
 * article URL is rebuilt from the title — `/wiki/<Title>` with spaces as
 * underscores is stable and is what the site itself links to.
 */
export const WIKIPEDIA_ENGINE: KeylessApiEngine = {
  name: 'wikipedia',
  buildUrl: (query, numResults) =>
    'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json' +
    `&srsearch=${encodeURIComponent(query)}&srlimit=${numResults}`,
  parse(body) {
    const search = asArray(asRecord(asRecord(parseJson(body)).query).search)
    const results: SearchResult[] = []
    for (const entry of search) {
      const title = asString(asRecord(entry).title)
      if (!title) continue
      results.push({
        title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
        // The API marks matched terms with <span class="searchmatch">.
        snippet: plainText(asString(asRecord(entry).snippet)),
      })
    }
    return results
  },
}

// ── Stack Exchange ─────────────────────────────────────────────────────────

/**
 * Stack Overflow via the Stack Exchange API.
 *
 * The default filter carries no question body, and asking for one triples the
 * payload for a snippet the model can fetch properly if it cares. The metadata
 * Stack Overflow ranks on — score, answer count, whether anything is accepted —
 * is more useful per byte, so the snippet is built from that plus the tags.
 */
export const STACKEXCHANGE_ENGINE: KeylessApiEngine = {
  name: 'stackexchange',
  buildUrl: (query, numResults) =>
    'https://api.stackexchange.com/2.3/search/advanced?site=stackoverflow' +
    `&order=desc&sort=relevance&q=${encodeURIComponent(query)}&pagesize=${numResults}`,
  parse(body) {
    const results: SearchResult[] = []
    for (const entry of asArray(asRecord(parseJson(body)).items)) {
      const item = asRecord(entry)
      const title = asString(item.title)
      const url = asString(item.link)
      if (!title || !url) continue
      const tags = asArray(item.tags).filter(
        (tag): tag is string => typeof tag === 'string',
      )
      const facts = [
        `score ${typeof item.score === 'number' ? item.score : 0}`,
        `${typeof item.answer_count === 'number' ? item.answer_count : 0} answers`,
        item.is_accepted_answer === true || item.is_answered === true
          ? 'answered'
          : undefined,
        tags.length ? `tags: ${tags.join(', ')}` : undefined,
      ].filter(Boolean)
      results.push({
        // The API HTML-escapes titles (&quot;, &#39;, …).
        title: decodeHtmlEntities(title),
        url,
        snippet: facts.join(' · '),
      })
    }
    return results
  },
}

// ── Hacker News ────────────────────────────────────────────────────────────

/**
 * Hacker News through Algolia's public index.
 *
 * A hit is either a story (has `url`) or a comment (has none). Comments keep
 * their discussion permalink, since the thread is the useful destination.
 */
export const HACKERNEWS_ENGINE: KeylessApiEngine = {
  name: 'hackernews',
  buildUrl: (query, numResults) =>
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}` +
    `&hitsPerPage=${numResults}`,
  parse(body) {
    const results: SearchResult[] = []
    for (const entry of asArray(asRecord(parseJson(body)).hits)) {
      const hit = asRecord(entry)
      const objectId = asString(hit.objectID)
      const title = asString(hit.title) ?? asString(hit.story_title)
      if (!title || !objectId) continue
      results.push({
        title,
        url:
          asString(hit.url) ??
          `https://news.ycombinator.com/item?id=${objectId}`,
        snippet:
          plainText(asString(hit.story_text) ?? asString(hit.comment_text)) ??
          `${typeof hit.points === 'number' ? hit.points : 0} points · ` +
            `${typeof hit.num_comments === 'number' ? hit.num_comments : 0} comments`,
      })
    }
    return results
  },
}

// ── GitHub ─────────────────────────────────────────────────────────────────

/**
 * GitHub repository search.
 *
 * Rate-limited hard without a token (10 searches/minute), which the backstop
 * tiering already keeps in check, and routed on top of that: repository hits
 * answer "where does this library live", not "what does this error mean".
 */
export const GITHUB_ENGINE: KeylessApiEngine = {
  name: 'github',
  buildUrl: (query, numResults) =>
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}` +
    `&per_page=${numResults}`,
  parse(body) {
    const results: SearchResult[] = []
    for (const entry of asArray(asRecord(parseJson(body)).items)) {
      const item = asRecord(entry)
      const name = asString(item.full_name)
      const url = asString(item.html_url)
      if (!name || !url) continue
      const stars =
        typeof item.stargazers_count === 'number' ? item.stargazers_count : 0
      const description = asString(item.description)
      results.push({
        title: name,
        url,
        snippet: description
          ? `${description} (★${stars})`
          : `GitHub repository (★${stars})`,
      })
    }
    return results
  },
  matches: keywordMatcher(
    [
      'github',
      'repo',
      'repository',
      'library',
      'package',
      'sdk',
      'cli',
      'npm',
      'pypi',
      'crate',
      'open[- ]?source',
    ],
    ['仓库', '开源', '代码库'],
  ),
}

// ── arXiv ──────────────────────────────────────────────────────────────────

const ARXIV_ENTRY = /<entry>([\s\S]*?)<\/entry>/g

function arxivField(entry: string, tag: string): string | undefined {
  return plainText(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(entry)?.[1],
  )
}

/**
 * arXiv's Atom API. XML rather than JSON, and narrow enough that it is routed:
 * preprints are the right answer to "attention is all you need" and noise for
 * anything else.
 */
export const ARXIV_ENGINE: KeylessApiEngine = {
  name: 'arxiv',
  buildUrl: (query, numResults) =>
    `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}` +
    `&max_results=${numResults}`,
  parse(body) {
    const results: SearchResult[] = []
    ARXIV_ENTRY.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = ARXIV_ENTRY.exec(body)) !== null) {
      const entry = match[1] ?? ''
      const title = arxivField(entry, 'title')
      const id = arxivField(entry, 'id')
      if (!title || !id) continue
      results.push({
        title,
        // <id> is the abs/ permalink; it is already the human-facing page.
        url: id.replace(/^http:/, 'https:'),
        snippet: arxivField(entry, 'summary')?.slice(0, 400),
      })
    }
    return results
  },
  matches: keywordMatcher(
    [
      'paper',
      'papers',
      'preprint',
      'arxiv',
      'research',
      'study',
      'dataset',
      'benchmark',
      'thesis',
      'citation',
    ],
    ['论文', '研究', '预印本'],
  ),
}

/**
 * Registry order, which is also the merge order for engines that tie.
 * Broad-index engines lead so a routed specialist never outranks them.
 */
export const KEYLESS_API_ENGINES: readonly KeylessApiEngine[] = [
  WIKIPEDIA_ENGINE,
  STACKEXCHANGE_ENGINE,
  HACKERNEWS_ENGINE,
  GITHUB_ENGINE,
  ARXIV_ENGINE,
]

/** The engines worth asking about `query` — unrouted ones always qualify. */
export function selectApiEngines(query: string): KeylessApiEngine[] {
  return KEYLESS_API_ENGINES.filter(
    engine => !engine.matches || engine.matches(query),
  )
}
