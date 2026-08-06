/**
 * Free (no-API-key) search adapter.
 *
 * Ported from sweetcornna/free-search-mcp @ v0.9.1 (7933a002a6159c03763d32a8c9f97742ee078cc7)
 * (https://github.com/sweetcornna/free-search-mcp, MIT) — a local-first,
 * keyless search MCP server. Instead of spawning that Python server as an
 * MCP subprocess, its keyless search technique is re-implemented natively
 * here so it plugs into the existing WebSearchAdapter contract.
 *
 * Re-check against that upstream tag when touching this file: the engine
 * list, the SERP selectors and the SearXNG shortlist are the parts that rot.
 *
 * Ported from upstream:
 *   - The keyless HTTP engine pool: DuckDuckGo's `html.duckduckgo.com`
 *     endpoint, Mojeek's independent index, and the `www4.bing.com` edge
 *     (upstream's finding: `www.bing.com` challenges headless clients while
 *     www4 serves the same index over plain HTTP).
 *   - Parallel fan-out + Reciprocal Rank Fusion (k = 60): a URL that several
 *     engines rank highly wins. Stable, no scoring magic.
 *   - The bounded "rescue" pass through public SearXNG instances when the
 *     default pool comes back empty (or sparse with a failing engine), racing
 *     a small batch so a dead instance costs one timeout instead of N.
 *   - Post-merge dedup of syndicated copies (AMP/mobile hosts, country TLDs).
 *
 * Three tiers, each escalated to only when the one above came back walled or
 * short (see `needsBackstop`), so the happy path costs exactly one fan-out:
 *
 *   1. SERP scrapers — DuckDuckGo, Mojeek, Bing, merged by RRF.
 *   2. Public SearXNG instances, raced in small batches.
 *   3. Keyless JSON/Atom APIs (apiEngines.ts), appended BELOW the web results.
 *
 * The tiering exists because tier 1 has a failure mode the others do not: it
 * scrapes HTML endpoints that decide per client whether to serve results or a
 * CAPTCHA. All three were verified serving walls to a plain Node/Bun client at
 * the time of writing — DuckDuckGo an HTTP 202 anomaly page, Mojeek and Bing
 * outright CAPTCHAs — which is why gate detection (gate.ts) and a tier that is
 * not a scraper at all both had to exist.
 *
 * Deliberate deviations from upstream:
 *   - Upstream's `googlenews` engine is NOT in the pool. Its result URLs are
 *     `news.google.com/rss/articles/CBMi…` redirect blobs rather than
 *     publisher URLs, and WebSearch hands URLs straight to the model.
 *   - No Playwright fallback (occ ships no browser runtime), no rate limiter
 *     and no on-disk cache — those are search-server concerns. Upstream also
 *     clears the CAPTCHA walls with curl_cffi's TLS/JA3 browser impersonation,
 *     which has no dependency-free equivalent in Node/Bun; full Chrome client
 *     hints (browserHeaders.ts) recover DuckDuckGo but not Mojeek or Bing, and
 *     tier 3 is what covers the rest.
 *   - HTML parsing is regex-based (upstream uses selectolax). This package
 *     already parses Bing's SERP with regex, and a DOM parser dependency for
 *     four selector sets is not worth the install cost.
 *   - Title dedup uses exact normalized-title equality on the same canonical
 *     host, where upstream uses a rapidfuzz ratio >= 92. Adding a fuzzy
 *     matching dependency for one heuristic is not worth it; exact match
 *     keeps upstream's numeric guard for free (two titles whose digits differ
 *     produce different keys, so "Python 3.13" never eats "Python 3.12").
 */

import axios from 'axios'
import { AbortError } from '@open-claude-code/tool-runtime/errors.js'
import { selectApiEngines, type KeylessApiEngine } from './apiEngines.js'
import { decodeHtmlEntities, resolveBingUrl } from './bingAdapter.js'
import { BROWSER_HEADERS, JSON_API_HEADERS } from './browserHeaders.js'
import { filterResultsByDomains } from './domainFilter.js'
import { detectGate, GatedEngineError } from './gate.js'
import { normalizeUrlForDedup } from './urlKey.js'
import type { SearchResult, SearchOptions, WebSearchAdapter } from './types.js'

