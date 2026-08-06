/**
 * Gemini search adapter — Google's own server-side search layer.
 *
 * Calls `generateContent` with the `googleSearch` grounding tool enabled and
 * reads the sources back out of `groundingMetadata`. This is the
 * gemini-provider equivalent of `apiAdapter`: Google runs the search, so the
 * results are the ones the model would have grounded its answer on.
 *
 * Shape of a grounded response (per candidate):
 *   groundingMetadata.webSearchQueries  — the queries Gemini actually ran
 *   groundingMetadata.groundingChunks[] — { web: { uri, title, domain } }
 *   groundingMetadata.groundingSupports[] — answer segments, each pointing at
 *                                           the chunk indices backing them
 *
 * The supports give us snippets: the answer text a chunk supports is the
 * closest thing Gemini returns to a result summary.
 *
 * Auth/transport is reused wholesale from src/services/api/gemini/client.ts
 * (GEMINI_API_KEY, GEMINI_BASE_URL, proxy options, SSE framing) — including
 * its two routes: the public endpoint and the Antigravity backend a Google
 * login unlocks. The model, however, is this module's call, and the two
 * backends do NOT serve the same catalogue: see resolveGeminiSearchModel.
 */

import type {
  GeminiGenerateContentRequest,
  GeminiGroundingMetadata,
  GeminiStreamChunk,
} from '@ant/model-provider'
import { resolveGeminiModel } from '@ant/model-provider'
import { AbortError } from '@open-claude-code/tool-runtime/errors.js'
import {
  streamGeminiGenerateContent,
  usesAntigravityRoute,
} from 'src/services/api/gemini/client.js'
import {
  ANTIGRAVITY_FLASH_LITE_MODEL,
  findAntigravityModelOption,
} from 'src/utils/model/antigravityModels.js'
import { getMainLoopModel } from 'src/utils/model/model.js'
import { filterResultsByDomains } from './domainFilter.js'
import type { SearchResult, SearchOptions, WebSearchAdapter } from './types.js'

const SEARCH_SYSTEM_PROMPT =
  'You are an assistant for performing a web search tool use. ' +
  'Search the web and summarise what you find, citing every source.'

/** Google Search grounding — an empty object is the whole tool declaration. */
const GOOGLE_SEARCH_TOOL = { googleSearch: {} } as const

/**
 * Model for the grounded-search turn when the main-loop model does not map to
 * a Gemini one.
 *
 * resolveGeminiModel() throws unless GEMINI_MODEL / GEMINI_DEFAULT_*_MODEL is
 * configured — right for the main loop, wrong here: this source also runs for
 * users whose session is on another provider entirely and who have configured
 * no Gemini model at all. A grounded search only has to call the tool, so the
 * cheap flash tier is the sane default. GEMINI_MODEL still wins, because
 * resolveGeminiModel checks it first.
 */
const DEFAULT_SEARCH_MODEL = 'gemini-2.5-flash'

/** Cheapest tier the Antigravity backend serves — a grounded search only has
 * to call the tool. */
const ANTIGRAVITY_SEARCH_MODEL = ANTIGRAVITY_FLASH_LITE_MODEL

/**
 * The two backends serve different model catalogues, and Antigravity rejects
 * anything outside its own with a bare 404 "Requested entity was not found".
 * `gemini-2.5-flash` is a public-endpoint id, so it 404s there — which is what
 * a Google-logged-in user on another provider used to get from this source,
 * every single time, silenced by the aggregator.
 */
export function resolveGeminiSearchModel(useAntigravity: boolean): string {
  let mapped: string | undefined
  try {
    mapped = resolveGeminiModel(getMainLoopModel())
  } catch {
    // No Gemini model configured at all — expected when the session is on
    // another provider entirely.
  }
  if (!useAntigravity) return mapped ?? DEFAULT_SEARCH_MODEL
  // GEMINI_MODEL may still hold a public-endpoint id from an earlier API-key
  // setup; only an id this backend actually serves may be forwarded.
  return mapped && findAntigravityModelOption(mapped)
    ? mapped
    : ANTIGRAVITY_SEARCH_MODEL
}

