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
 * Auth routes, both reused from src/services/api/openai/:
 *   - ChatGPT subscription (`OPENAI_AUTH_MODE=chatgpt`) → the Codex backend
 *     via createChatGPTResponsesStream. That backend REJECTS
 *     `max_output_tokens`, so this adapter simply does not pass the field to
 *     buildResponsesRequest on that route — the existing request builder owns
 *     the shape, we never hand-roll a body around it.
 *   - API key → createOpenAIResponsesStream against `<OPENAI_BASE_URL>/responses`.
 */

import { resolveOpenAIModel } from '@ant/model-provider'
import { AbortError } from '@open-claude-code/tool-runtime/errors.js'
import { isChatGPTAuthEnabled } from 'src/services/api/openai/chatgptAuth.js'
import { resolveOpenAIMaxTokens } from 'src/services/api/openai/requestBody.js'
import {
  buildResponsesRequest,
  createChatGPTResponsesStream,
  createOpenAIResponsesStream,
} from 'src/services/api/openai/responsesAdapter.js'
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

export interface CodexSearchAdapterOptions {
  /**
   * Force the ChatGPT/Codex OAuth route regardless of `OPENAI_AUTH_MODE`.
   * Set for the "Codex (ChatGPT OAuth)" extra source, where the account is
   * connected but the main loop may be talking to a different provider.
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

    const useChatGPTAuth = this.forceChatGPTAuth || isChatGPTAuthEnabled()
    const request = buildResponsesRequest({
      model: resolveOpenAIModel(getMainLoopModel()),
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

    const stream = useChatGPTAuth
      ? await createChatGPTResponsesStream({
          request,
          signal: abortController.signal,
          fetchOverride: this.fetchOverride,
        })
      : await createOpenAIResponsesStream({
          request,
          signal: abortController.signal,
          fetchOverride: this.fetchOverride,
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