/** Upstream's `request_timeout` (15s) and `_PER_INSTANCE_TIMEOUT` (5s). */
const ENGINE_TIMEOUT_MS = 15_000
const SEARX_INSTANCE_TIMEOUT_MS = 5_000
const SEARX_RACE_BATCH = 3
/** Reciprocal Rank Fusion damping constant — upstream's `k = 60.0`. */
const RRF_K = 60
/**
 * Upstream's rescue trigger: a run of <= 3 results is only "sparse enough to
 * rescue" when an engine also failed or returned nothing. A healthy niche
 * query that legitimately yields two hits must not pay for extra network.
 */
const SPARSE_RESULT_THRESHOLD = 3

/**
 * Public SearXNG instances.
 *
 * Public instances rot faster than anything else in this file — DNS death,
 * 429 walls, disabled upstream engines, and lately Anubis proof-of-work
 * interstitials in front of the search form. Hence the race-and-move-on
 * strategy below, and hence `OCC_SEARX_INSTANCES`: when the shortlist has
 * rotted out from under a user, pinning a known-good instance has to be
 * possible without shipping a release.
 *
 * The leading two were verified returning 20 parsed results each on the day
 * this list was last refreshed; the rest are kept as fallbacks the race skips
 * quickly when dead. Every instance inherited from upstream's shortlist was
 * verified DEAD at that point (homepage or bot-wall, zero results), so a
 * refresh here is the difference between the rescue tier working and it being
 * decoration.
 */
const DEFAULT_SEARX_INSTANCES: readonly string[] = [
  'https://paulgo.io',
  'https://searxng.site',
  'https://search.inetol.net',
  'https://searx.tiekoetter.com',
  'https://opnxng.com',
  'https://search.rhscz.eu',
  'https://priv.au',
  'https://etsi.me',
  'https://baresearch.org',
]

/**
 * Operator-pinned instances (`OCC_SEARX_INSTANCES`, comma/space separated)
 * when set, else the built-in shortlist. Mirrors upstream's
 * SEARCH_MCP_SEARX_INSTANCES escape hatch.
 */
export function resolveSearxInstances(): readonly string[] {
  const pinned = (process.env.OCC_SEARX_INSTANCES ?? '')
    .split(/[,\s]+/)
    .map(entry => entry.trim())
    .filter(Boolean)
  return pinned.length ? pinned : DEFAULT_SEARX_INSTANCES
}

/** The built-in shortlist. Callers that need the live set use `resolveSearxInstances()`. */
export const SEARX_INSTANCES: readonly string[] = DEFAULT_SEARX_INSTANCES

// ── HTML helpers (regex-based; see file header) ────────────────────────────

function attributeOf(attrs: string, name: string): string | undefined {
  const doubleQuoted = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(
    attrs,
  )
  if (doubleQuoted) return doubleQuoted[1]
  const singleQuoted = new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i').exec(
    attrs,
  )
  return singleQuoted?.[1]
}

function classTokens(attrs: string): string[] {
  const raw = attributeOf(attrs, 'class')
  return raw ? raw.trim().split(/\s+/).filter(Boolean) : []
}

function hasClass(attrs: string, token: string): boolean {
  return classTokens(attrs).includes(token)
}