/**
 * Snippet per grounding chunk, drawn from the answer segments that cite it.
 *
 * A segment is claimed by at most ONE chunk. Grounding routinely backs a single
 * sentence with three or four sources, and handing that sentence to every one
 * of them produced result lists where four different URLs carried the identical
 * snippet: no signal for choosing between them, and a description that is not
 * actually of the page in three cases out of four. A chunk whose every citing
 * segment is already spoken for gets no snippet instead of a borrowed one —
 * absent beats wrong, and the title and URL still identify the page.
 *
 * Segments are visited in answer order and each is offered to the first chunk
 * still lacking a snippet, so coverage stays as wide as honest attribution
 * allows.
 */
function snippetsByChunkIndex(
  metadata: GeminiGroundingMetadata,
): Map<number, string> {
  const snippets = new Map<number, string>()
  const claimed = new Set<string>()
  for (const support of metadata.groundingSupports ?? []) {
    const text = support.segment?.text?.trim()
    if (!text || claimed.has(text)) continue
    for (const index of support.groundingChunkIndices ?? []) {
      if (snippets.has(index)) continue
      snippets.set(index, text)
      claimed.add(text)
      break
    }
  }
  return snippets
}

export function collectGeminiGroundingChunk(
  chunk: GeminiStreamChunk,
  into: Map<string, SearchResult>,
  onSearchQuery?: (query: string) => void,
): void {
  for (const candidate of chunk.candidates ?? []) {
    const metadata = candidate.groundingMetadata
    if (!metadata) continue

    for (const searchQuery of metadata.webSearchQueries ?? []) {
      if (searchQuery) onSearchQuery?.(searchQuery)
    }

    const snippets = snippetsByChunkIndex(metadata)
    const chunks = metadata.groundingChunks ?? []
    chunks.forEach((groundingChunk, index) => {
      const url = groundingChunk.web?.uri
      if (!url) return
      const title =
        groundingChunk.web?.title || groundingChunk.web?.domain || url
      const snippet = snippets.get(index)
      const existing = into.get(url)
      if (!existing) {
        into.set(url, { title, url, snippet })
        return
      }
      into.set(url, {
        title: existing.title || title,
        url,
        snippet: existing.snippet ?? snippet,
      })
    })
  }
}

/** Fold a whole Gemini stream into SearchResult[] (test seam). */
export function extractGeminiSearchResults(
  chunks: Iterable<GeminiStreamChunk>,
): SearchResult[] {
  const collected = new Map<string, SearchResult>()
  for (const chunk of chunks) {
    collectGeminiGroundingChunk(chunk, collected)
  }
  return [...collected.values()]
}

/** Grounding never returns the publisher URL directly — always this wrapper. */
const GROUNDING_REDIRECT_HOST = 'vertexaisearch.cloud.google.com'
const REDIRECT_RESOLVE_TIMEOUT_MS = 4_000

export function isGroundingRedirectUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(GROUNDING_REDIRECT_HOST)
  } catch {
    return false
  }
}

/**
 * The page a redirect response points at, or undefined when it does not
 * resolve to one.
 *
 * Two sources, because both occur: a followed chain leaves the final address
 * on `response.url`, while a response the runtime handed back unfollowed
 * (or a 3xx a HEAD returned as-is) only carries `Location`.
 */
function resolvedTargetOf(
  response: Response,
  requestUrl: string,
): string | undefined {
  const candidates = [response.url, response.headers.get('location') ?? '']
  for (const candidate of candidates) {
    if (!candidate) continue
    let absolute: string
    try {
      absolute = new URL(candidate, requestUrl).toString()
    } catch {
      continue
    }
    if (!isGroundingRedirectUrl(absolute)) return absolute
  }
  return undefined
}

