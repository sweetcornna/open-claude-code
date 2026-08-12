/**
 * Codex/OpenAI search adapter — OpenAI's own server-side search layer.
 *
 * Calls the Responses API with the built-in `web_search` tool enabled and maps
 * the citations it returns into SearchResult[]. This is the openai-provider
 * equivalent of `apiAdapter` (Anthropic's server-side web_search): the search
 * itself runs on the provider's side, so results match what the model would
 * have grounded on natively.
 *
 * Wire protocol: ALWAYS `responses`. The Chat Completions line has no
 * server-side web search at all, so unlike the main loop (see
 * openai/wireProtocol.ts) there is nothing to negotiate here.
 *
 * Auth routes, both reused from src/services/api/openai/ and picked by
 * `shouldUseChatGPTAuth` (which also covers the third-party-endpoint case):
 *   - ChatGPT subscription (`OPENAI_AUTH_MODE=chatgpt`) → the Codex backend
 *     via createChatGPTResponsesStream. That backend REJECTS
 *     `max_output_tokens`, so this adapter simply does not pass the field to
 *     buildResponsesRequest on that route — the existing request builder owns
 *     the shape, we never hand-roll a body around it.
 *   - API key → createOpenAIResponsesStream against `<OPENAI_BASE_URL>/responses`.
 *
 * A credential pinned through /search-setting outranks both. It is the only
 * one that survives a `/logout` or a `/provider use` — those delete
 * OPENAI_API_KEY and OPENAI_BASE_URL — and it is handed to the request layer
 * explicitly (`credential`), key and endpoint together, so it cannot inherit a
 * base URL the account plane has since repointed at somebody else.
 *
 * The OAuth route has its own version of that: `authPlane: 'search'` lets it
 * fall back to web search's copy of the ChatGPT login (chatgptAuth.ts), which
 * `/logout` does not delete because it does not know about it. Without it this
 * source went dark on logout even though nothing about the account had
 * changed — the same silent degradation the key pin exists to prevent, one
 * credential type over.
 */

import { resolveOpenAIModel } from '@ant/model-provider'
import { AbortError } from '@open-claude-code/tool-runtime/errors.js'
import {
  hasStoredChatGPTAuthSync,
  isChatGPTAuthEnabled,
} from 'src/services/api/openai/chatgptAuth.js'
import { isOfficialOpenAIBaseURL } from 'src/services/api/openai/openaiShared.js'
import { resolveOpenAIMaxTokens } from 'src/services/api/openai/requestBody.js'
import {
  buildResponsesRequest,
  createChatGPTResponsesStream,
  createOpenAIResponsesStream,
} from 'src/services/api/openai/responsesAdapter.js'
import { resolvePinnedCodexSearchCredential } from 'src/services/search/searchEndpoints.js'
import {
  CHATGPT_CODEX_FAST_MODEL,
  isChatGPTCodexReasoningModel,
  isGptFamilyModel,
} from 'src/utils/model/chatgptModels.js'
import { getMainLoopModel } from 'src/utils/model/model.js'
import { filterResultsByDomains } from './domainFilter.js'
import type { SearchResult, SearchOptions, WebSearchAdapter } from './types.js'

const SEARCH_SYSTEM_PROMPT =
  'You are an assistant for performing a web search tool use'

/**
 * A search turn only has to emit citations, never a long answer, so the
 * default ceiling stays small. `resolveOpenAIMaxTokens` still lets
 * OPENAI_MAX_TOKENS / CLAUDE_CODE_MAX_OUTPUT_TOKENS override it.
 */
const WEB_SEARCH_MAX_OUTPUT_TOKENS = 4096

/** The Responses API built-in server-side search tool. */
const WEB_SEARCH_TOOL = { type: 'web_search' } as const

type Json = Record<string, unknown>

function asRecord(value: unknown): Json | undefined {
  return value && typeof value === 'object' ? (value as Json) : undefined
}

function addResult(into: Map<string, SearchResult>, hit: SearchResult): void {
  if (!hit.url) return
  const existing = into.get(hit.url)
  if (!existing) {
    into.set(hit.url, hit)
    return
  }
  // Keep the richer record: later events often carry the title the first
  // sighting lacked.
  into.set(hit.url, {
    title: existing.title || hit.title,
    url: hit.url,
    snippet: existing.snippet ?? hit.snippet,
  })
}

function collectFromAnnotation(
  annotation: unknown,
  into: Map<string, SearchResult>,
): void {
  const record = asRecord(annotation)
  if (!record || record.type !== 'url_citation') return
  const url = typeof record.url === 'string' ? record.url : undefined
  if (!url) return
  addResult(into, {
    title:
      typeof record.title === 'string' && record.title ? record.title : url,
    url,
  })
}

/**
 * Pull citations out of one output item. Two shapes carry them:
 *   - `message` items: `content[].annotations[]` with `type: 'url_citation'`.
 *   - `web_search_call` items: `action.sources[]` on API versions that report
 *     the raw hit list.
 */