/** Strip tags, decode entities, collapse whitespace. */
function textOf(html: string | undefined): string {
  if (!html) return ''
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

interface HtmlBlock {
  attrs: string
  body: string
}

/**
 * Split `html` into sibling blocks opened by `<tagName …>` whose attributes
 * satisfy `accept`. A block runs until the next accepted opening tag (result
 * rows are siblings, so this is exact for SERP markup and never needs a real
 * nesting-aware parse).
 */
function splitBlocks(
  html: string,
  tagName: string,
  accept: (attrs: string) => boolean,
): HtmlBlock[] {
  const openTag = new RegExp(`<${tagName}\\b([^>]*)>`, 'gi')
  const starts: { attrs: string; tagStart: number; bodyStart: number }[] = []
  let match: RegExpExecArray | null
  while ((match = openTag.exec(html)) !== null) {
    const attrs = match[1] ?? ''
    if (accept(attrs)) {
      starts.push({
        attrs,
        tagStart: match.index,
        bodyStart: openTag.lastIndex,
      })
    }
  }
  return starts.map((start, index) => ({
    attrs: start.attrs,
    body: html.slice(start.bodyStart, starts[index + 1]?.tagStart),
  }))
}

const CONTENT_TAGS = 'a|div|span|p|td|h3|section'

/**
 * Text of the first element in `block` whose class tokens satisfy `matches`.
 *
 * Scans OPENING tags and then reads to that tag's closing tag, rather than
 * matching whole elements: a whole-element regex consumes the children of
 * every element it rejects, and SERP snippets live inside a wrapper div the
 * predicate rejects (DuckDuckGo's `.result__snippet` sits in `.result__body`).
 */
function elementText(
  block: string,
  matches: (tokens: string[]) => boolean,
): string | undefined {
  const openTag = new RegExp(`<(${CONTENT_TAGS})\\b([^>]*)>`, 'gi')
  let match: RegExpExecArray | null
  while ((match = openTag.exec(block)) !== null) {
    if (!matches(classTokens(match[2] ?? ''))) continue
    const rest = block.slice(openTag.lastIndex)
    const closeTag = new RegExp(`</${match[1]}\\s*>`, 'i').exec(rest)
    const text = textOf(closeTag ? rest.slice(0, closeTag.index) : rest)
    if (text) return text
  }
  return undefined
}

function elementTextByClass(block: string, token: string): string | undefined {
  return elementText(block, tokens => tokens.includes(token))
}

interface HtmlAnchor {
  attrs: string
  href: string
  text: string
}

function anchorsIn(block: string): HtmlAnchor[] {
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  const anchors: HtmlAnchor[] = []
  let match: RegExpExecArray | null
  while ((match = anchor.exec(block)) !== null) {
    const attrs = match[1] ?? ''
    const href = attributeOf(attrs, 'href')
    if (!href) continue
    anchors.push({
      attrs,
      href: decodeHtmlEntities(href),
      text: textOf(match[2]),
    })
  }
  return anchors
}

function firstAnchorInside(
  block: string,
  tagName: string,
): HtmlAnchor | undefined {
  const wrapper = new RegExp(
    `<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`,
    'i',
  )
  const inner = wrapper.exec(block)?.[1]
  return inner ? anchorsIn(inner)[0] : undefined
}

// ── Engine parsers ─────────────────────────────────────────────────────────

/**
 * DuckDuckGo's HTML endpoint wraps every organic href in a
 * `//duckduckgo.com/l/?uddg=<target>` redirect. `searchParams.get` decodes it
 * exactly once — decoding twice would corrupt targets containing literal %xx
 * (upstream's example: `/wiki/C%2B%2B` would collapse to `C++` and 404).
 */
export function unwrapDuckDuckGoUrl(raw: string): string {
  if (!raw) return raw
  const absolute = raw.startsWith('//') ? `https:${raw}` : raw
  try {
    const parsed = new URL(absolute)
    if (
      parsed.hostname.endsWith('duckduckgo.com') &&
      parsed.pathname.startsWith('/l/')
    ) {
      const target = parsed.searchParams.get('uddg')
      if (target) return target
    }
  } catch {
    // Relative or malformed href — hand it back untouched; the caller drops
    // anything that does not parse as a URL later on.
  }
  return absolute
}

export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = []
  const seen = new Set<string>()
  // Every organic row carries the bare `result` class token alongside
  // `web-result` etc. Matching the exact token (not a substring) keeps
  // `result__body` / `results_links` wrappers from being read as rows, which
  // is what would otherwise double DuckDuckGo's weight in the RRF merge.
  for (const row of splitBlocks(html, 'div', attrs =>
    hasClass(attrs, 'result'),
  )) {
    const tokens = classTokens(row.attrs)
    if (tokens.includes('result--ad') || tokens.includes('result--sponsored')) {
      continue
    }
    const link = anchorsIn(row.body).find(a => hasClass(a.attrs, 'result__a'))
    if (!link) continue
    const url = unwrapDuckDuckGoUrl(link.href)
    if (!url || url.includes('duckduckgo.com/y.js')) continue
    if (url.includes('ad_provider=')) continue
    if (!link.text || seen.has(url)) continue
    seen.add(url)
    results.push({
      title: link.text,
      url,
      snippet: elementTextByClass(row.body, 'result__snippet'),
    })
  }
  return results
}

