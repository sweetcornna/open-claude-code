/**
 * Search adapter factory.
 *
 * Two modes:
 *
 * 1. EXPLICIT — `WEB_SEARCH_ADAPTER` env (highest) or `settings.webSearchAdapter`
 *    names exactly one backend. The user picked a source; we run that source
 *    and nothing else, no aggregation. Unrecognised values (notably the
 *    removed `'tavily'`, which still sits in existing settings.json files)
 *    fall through to mode 2 SILENTLY — a stale value must degrade to working
 *    search, not to a startup complaint.
 *
 * 2. AGGREGATED (the default) — every active source runs in parallel and the
 *    results merge into one list. Sources are symmetric (see
 *    searchSources.ts): anthropic, gemini, codex, free, each switched on by
 *    its own credentials unless the user said otherwise.
 *
 *    The source matching the CURRENT provider is the primary lane: it runs
 *    through the normal query pipeline and its results are ordered first. The
 *    remaining active sources are enhancer lanes. Because the primary lane
 *    already covers its provider, that source is never also run as an
 *    enhancer — one credential family, one request.
 *
 *    Typical shape: main loop on OpenAI, an Anthropic login on disk, free on
 *    → codex (primary) ‖ anthropic ‖ free.
 *
 * See aggregateAdapter.ts for the merge and latency rules.
 */

import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import { AggregateSearchAdapter } from './aggregateAdapter.js'
import { AnthropicDirectSearchAdapter, ApiSearchAdapter } from './apiAdapter.js'
import { BingSearchAdapter } from './bingAdapter.js'
import { BraveSearchAdapter } from './braveAdapter.js'
import { CodexSearchAdapter } from './codexAdapter.js'
import { ExaSearchAdapter } from './exaAdapter.js'
import { FreeSearchAdapter } from './freeAdapter.js'
import { GeminiSearchAdapter } from './geminiAdapter.js'
import {
  isSourceActive,
  primarySourceId,
  SEARCH_SOURCE_IDS,
  withSourceHealth,
  type SearchSourceId,
} from './searchSources.js'
import type { WebSearchAdapter } from './types.js'

export type {
  SearchResult,
  SearchOptions,
  SearchProgress,
  WebSearchAdapter,
} from './types.js'

export type SearchAdapterKey =
  | 'api'
  | 'bing'
  | 'brave'
  | 'codex'
  | 'exa'
  | 'free'
  | 'gemini'

const ADAPTER_KEYS: readonly string[] = [
  'api',
  'bing',
  'brave',
  'codex',
  'exa',
  'free',
  'gemini',
]

function toAdapterKey(value: unknown): SearchAdapterKey | undefined {
  return typeof value === 'string' && ADAPTER_KEYS.includes(value)
    ? (value as SearchAdapterKey)
    : undefined
}

/**
 * Build one source's adapter.
 *
 * `asPrimary` distinguishes the two Anthropic execution paths: as the primary
 * lane the search rides the session's own query pipeline; as an extra source
 * it needs a standalone Anthropic call, because the pipeline would route it
 * to whatever provider the main loop is using.
 */
function createSourceAdapter(
  id: SearchSourceId,
  asPrimary: boolean,
): WebSearchAdapter {
  switch (id) {
    case 'anthropic':
      return asPrimary
        ? new ApiSearchAdapter()
        : new AnthropicDirectSearchAdapter()
    case 'gemini':
      return new GeminiSearchAdapter({ asExtraSource: !asPrimary })
    case 'codex':
      return asPrimary
        ? new CodexSearchAdapter()
        : new CodexSearchAdapter({ forceChatGPTAuth: true })
    case 'free':
      return new FreeSearchAdapter()
  }
}

/**
 * Build the adapter the user named outright.
 *
 * The provider sources take the SAME primary/extra distinction as mode 2 —
 * naming a source does not make it the session's provider. Constructing them
 * bare here was a real break: `WEB_SEARCH_ADAPTER=gemini` on an OpenAI session
 * built a Gemini adapter that had never been told it was an extra source, so it
 * skipped the Antigravity route a Google login had made available and sent an
 * empty `x-goog-api-key` — 403 "unregistered callers", with credentials sitting
 * right there on disk.
 */
function createExplicitAdapter(key: SearchAdapterKey): WebSearchAdapter {
  const primaryId = primarySourceId()
  switch (key) {
    case 'api':
      return primaryId === 'anthropic'
        ? new ApiSearchAdapter()
        : new AnthropicDirectSearchAdapter()
    case 'bing':
      return new BingSearchAdapter()
    case 'brave':
      return new BraveSearchAdapter()
    case 'codex':
      return new CodexSearchAdapter(
        primaryId === 'codex' ? {} : { forceChatGPTAuth: true },
      )
    case 'exa':
      return new ExaSearchAdapter()
    case 'gemini':
      return new GeminiSearchAdapter({ asExtraSource: primaryId !== 'gemini' })
    case 'free':
      return new FreeSearchAdapter()
  }
}

/** Active sources, minus the one the primary lane already covers. */
export function enhancerSourceIds(
  primaryId: SearchSourceId | undefined,
): SearchSourceId[] {
  return SEARCH_SOURCE_IDS.filter(id => id !== primaryId && isSourceActive(id))
}

/**
 * Cache key for the assembled adapter: selection depends on the explicit
 * override, the provider, and which sources are currently active.
 */
function selectionKey(
  explicit: SearchAdapterKey | undefined,
  primaryId: SearchSourceId | undefined,
  enhancerIds: SearchSourceId[],
): string {
  if (explicit) return `explicit:${explicit}`
  return `aggregate:${primaryId ?? 'none'}:${enhancerIds.join(',')}`
}

let cachedAdapter: WebSearchAdapter | null = null
let cachedSelectionKey: string | null = null

export function createAdapter(): WebSearchAdapter {
  const explicit =
    toAdapterKey(process.env.WEB_SEARCH_ADAPTER) ??
    toAdapterKey(getSettings_DEPRECATED().webSearchAdapter)

  if (explicit) {
    const key = selectionKey(explicit, undefined, [])
    if (cachedAdapter && cachedSelectionKey === key) return cachedAdapter
    cachedAdapter = createExplicitAdapter(explicit)
    cachedSelectionKey = key
    return cachedAdapter
  }

  // The provider's own source only leads if it is switched on; a user who
  // turned Anthropic off while running on Anthropic gets the other sources.
  const providerSource = primarySourceId()
  const primaryId =
    providerSource && isSourceActive(providerSource)
      ? providerSource
      : undefined
  const enhancerIds = enhancerSourceIds(providerSource)

  const key = selectionKey(explicit, primaryId, enhancerIds)
  if (cachedAdapter && cachedSelectionKey === key) return cachedAdapter

  const enhancers = enhancerIds.map(id =>
    withSourceHealth(id, createSourceAdapter(id, false)),
  )

  if (!primaryId && enhancers.length === 1) {
    // Nothing to aggregate — one source, no combinator in the way.
    cachedAdapter = enhancers[0] as WebSearchAdapter
  } else {
    cachedAdapter = new AggregateSearchAdapter({
      primary: primaryId
        ? withSourceHealth(primaryId, createSourceAdapter(primaryId, true))
        : undefined,
      enhancers,
    })
  }

  cachedSelectionKey = key
  return cachedAdapter
}

/** Test seam — forget the memoized selection. */
export function resetAdapterCache(): void {
  cachedAdapter = null
  cachedSelectionKey = null
}