/**
 * Resolve `…/grounding-api-redirect/<blob>` wrappers to the page they point
 * at, with one HEAD request each.
 *
 * Not cosmetic: every wrapper URL is unique per response, so leaving them in
 * defeats the aggregator's URL dedup (the same article found by two sources
 * would appear twice) and hands the model a link that tells it nothing about
 * the publisher. A wrapper that will not resolve is kept as-is — a working
 * redirect link beats dropping the result.
 */
async function resolveGroundingRedirects(
  results: SearchResult[],
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<SearchResult[]> {
  return Promise.all(
    results.map(async result => {
      if (!isGroundingRedirectUrl(result.url)) return result
      const timeout = AbortSignal.timeout(REDIRECT_RESOLVE_TIMEOUT_MS)
      try {
        const response = await fetchImpl(result.url, {
          method: 'HEAD',
          redirect: 'follow',
          signal: AbortSignal.any([signal, timeout]),
        })
        const resolved = resolvedTargetOf(response, result.url)
        return resolved ? { ...result, url: resolved } : result
      } catch {
        return result
      }
    }),
  )
}

export interface GeminiSearchAdapterOptions {
  /**
   * Run as an EXTRA source rather than as the main loop's own search: route
   * through Antigravity whenever a Google login exists, even though the
   * session may be talking to a different provider entirely. Without a login
   * the request falls back to the public endpoint + GEMINI_API_KEY, and with
   * neither it fails fast — silently, one level up.
   */
  asExtraSource?: boolean
  /** Test seam: drive the stream (and redirect resolution) without a network. */
  fetchOverride?: typeof fetch
}

export class GeminiSearchAdapter implements WebSearchAdapter {
  private readonly asExtraSource: boolean
  private readonly fetchOverride?: typeof fetch

  constructor(options: GeminiSearchAdapterOptions = {}) {
    this.asExtraSource = options.asExtraSource ?? false
    this.fetchOverride = options.fetchOverride
  }

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { signal, onProgress, allowedDomains, blockedDomains } = options

    if (signal?.aborted) {
      throw new AbortError()
    }

    onProgress?.({ type: 'query_update', query })

    const abortController = new AbortController()
    if (signal) {
      signal.addEventListener('abort', () => abortController.abort(), {
        once: true,
      })
    }

    const body: GeminiGenerateContentRequest = {
      contents: [
        {
          role: 'user',
          parts: [{ text: `Perform a web search for the query: ${query}` }],
        },
      ],
      systemInstruction: { parts: [{ text: SEARCH_SYSTEM_PROMPT }] },
      tools: [GOOGLE_SEARCH_TOOL],
    }

    const collected = new Map<string, SearchResult>()
    const seenQueries = new Set<string>()

    const useAntigravity = usesAntigravityRoute({
      useAntigravityWhenAvailable: this.asExtraSource,
    })
    const stream = streamGeminiGenerateContent({
      model: resolveGeminiSearchModel(useAntigravity),
      body,
      signal: abortController.signal,
      fetchOverride: this.fetchOverride,
      requestType: 'web_search',
      useAntigravityWhenAvailable: this.asExtraSource,
    })

    for await (const chunk of stream) {
      if (abortController.signal.aborted) {
        throw new AbortError()
      }
      collectGeminiGroundingChunk(chunk, collected, searchQuery => {
        if (seenQueries.has(searchQuery)) return
        seenQueries.add(searchQuery)
        onProgress?.({ type: 'query_update', query: searchQuery })
      })
    }

    if (abortController.signal.aborted) {
      throw new AbortError()
    }

    // Resolve the redirect wrappers BEFORE filtering: the allow/block lists
    // (and the aggregator's dedup) are about the publisher's host, which the
    // wrapper URL hides.
    const resolved = await resolveGroundingRedirects(
      [...collected.values()],
      abortController.signal,
      this.fetchOverride ?? fetch,
    )

    // Grounding has no domain filter of its own, so the allow/block lists are
    // enforced here.
    const results = filterResultsByDomains(
      resolved,
      allowedDomains,
      blockedDomains,
    )

    onProgress?.({
      type: 'search_results_received',
      resultCount: results.length,
      query,
    })

    return results
  }
}