export function parseMojeekHtml(html: string): SearchResult[] {
  // Scope to the organic list when present so nav/footer <li>s never appear.
  const listStart =
    /<ul\b[^>]*\bclass\s*=\s*"[^"]*\bresults-standard\b[^"]*"[^>]*>/i.exec(html)
  const scope = listStart
    ? html.slice(listStart.index + listStart[0].length)
    : html
  const results: SearchResult[] = []
  for (const row of splitBlocks(scope, 'li', () => true)) {
    const link = anchorsIn(row.body).find(a => hasClass(a.attrs, 'title'))
    if (!link?.text) continue
    results.push({
      title: link.text,
      url: link.href,
      snippet: elementTextByClass(row.body, 's'),
    })
  }
  return results
}

export function parseBingHtml(html: string): SearchResult[] {
  const results: SearchResult[] = []
  for (const row of splitBlocks(html, 'li', attrs =>
    hasClass(attrs, 'b_algo'),
  )) {
    const link = firstAnchorInside(row.body, 'h2') ?? anchorsIn(row.body)[0]
    if (!link) continue
    const url = resolveBingUrl(link.href)
    if (!url || !link.text) continue
    const snippet =
      elementText(row.body, tokens =>
        tokens.some(token => token.startsWith('b_lineclamp')),
      ) ?? elementTextByClass(row.body, 'b_caption')
    results.push({ title: link.text, url, snippet })
  }
  return results
}

export function parseSearxHtml(html: string): SearchResult[] {
  const results: SearchResult[] = []
  for (const row of splitBlocks(html, 'article', attrs =>
    hasClass(attrs, 'result'),
  )) {
    if (classTokens(row.attrs).includes('result-ad')) continue
    const link =
      firstAnchorInside(row.body, 'h3') ??
      anchorsIn(row.body).find(a => hasClass(a.attrs, 'url_header'))
    if (!link?.href || !link.text) continue
    results.push({
      title: link.text,
      url: link.href,
      snippet: elementTextByClass(row.body, 'content'),
    })
  }
  return results
}

// ── Engines ────────────────────────────────────────────────────────────────

export interface FreeSearchEngine {
  readonly name: string
  buildUrl(query: string, numResults: number): string
  parse(body: string): SearchResult[]
}

export const DUCKDUCKGO_ENGINE: FreeSearchEngine = {
  name: 'duckduckgo',
  buildUrl: query =>
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`,
  parse: parseDuckDuckGoHtml,
}

export const MOJEEK_ENGINE: FreeSearchEngine = {
  name: 'mojeek',
  buildUrl: query =>
    `https://www.mojeek.com/search?q=${encodeURIComponent(query)}&arc=us`,
  parse: parseMojeekHtml,
}

export const BING_ENGINE: FreeSearchEngine = {
  name: 'bing',
  // www4 is upstream's finding: www.bing.com serves headless clients a
  // "something went wrong" challenge, www4 serves the same organic index.
  buildUrl: (query, numResults) =>
    `https://www4.bing.com/search?q=${encodeURIComponent(query)}` +
    `&count=${Math.min(Math.max(numResults, 10), 50)}&mkt=en-US`,
  parse: parseBingHtml,
}

