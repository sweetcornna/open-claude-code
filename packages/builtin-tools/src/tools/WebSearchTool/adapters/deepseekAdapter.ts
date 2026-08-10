/**
 * DeepSeek search adapter — DeepSeek's own server-side web search, reached over
 * its Anthropic-compatible Messages endpoint (`<base>/anthropic/v1/messages`).
 *
 * Why this exists as a source of its own rather than riding the `anthropic` one:
 * a DeepSeek session reports `getAPIProvider() === 'firstParty'`, which answers
 * "which protocol" and never "whose models" (CLAUDE.md). Folded into the
 * `anthropic` source it would show up in /search-setting as a connected
 * *Anthropic* row that is really DeepSeek, and the aggregation would fire the
 * same endpoint twice under two names. It is also strictly wider: this lane is
 * reachable whatever the main loop speaks, so a session pinned to
 * `OPENAI_WIRE_API=chat` — the protocol with no built-in search at all — gets a
 * real server-side search instead of keyless SERP scraping.
 *
 * Deliberately plain `fetch` rather than the Anthropic SDK client: the client is
 * built from ANTHROPIC_* env, which points at DeepSeek only while the main-loop
 * routing happens to be active. This lane resolves its own endpoint
 * (getDeepSeekSearchEndpoint) so it works on every wire, and the same request
 * builder then serves the availability probe below.
 */

import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { retryAPIRequest } from '@open-claude-code/tool-runtime/apiRetry.js'
import { AbortError } from '@open-claude-code/tool-runtime/errors.js'
import { getDeepSeekSearchEndpoint } from 'src/utils/model/deepseekWire.js'
import { getSmallFastModel } from 'src/utils/model/model.js'
import { extractSearchResults } from './apiAdapter.js'
import { filterResultsByDomains } from './domainFilter.js'
import {
  isUnsupportedSourceError,
  markSourceUnavailable,
} from './searchSources.js'
import type { SearchOptions, SearchResult, WebSearchAdapter } from './types.js'

/** The Anthropic server-side search tool DeepSeek implements. */
const WEB_SEARCH_TOOL_TYPE = 'web_search_20250305'

/** Wire version header the endpoint validates against. */
const ANTHROPIC_VERSION = '2023-06-01'

/** Room for the tool calls plus a short wrap-up; only the results are read. */
const SEARCH_MAX_TOKENS = 4096

/** Enough for the endpoint to validate the request without composing an answer. */
const PROBE_MAX_TOKENS = 16

/** Direct search calls stay inside WebSearch's outer wall-clock budget. */
const SEARCH_MAX_RETRIES = 2

/** Server messages are echoed to the user, so keep them short. */
const MAX_DETAIL_CHARS = 300

type ToolSchema = {
  type: typeof WEB_SEARCH_TOOL_TYPE
  name: 'web_search'
  max_uses: number
  allowed_domains?: string[]
  blocked_domains?: string[]
}

function makeToolSchema(input: {
  allowedDomains?: string[]
  blockedDomains?: string[]
}): ToolSchema {
  return {
    type: WEB_SEARCH_TOOL_TYPE,
    name: 'web_search',
    max_uses: 8,
    ...(input.allowedDomains ? { allowed_domains: input.allowedDomains } : {}),
    ...(input.blockedDomains ? { blocked_domains: input.blockedDomains } : {}),
  }
}

/**
 * Model for the search turn.
 *
 * The tier env keys come first because they name a DeepSeek checkpoint
 * outright. `getSmallFastModel()` is the fallback and returns a `claude-*` id
 * when the ANTHROPIC_* mirror is not applied (any wire but the Anthropic one) —
 * harmless, because this endpoint maps `claude-haiku*`/`claude-sonnet*` to
 * v4-flash and `claude-opus*` to v4-pro server-side, but relying on that
 * mapping when the user has told us their own id would be gratuitous.
 */