function collectFromOutputItem(
  item: unknown,
  into: Map<string, SearchResult>,
): void {
  const record = asRecord(item)
  if (!record) return

  if (record.type === 'message' && Array.isArray(record.content)) {
    for (const part of record.content) {
      const partRecord = asRecord(part)
      if (!partRecord || !Array.isArray(partRecord.annotations)) continue
      for (const annotation of partRecord.annotations) {
        collectFromAnnotation(annotation, into)
      }
    }
    return
  }

  if (record.type === 'web_search_call') {
    const action = asRecord(record.action)
    if (!Array.isArray(action?.sources)) return
    for (const source of action.sources) {
      const sourceRecord = asRecord(source)
      const url = typeof sourceRecord?.url === 'string' ? sourceRecord.url : ''
      if (!url) continue
      addResult(into, {
        title:
          typeof sourceRecord?.title === 'string' && sourceRecord.title
            ? sourceRecord.title
            : url,
        url,
      })
    }
  }
}

/** The query the model actually searched for, when the event reports one. */
function searchCallQuery(item: unknown): string | undefined {
  const record = asRecord(item)
  if (record?.type !== 'web_search_call') return undefined
  const action = asRecord(record.action)
  return typeof action?.query === 'string' ? action.query : undefined
}

export function collectCodexSearchEvent(
  event: Json,
  into: Map<string, SearchResult>,
  onSearchQuery?: (query: string) => void,
): void {
  const type = typeof event.type === 'string' ? event.type : ''

  if (type === 'response.output_text.annotation.added') {
    collectFromAnnotation(event.annotation, into)
    return
  }

  if (
    type === 'response.output_item.added' ||
    type === 'response.output_item.done'
  ) {
    const query = searchCallQuery(event.item)
    if (query) onSearchQuery?.(query)
    collectFromOutputItem(event.item, into)
    return
  }

  if (type === 'response.completed' || type === 'response.incomplete') {
    const response = asRecord(event.response)
    if (!Array.isArray(response?.output)) return
    for (const item of response.output) {
      collectFromOutputItem(item, into)
    }
  }
}

/** Fold a whole Responses event stream into SearchResult[] (test seam). */
export function extractCodexSearchResults(
  events: Iterable<Json>,
): SearchResult[] {
  const collected = new Map<string, SearchResult>()
  for (const event of events) {
    collectCodexSearchEvent(event, collected)
  }
  return [...collected.values()]
}

/**
 * Which of the two auth routes this search takes.
 *
 * The API-key route sends the request to `<OPENAI_BASE_URL>/responses`, and
 * only OpenAI runs the built-in `web_search` tool there. So a stored ChatGPT
 * login also wins whenever the configured base URL is NOT OpenAI's, whether or
 * not this adapter is the extra source: that login is the reason the `codex`
 * source counts as connected at all (hasCodexSearchCredentials), and routing
 * the lane somewhere it cannot work makes that credential a lie.
 *
 * The bug this closes was silent, which is why it outlived the base-URL guard
 * added to the credential probe. Session on DeepSeek + a ChatGPT login on disk:
 * the login switched the source on, the source became the session's PRIMARY
 * search lane, and the lane was then built to follow OPENAI_BASE_URL to
 * api.deepseek.com. That endpoint implements the Responses API and genuinely
 * runs a search, but reports neither `url_citation` annotations nor
 * `action.sources`, so every query returned zero results and no error — while
 * the ChatGPT credential that could have served it sat unused.
 *
 * Official-endpoint users are unaffected: with an OpenAI base URL the extra
 * clause is false and the route is exactly what it was.
 *
 * `pinnedApiKey` stands the OAuth route down entirely, and is the same
 * statement `usesAntigravityRoute` reads an explicit key as: the caller has
 * chosen its credential, so routing the request to a backend that would
 * authenticate as somebody else's account is not "preferring a better login",
 * it is ignoring the pin.
 */
export function shouldUseChatGPTAuth(
  forceChatGPTAuth: boolean,
  pinnedApiKey?: string,
): boolean {
  if (pinnedApiKey) return false
  if (isChatGPTAuthEnabled()) return true
  if (!hasStoredChatGPTAuthSync()) return false
  return (
    forceChatGPTAuth || !isOfficialOpenAIBaseURL(process.env.OPENAI_BASE_URL)
  )
}

/**
 * Model for the search turn.
 *
 * The two backends do NOT serve the same catalogue, exactly as with Gemini's
 * two routes (see resolveGeminiSearchModel). The Codex backend serves its own
 * models only and rejects anything else outright — "The 'deepseek-v4-flash'
 * model is not supported when using Codex with a ChatGPT account", HTTP 400,
 * which the aggregator then silences into yet another empty lane. The
 * main-loop model is the right answer only on the API-key route, where the
 * endpoint is whatever OPENAI_BASE_URL points at.
 *
 * A search turn only has to call the tool and emit citations, so the cheap tier
 * is the sane default when the session's model is not one this backend knows.
 *
 * `pinned` is the third case, and it exists because a pin is precisely what
 * decouples this lane's endpoint from the session's. The plain API-key route
 * can forward the main-loop model because OPENAI_BASE_URL is where both the
 * model and the key come from; a pinned credential points at api.openai.com
 * while the session may be on DeepSeek, so forwarding `deepseek-v4-flash`
 * there earns a 400 the aggregator silences — the pinned key would then have
 * changed nothing at all. `isGptFamilyModel` keeps an explicitly configured
 * OpenAI model (including gpt-4o) and swaps out only ids OpenAI does not serve.
 */