/** Upstream's all-HTTP default pool, minus googlenews (see file header). */
export const DEFAULT_FREE_ENGINES: readonly FreeSearchEngine[] = [
  DUCKDUCKGO_ENGINE,
  MOJEEK_ENGINE,
  BING_ENGINE,
]

// ── Merge ──────────────────────────────────────────────────────────────────

/**
 * Upstream keys the RRF merge on "URL minus fragment and trailing slash". We
 * key on the stack-wide rule instead (which also drops tracking parameters),
 * so a page two engines returned with different campaign params merges into
 * one result here exactly as it does one level up in the aggregator.
 */
export function normalizeResultUrl(url: string): string {
  return normalizeUrlForDedup(url)
}

const HOST_PREFIXES = ['www.', 'm.', 'amp.', 'mobile.'] as const
/**
 * Country-coded TLDs collapsed to `.com` so bbc.co.uk and bbc.com read as one
 * host for the dedup pass. Generic TLDs are never touched.
 */
const TLD_NORMALIZE = ['.co.uk', '.co.jp', '.com.au', '.co.in'] as const

function canonicalHost(url: string): string {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
  for (const prefix of HOST_PREFIXES) {
    if (host.startsWith(prefix)) {
      host = host.slice(prefix.length)
      break
    }
  }
  for (const tld of TLD_NORMALIZE) {
    if (host.endsWith(tld)) {
      host = `${host.slice(0, -tld.length)}.com`
      break
    }
  }
  return host
}

function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * Drop syndicated copies URL-keyed dedup misses: bbc.com/news/x vs
 * bbc.co.uk/news/x, amp.example.com/x vs www.example.com/x. Different hosts
 * with the same title (a wire story on Reuters and AP) are kept — those are
 * legitimately distinct sources.
 */
function dedupeByTitle(results: SearchResult[]): SearchResult[] {
  const kept: SearchResult[] = []
  const seen = new Set<string>()
  for (const result of results) {
    const key = titleKey(result.title)
    if (!key) {
      kept.push(result)
      continue
    }
    const compound = `${canonicalHost(result.url)} ${key}`
    if (seen.has(compound)) continue
    seen.add(compound)
    kept.push(result)
  }
  return kept
}

/**
 * Reciprocal Rank Fusion across engine buckets: the same URL ranked highly by
 * several engines wins. Ties keep bucket order (Array.sort is stable), so the
 * merge is deterministic.
 */
export function mergeByReciprocalRank(
  buckets: SearchResult[][],
  limit: number,
): SearchResult[] {
  const scores = new Map<string, number>()
  const representative = new Map<string, SearchResult>()

  for (const bucket of buckets) {
    bucket.forEach((hit, rank) => {
      const url = normalizeResultUrl(hit.url)
      if (!url) return
      scores.set(url, (scores.get(url) ?? 0) + 1 / (RRF_K + rank))
      const current = representative.get(url)
      // Keep the longest snippet seen for this URL — engines truncate
      // differently and the model benefits from the fullest context.
      if (
        !current ||
        (hit.snippet?.length ?? 0) > (current.snippet?.length ?? 0)
      ) {
        representative.set(url, { ...hit, url })
      }
    })
  }

  const ranked: SearchResult[] = []
  for (const [url] of [...scores.entries()].sort((a, b) => b[1] - a[1])) {
    const record = representative.get(url)
    if (record) ranked.push(record)
  }
  // Dedup over the FULL ranked list before slicing, so a duplicate inside the
  // top-N is backfilled by the next unique result instead of leaving the
  // caller short of `limit`.
  return dedupeByTitle(ranked).slice(0, limit)
}

/**
 * Whether a tier below should run.
 *
 * Nothing found always escalates. A short run only escalates when the tier
 * above was demonstrably unhealthy (an engine errored, was gated, or returned
 * a silent zero) — a healthy niche query that legitimately yields two hits
 * must not pay for extra network. This is upstream's rescue trigger, reused
 * for both backstop tiers so they share one definition of "not good enough".
 */