export function resolveDeepSeekSearchModel(): string {
  return (
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim() ||
    process.env.OPENAI_DEFAULT_HAIKU_MODEL?.trim() ||
    getSmallFastModel()
  )
}

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_DETAIL_CHARS
    ? `${collapsed.slice(0, MAX_DETAIL_CHARS)}…`
    : collapsed
}

async function postMessages(input: {
  body: Record<string, unknown>
  signal?: AbortSignal
  fetchImpl: typeof fetch
}): Promise<Response> {
  const endpoint = getDeepSeekSearchEndpoint()
  if (!endpoint) {
    throw new Error('DeepSeek search is not configured')
  }
  // `endpoint.messagesURL` is already the finished URL: this package is a leaf
  // and does not get to reach into the host's URL helpers, and concatenating
  // one here would put the path inside the query on a base that carries one.
  return input.fetchImpl(endpoint.messagesURL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // What the Anthropic SDK sends for an api-key credential, and therefore
      // the header this endpoint is already known to accept from the main loop.
      'x-api-key': endpoint.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(input.body),
    ...(input.signal ? { signal: input.signal } : {}),
  })
}

/**
 * What an automatic availability check concluded about this endpoint.
 *
 * `unreachable` is kept apart from `unsupported` on purpose: a 401, a 429 or a
 * dropped socket says nothing about whether the deployment serves web_search,
 * and retiring the source on one would take the lane away for the rest of the
 * session over a transient failure.
 */
type DeepSeekSearchProbe =
  | { status: 'supported' }
  | { status: 'unsupported'; detail: string }
  | { status: 'unconfigured' }
  | { status: 'unreachable'; detail: string }

/**
 * A 4xx that means "this deployment does not serve the search tool", as opposed
 * to one about credentials or rate limits.
 */
function classifyFailure(status: number, body: string): DeepSeekSearchProbe {
  const detail = truncate(body) || `HTTP ${status}`
  if (isUnsupportedSourceError(new Error(`${status} ${body}`))) {
    return { status: 'unsupported', detail }
  }
  // 400/404/422 from an endpoint that was handed a valid Messages request:
  // whatever it objected to (unknown tool type, no /anthropic route, a model it
  // will not run the tool on), the search cannot be served as configured.
  if (status === 400 || status === 404 || status === 422) {
    return { status: 'unsupported', detail }
  }
  return { status: 'unreachable', detail }
}

class DeepSeekSearchRequestError extends Error {
  constructor(
    readonly status: number,
    readonly verdict: DeepSeekSearchProbe,
  ) {
    super(
      verdict.status === 'unsupported'
        ? `DeepSeek does not support web_search (${status}): ${verdict.detail}`
        : `DeepSeek web search failed (${status}): ${
            'detail' in verdict ? verdict.detail : `HTTP ${status}`
          }`,
    )
    this.name = 'DeepSeekSearchRequestError'
  }
}

async function requestMessages(input: {
  body: Record<string, unknown>
  signal: AbortSignal
  fetchImpl: typeof fetch
}): Promise<Response> {
  const response = await postMessages(input)
  if (response.ok) return response

  const body = await response.text().catch(() => '')
  throw new DeepSeekSearchRequestError(
    response.status,
    classifyFailure(response.status, body),
  )
}

let cachedProbe: { key: string; verdict: DeepSeekSearchProbe } | undefined

/** Test seam / re-check after the endpoint configuration changed. */
export function resetDeepSeekSearchProbe(): void {
  cachedProbe = undefined
}

/**
 * Ask the configured DeepSeek endpoint whether it serves `web_search_20250305`,
 * and retire the source for the session when it says no.
 *
 * This is the automatic half of the source: `hasDeepSeekSearchCredentials()` can
 * only see that a DeepSeek endpoint and key are configured, which is not the
 * same as that deployment implementing the search tool — a self-hosted mirror or
 * an older gateway will happily take the key and reject the tool. Ticking a box
 * for a lane that can only come back empty is the failure mode this whole
 * registry is built to avoid (see isSourceEnabled), so the capability is
 * measured rather than assumed.
 *
 * One small non-streaming request with `max_tokens` low enough that no answer is
 * composed: the question is whether the endpoint ACCEPTS the tool, and running a
 * real search to find out would cost the user a search's worth of tokens and
 * seconds every time the panel opens.
 *
 * `supported`/`unsupported` are cached per endpoint for the process;
 * `unreachable` never is, so a probe during a network blip does not stick.
 */