export function resolveCodexSearchModel(
  useChatGPTAuth: boolean,
  pinned = false,
): string {
  const mapped = resolveOpenAIModel(getMainLoopModel())
  if (pinned)
    return isGptFamilyModel(mapped) ? mapped : CHATGPT_CODEX_FAST_MODEL
  if (!useChatGPTAuth) return mapped
  return isChatGPTCodexReasoningModel(mapped)
    ? mapped
    : CHATGPT_CODEX_FAST_MODEL
}

export interface CodexSearchAdapterOptions {
  /**
   * Prefer the ChatGPT/Codex OAuth route regardless of `OPENAI_AUTH_MODE`.
   * Set for the "Codex (ChatGPT OAuth)" extra source, where the account is
   * connected but the main loop may be talking to a different provider.
   *
   * Preference, not a hard switch: `hasCodexSearchCredentials()` counts an
   * OPENAI_API_KEY alone as "connected", so an unconditional force would leave
   * that user with a source the panel calls on and a lane that can only throw.
   * No ChatGPT login on disk → fall back to the API-key `/responses` route.
   *
   * Leaving it false no longer means "always take the API-key route" — see
   * `shouldUseChatGPTAuth`, which also prefers a stored login when the
   * configured base URL is not OpenAI's.
   */
  forceChatGPTAuth?: boolean
  /** Test seam: drive the stream without a network. */
  fetchOverride?: typeof fetch
}

export class CodexSearchAdapter implements WebSearchAdapter {
  private readonly forceChatGPTAuth: boolean
  private readonly fetchOverride?: typeof fetch

  constructor(options: CodexSearchAdapterOptions = {}) {
    this.forceChatGPTAuth = options.forceChatGPTAuth ?? false
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

    // The pin first: it is the credential this lane will actually send, so the
    // route and the model both have to be decided knowing about it.
    const pinned = resolvePinnedCodexSearchCredential()
    const useChatGPTAuth = shouldUseChatGPTAuth(
      this.forceChatGPTAuth,
      pinned?.apiKey,
    )
    const request = buildResponsesRequest({
      model: resolveCodexSearchModel(useChatGPTAuth, pinned !== undefined),
      messages: [
        { role: 'system', content: SEARCH_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Perform a web search for the query: ${query}`,
        },
      ],
      tools: [WEB_SEARCH_TOOL],
      toolChoice: undefined,
      // Omitted entirely on the ChatGPT/Codex route — that backend rejects it.
      ...(useChatGPTAuth
        ? {}
        : {
            maxOutputTokens: resolveOpenAIMaxTokens(
              WEB_SEARCH_MAX_OUTPUT_TOKENS,
            ),
          }),
    })

    // Search results are accumulated below and only handed over once the
    // stream ends, and onProgress fires from inside that loop — so a failed
    // attempt leaves no trace to duplicate. That makes a mid-stream text
    // failure replayable here, where in the main loop it is not.
    const stream = useChatGPTAuth
      ? await createChatGPTResponsesStream({
          request,
          signal: abortController.signal,
          fetchOverride: this.fetchOverride,
          discardsPartialOutput: true,
          // The search credential plane: occ's ChatGPT login while there is
          // one, and otherwise the copy of it this lane pinned for itself —
          // the only credential left after a `/logout`, which is precisely
          // when this source used to go dark.
          authPlane: 'search',
        })
      : await createOpenAIResponsesStream({
          request,
          signal: abortController.signal,
          fetchOverride: this.fetchOverride,
          discardsPartialOutput: true,
          // Key and endpoint as one unit, or neither. Handing over only the
          // key would let it inherit an OPENAI_BASE_URL the account plane has
          // repointed since the pin was made — i.e. post the user's OpenAI
          // secret to a third party.
          ...(pinned ? { credential: pinned } : {}),
        })

    const collected = new Map<string, SearchResult>()
    const seenQueries = new Set<string>()

    for await (const event of stream) {
      if (abortController.signal.aborted) {
        throw new AbortError()
      }
      collectCodexSearchEvent(event, collected, searchQuery => {
        if (seenQueries.has(searchQuery)) return
        seenQueries.add(searchQuery)
        onProgress?.({ type: 'query_update', query: searchQuery })
      })
    }

    if (abortController.signal.aborted) {
      throw new AbortError()
    }

    // The built-in tool has no reliable cross-version domain filter, so the
    // allow/block lists are enforced here.
    const results = filterResultsByDomains(
      [...collected.values()],
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