function needsBackstop(resultCount: number, unhealthy: boolean): boolean {
  if (resultCount === 0) return true
  return resultCount <= SPARSE_RESULT_THRESHOLD && unhealthy
}

/**
 * Append `extra` after `primary`, skipping URLs already present, up to `limit`.
 * Dedup uses the stack-wide normalized URL so a page the backstop found under
 * different campaign parameters is not served twice.
 */
export function appendBelow(
  primary: SearchResult[],
  extra: SearchResult[],
  limit: number,
): SearchResult[] {
  const merged = [...primary]
  const seen = new Set(merged.map(result => normalizeResultUrl(result.url)))
  for (const result of extra) {
    if (merged.length >= limit) break
    const key = normalizeResultUrl(result.url)
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push({ ...result, url: key })
  }
  return merged
}

// ── Fetch / fan-out ────────────────────────────────────────────────────────

async function fetchText(
  url: string,
  signal: AbortSignal,
  timeoutMs: number,
  headers: Record<string, string> = BROWSER_HEADERS,
): Promise<string> {
  const response = await axios.get(url, {
    signal,
    timeout: timeoutMs,
    responseType: 'text',
    headers,
  })
  return typeof response.data === 'string'
    ? response.data
    : String(response.data ?? '')
}

interface EngineOutcome {
  engine: string
  results: SearchResult[]
  error?: Error
}

async function runEngine(
  engine: FreeSearchEngine,
  query: string,
  numResults: number,
  signal: AbortSignal,
): Promise<EngineOutcome> {
  try {
    const body = await fetchText(
      engine.buildUrl(query, numResults),
      signal,
      ENGINE_TIMEOUT_MS,
    )
    const results = engine.parse(body)
    // Zero rows is ambiguous: an honest "nothing matched" and a CAPTCHA served
    // in place of results parse identically. Only the second is a failure, and
    // conflating them is what let a fully walled pool return `[]` — which the
    // model reads as "the web has no answer" — without ever escalating.
    if (results.length === 0) {
      const gate = detectGate(body)
      if (gate) {
        return {
          engine: engine.name,
          results: [],
          error: new GatedEngineError(engine.name, gate),
        }
      }
    }
    return { engine: engine.name, results }
  } catch (e) {
    if (signal.aborted || axios.isCancel(e)) throw new AbortError()
    // One gated/erroring engine must not sink the fan-out: record it so the
    // rescue trigger can see the run was unhealthy, and carry on.
    return {
      engine: engine.name,
      results: [],
      error: e instanceof Error ? e : new Error(String(e)),
    }
  }
}

/**
 * Run the routed keyless APIs concurrently. Never throws except on abort: this
 * is the last tier, and an engine failing here has to leave whatever the tiers
 * above found intact.
 */
async function runApiEngines(
  engines: KeylessApiEngine[],
  query: string,
  numResults: number,
  signal: AbortSignal,
): Promise<SearchResult[][]> {
  return await Promise.all(
    engines.map(async engine => {
      try {
        const body = await fetchText(
          engine.buildUrl(query, numResults),
          signal,
          ENGINE_TIMEOUT_MS,
          JSON_API_HEADERS,
        )
        return engine.parse(body)
      } catch (e) {
        if (signal.aborted || axios.isCancel(e)) throw new AbortError()
        return []
      }
    }),
  )
}

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const swap = copy[i] as T
    copy[i] = copy[j] as T
    copy[j] = swap
  }
  return copy
}

/**
 * One bounded keyless recovery pass through public SearXNG instances.
 *
 * Instance order is randomised (spreads load, avoids pinning one instance)
 * and probed in small concurrent batches: a dead instance costs about one
 * per-instance timeout for the whole batch rather than one timeout each.
 * Never raises except on abort — a flaky instance must not poison the search.
 */