export async function probeDeepSeekSearchSupport(
  options: {
    signal?: AbortSignal
    fetchOverride?: typeof fetch
    force?: boolean
  } = {},
): Promise<DeepSeekSearchProbe> {
  const endpoint = getDeepSeekSearchEndpoint()
  if (!endpoint) return { status: 'unconfigured' }

  const key = endpoint.baseURL
  if (!options.force && cachedProbe?.key === key) {
    // Re-apply rather than return bare: resetSourceAvailability() (called after
    // a login, so a source retired earlier in the session can come back) clears
    // the availability set, and a cached "unsupported" has to survive that or
    // the row would silently un-grey without anything having been re-checked.
    if (cachedProbe.verdict.status === 'unsupported') {
      markSourceUnavailable('deepseek')
    }
    return cachedProbe.verdict
  }

  const requestSignal = options.signal ?? new AbortController().signal
  let verdict: DeepSeekSearchProbe
  try {
    await retryAPIRequest(
      () =>
        requestMessages({
          body: {
            model: resolveDeepSeekSearchModel(),
            max_tokens: PROBE_MAX_TOKENS,
            messages: [{ role: 'user', content: 'ping' }],
            tools: [makeToolSchema({})],
          },
          signal: requestSignal,
          fetchImpl: options.fetchOverride ?? fetch,
        }),
      { signal: requestSignal, maxRetries: SEARCH_MAX_RETRIES },
    )
    verdict = { status: 'supported' }
  } catch (error) {
    if (options.signal?.aborted) throw new AbortError()
    verdict =
      error instanceof DeepSeekSearchRequestError
        ? error.verdict
        : {
            status: 'unreachable',
            detail: truncate(
              error instanceof Error ? error.message : String(error),
            ),
          }
  }

  if (verdict.status === 'unsupported') markSourceUnavailable('deepseek')
  if (verdict.status === 'supported' || verdict.status === 'unsupported') {
    cachedProbe = { key, verdict }
  }
  return verdict
}

interface DeepSeekSearchAdapterOptions {
  /** Test seam: drive the request without a network. */
  fetchOverride?: typeof fetch
}

/**
 * DeepSeek web search as a standalone lane, independent of the main loop.
 *
 * One non-streaming Messages call declaring the server tool; only the
 * `web_search_tool_result` blocks are read, which is why nothing here cares what
 * prose came back.
 */
export class DeepSeekDirectSearchAdapter implements WebSearchAdapter {
  private readonly fetchOverride?: typeof fetch

  constructor(options: DeepSeekSearchAdapterOptions = {}) {
    if (options.fetchOverride) this.fetchOverride = options.fetchOverride
  }

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { signal, onProgress, allowedDomains, blockedDomains } = options

    if (signal?.aborted) throw new AbortError()
    onProgress?.({ type: 'query_update', query })

    const requestSignal = signal ?? new AbortController().signal
    const response = await retryAPIRequest(
      () =>
        requestMessages({
          body: {
            model: resolveDeepSeekSearchModel(),
            max_tokens: SEARCH_MAX_TOKENS,
            messages: [
              {
                role: 'user',
                content: `Perform a web search for the query: ${query}`,
              },
            ],
            tools: [makeToolSchema({ allowedDomains, blockedDomains })],
          },
          signal: requestSignal,
          fetchImpl: this.fetchOverride ?? fetch,
        }),
      { signal: requestSignal, maxRetries: SEARCH_MAX_RETRIES },
    )

    if (signal?.aborted) throw new AbortError()

    const message = (await response.json()) as { content?: BetaContentBlock[] }
    const results = filterResultsByDomains(
      extractSearchResults(message.content ?? []),
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
