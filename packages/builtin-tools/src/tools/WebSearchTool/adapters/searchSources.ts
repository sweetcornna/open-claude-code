/**
 * The WebSearch source registry.
 *
 * Four symmetric sources — three provider search layers plus the keyless one:
 *
 *   anthropic  server-side web_search (Claude OAuth / ANTHROPIC_API_KEY)
 *   gemini     googleSearch grounding (Google OAuth / GEMINI_API_KEY)
 *   codex      Responses API web_search (ChatGPT OAuth / OPENAI_API_KEY)
 *   free       keyless multi-engine scraping, always available
 *
 * A source is ON when credentials for it exist, unless the user explicitly
 * switched it off. Settings therefore store *deviations only*
 * (`webSearchSources.<id>`), never the derived state: logging in to a
 * provider folds its search layer into the results with no configuration at
 * all, and a source nobody touched keeps following its credentials.
 *
 * Availability is a second, session-scoped axis: a backend that answers "I do
 * not support the web_search tool" is retired for the rest of the process,
 * drops out of the aggregation, and is greyed out in /search-setting. Never
 * persisted — an account upgrade must not require editing a config file.
 */

import { hasSearchCredentials } from '@open-claude-code/tool-runtime/searchCredentials.js'
import { getMainLoopModel } from 'src/utils/model/model.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import type { SearchOptions, SearchResult, WebSearchAdapter } from './types.js'

export type SearchSourceId = 'anthropic' | 'gemini' | 'codex' | 'free'

/** Panel order, and the merge order for enhancer lanes. */
export const SEARCH_SOURCE_IDS: readonly SearchSourceId[] = [
  'anthropic',
  'gemini',
  'codex',
  'free',
]

export const SEARCH_SOURCE_LABELS: Record<SearchSourceId, string> = {
  anthropic: 'Anthropic (server-side web_search)',
  gemini: 'Gemini (Google OAuth)',
  codex: 'Codex (ChatGPT OAuth)',
  free: 'Free search',
}

type SourceOverrides = Partial<Record<SearchSourceId, boolean>>

export function readSourceOverrides(): SourceOverrides {
  const settings = getSettings_DEPRECATED() as Record<string, unknown> & {
    webSearchSources?: SourceOverrides
  }
  const raw = settings.webSearchSources
  return raw && typeof raw === 'object' ? raw : {}
}

/** `free` needs nothing; every provider source needs that provider's login. */
export function hasSourceCredentials(id: SearchSourceId): boolean {
  return id === 'free' ? true : hasSearchCredentials(id)
}

/**
 * Switched on = we hold usable credentials, unless the user explicitly said
 * otherwise.
 *
 * The override is one-directional on purpose: an explicit "off" always wins,
 * an explicit "on" cannot manufacture a capability the account does not have.
 * Ticking a source only records that you want it *when it works*; it is not a
 * request to fire a lane at a backend that cannot serve the search.
 *
 * That asymmetry exists because the symmetric version had a real failure mode.
 * A user on an OpenAI-compatible endpoint (DeepSeek et al) saw `codex` reported
 * as connected — the panel counted any `OPENAI_API_KEY` — ticked it, and got it
 * promoted to the session's PRIMARY search lane. The endpoint accepted the
 * request and even ran a search, but reported results in neither of the two
 * shapes occ reads, so every query came back empty with no error anywhere. A
 * forced-on source that can only return nothing is worse than an absent one:
 * the model reads the empty list as "the web has no answer".
 *
 * The remedy is to acquire the capability, not to insist on the flag — log in
 * with the provider's OAuth, or point the endpoint at one that serves the
 * search. `/search-setting` says so when a tick is refused.
 */
export function isSourceEnabled(id: SearchSourceId): boolean {
  if (readSourceOverrides()[id] === false) return false
  return hasSourceCredentials(id)
}

const unavailableSources = new Set<SearchSourceId>()

export function isSourceAvailable(id: SearchSourceId): boolean {
  return !unavailableSources.has(id)
}

export function markSourceUnavailable(id: SearchSourceId): void {
  unavailableSources.add(id)
}

/** Test seam / re-probe after a fresh login. */
export function resetSourceAvailability(): void {
  unavailableSources.clear()
}

/** A source takes part when it is switched on AND still believed available. */
export function isSourceActive(id: SearchSourceId): boolean {
  return isSourceEnabled(id) && isSourceAvailable(id)
}

/**
 * Whether the active provider can execute Anthropic's server-side
 * `web_search_20250305` tool through the normal query pipeline.
 *
 * Mirrors the provider gate official Claude Code puts on the WebSearch tool
 * itself (firstParty always; Vertex only for Claude 4.x models; Foundry ships
 * only web-search-capable models). occ keeps the tool always enabled and uses
 * the same signal one level down instead — to pick the primary lane.
 */
function supportsAnthropicServerSearch(): boolean {
  const provider = getAPIProvider()
  if (provider === 'firstParty' || provider === 'foundry') return true
  if (provider === 'vertex') {
    const model = getMainLoopModel()
    return (
      model.includes('claude-opus-4') ||
      model.includes('claude-sonnet-4') ||
      model.includes('claude-haiku-4')
    )
  }
  return false
}

/**
 * Which source the current main-loop provider IS, or undefined for providers
 * with no server-side search of their own (grok, bedrock, …). That source
 * leads the aggregation and is never also run as an extra lane.
 */
export function primarySourceId(): SearchSourceId | undefined {
  const provider = getAPIProvider()
  if (provider === 'openai') return 'codex'
  if (provider === 'gemini') return 'gemini'
  return supportsAnthropicServerSearch() ? 'anthropic' : undefined
}

/**
 * Errors meaning "this backend cannot run a server-side web search for this
 * account", as opposed to a transient network or rate-limit failure. Only
 * these retire a source for the session.
 */
const UNSUPPORTED_PATTERNS = [
  /unsupported (?:tool|parameter)/i,
  /tool .*web_search.* (?:is )?not (?:supported|allowed|available)/i,
  /web_search.*not (?:supported|enabled|available)/i,
  /does not (?:support|have access to).*web[_ ]search/i,
  /(?:401|403)\b.*web[_ ]search/i,
]

export function isUnsupportedSourceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return UNSUPPORTED_PATTERNS.some(pattern => pattern.test(message))
}

/**
 * An adapter tagged with the source it serves: a capability failure retires
 * that source for the session. The error is re-thrown unchanged — the
 * aggregator is what decides a failing lane is silent.
 *
 * `sourceId`/`inner` are public so callers (and tests) can see what a lane
 * actually is without unwrapping a closure.
 */
export class SourceHealthAdapter implements WebSearchAdapter {
  constructor(
    readonly sourceId: SearchSourceId,
    readonly inner: WebSearchAdapter,
  ) {}

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    try {
      return await this.inner.search(query, options)
    } catch (error) {
      if (isUnsupportedSourceError(error)) markSourceUnavailable(this.sourceId)
      throw error
    }
  }
}

export function withSourceHealth(
  id: SearchSourceId,
  adapter: WebSearchAdapter,
): SourceHealthAdapter {
  return new SourceHealthAdapter(id, adapter)
}