async function rescueViaSearx(
  query: string,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const order = shuffled(resolveSearxInstances())
  for (let start = 0; start < order.length; start += SEARX_RACE_BATCH) {
    const batch = order.slice(start, start + SEARX_RACE_BATCH)
    const parsed = await Promise.all(
      batch.map(async instance => {
        try {
          const body = await fetchText(
            `${instance.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}`,
            signal,
            SEARX_INSTANCE_TIMEOUT_MS,
          )
          return parseSearxHtml(body)
        } catch (e) {
          if (signal.aborted || axios.isCancel(e)) throw new AbortError()
          return []
        }
      }),
    )
    const winner = parsed.find(results => results.length > 0)
    if (winner) return winner
  }
  return []
}

export class FreeSearchAdapter implements WebSearchAdapter {
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { signal, onProgress, allowedDomains, blockedDomains } = options

    if (signal?.aborted) {
      throw new AbortError()
    }

    onProgress?.({ type: 'query_update', query })

    const numResults = options.numResults ?? 8
    const abortController = new AbortController()
    if (signal) {
      signal.addEventListener('abort', () => abortController.abort(), {
        once: true,
      })
    }

    const outcomes = await Promise.all(
      DEFAULT_FREE_ENGINES.map(engine =>
        runEngine(engine, query, numResults, abortController.signal),
      ),
    )

    if (abortController.signal.aborted) {
      throw new AbortError()
    }

    // Post-filter BEFORE the merge so the result budget is never spent on
    // hits the caller excluded.
    const filter = (results: SearchResult[]): SearchResult[] =>
      filterResultsByDomains(results, allowedDomains, blockedDomains)
    const buckets = outcomes.map(outcome => filter(outcome.results))
    let merged = mergeByReciprocalRank(buckets, numResults)

    const unhealthy = outcomes.some(
      outcome => outcome.error !== undefined || outcome.results.length === 0,
    )

    // ── Tier 2: SearXNG rescue ────────────────────────────────────────────
    if (needsBackstop(merged.length, unhealthy)) {
      const rescued = await rescueViaSearx(query, abortController.signal)
      if (abortController.signal.aborted) {
        throw new AbortError()
      }
      if (rescued.length > 0) {
        buckets.push(filter(rescued))
        merged = mergeByReciprocalRank(buckets, numResults)
      }
    }

    // ── Tier 3: keyless JSON APIs ─────────────────────────────────────────
    // Appended BELOW the scraped web results rather than folded into the RRF
    // merge: a Wikipedia article that is rank 1 of its own single-engine
    // bucket scores exactly as high as a genuine top organic hit, so merging
    // them as peers would let the backstop displace the real answer. Every
    // web result keeps its position and these only fill what is left.
    if (needsBackstop(merged.length, unhealthy)) {
      const apiEngines = selectApiEngines(query)
      if (apiEngines.length > 0) {
        const apiBuckets = await runApiEngines(
          apiEngines,
          query,
          numResults,
          abortController.signal,
        )
        if (abortController.signal.aborted) {
          throw new AbortError()
        }
        const apiResults = mergeByReciprocalRank(
          apiBuckets.map(filter),
          numResults,
        )
        merged = appendBelow(merged, apiResults, numResults)
      }
    }

    // Every engine failed outright (offline, DNS, all gated) and no tier
    // below recovered anything: surface the cause instead of an empty result
    // set the model would read as "the web has no answer". A gate error is
    // preferred over a transport error — "Bing served a CAPTCHA" is the
    // actionable half of a run where DNS also happened to be slow.
    if (merged.length === 0 && outcomes.length > 0) {
      const errors = outcomes
        .map(outcome => outcome.error)
        .filter((error): error is Error => error !== undefined)
      if (errors.length === outcomes.length && errors.length > 0) {
        throw (
          errors.find(error => error instanceof GatedEngineError) ?? errors[0]
        )
      }
    }

    onProgress?.({
      type: 'search_results_received',
      resultCount: merged.length,
      query,
    })

    return merged
  }
}
