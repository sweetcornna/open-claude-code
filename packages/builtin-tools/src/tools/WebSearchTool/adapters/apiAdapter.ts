/**
 * API-based search adapter — delegates to Anthropic's server-side
 * web_search_20250305 tool.
 *
 * Two entry points, same server tool:
 *   - ApiSearchAdapter goes through the normal query pipeline
 *     (queryModelWithStreaming). Used when Anthropic IS the main-loop
 *     provider, so the search inherits the session's model, feature gates and
 *     tracing.
 *   - AnthropicDirectSearchAdapter issues one standalone Messages call
 *     through getAnthropicClient. Used when the user holds Anthropic
 *     credentials but the main loop talks to somebody else: the pipeline
 *     would route the request to that other provider, which has no
 *     server_tool_use at all.
 */

import type {
  BetaContentBlock,
  BetaMessageParam,
  BetaWebSearchTool20250305,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { getAnthropicClient } from 'src/services/api/client.js'
import { AbortError } from '@open-claude-code/tool-runtime/errors.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '@open-claude-code/tool-runtime/featureGate.js'
import { queryModelWithStreaming } from 'src/services/api/claude.js'
import {
  createTrace,
  endTrace,
  isLangfuseEnabled,
} from 'src/services/langfuse/index.js'
import { getSessionId } from '@open-claude-code/tool-runtime/bootstrapState.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { createUserMessage } from 'src/utils/messages.js'
import { getMainLoopModel, getSmallFastModel } from 'src/utils/model/model.js'
import { jsonParse } from '@open-claude-code/tool-runtime/slowOperations.js'
import { asSystemPrompt } from 'src/utils/session/systemPromptType.js'
import type { SearchResult, SearchOptions, WebSearchAdapter } from './types.js'

/**
 * Enough room for the tool calls plus a short wrap-up. The prose is discarded
 * — only the web_search_tool_result blocks are read.
 */
const DIRECT_SEARCH_MAX_TOKENS = 4096

function makeToolSchema(input: {
  allowedDomains?: string[]
  blockedDomains?: string[]
}): BetaWebSearchTool20250305 {
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    allowed_domains: input.allowedDomains,
    blocked_domains: input.blockedDomains,
    max_uses: 8,
  }
}

export class ApiSearchAdapter implements WebSearchAdapter {
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { signal, onProgress, allowedDomains, blockedDomains } = options

    const userMessage = createUserMessage({
      content: 'Perform a web search for the query: ' + query,
    })
    const toolSchema = makeToolSchema({ allowedDomains, blockedDomains })

    const useHaiku = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_plum_vx3',
      false,
    )
    const model = useHaiku ? getSmallFastModel() : getMainLoopModel()
    const langfuseTrace = isLangfuseEnabled()
      ? createTrace({
          sessionId: getSessionId(),
          model,
          provider: getAPIProvider(),
          name: 'web-search-tool',
        })
      : null

    const queryStream = queryModelWithStreaming({
      messages: [userMessage],
      systemPrompt: asSystemPrompt([
        'You are an assistant for performing a web search tool use',
      ]),
      thinkingConfig: useHaiku
        ? { type: 'disabled' as const }
        : { type: 'enabled' as const, budgetTokens: 10000 },
      tools: [],
      signal: signal ?? new AbortController().signal,
      options: {
        getToolPermissionContext: async () => ({
          mode: 'default' as const,
          additionalWorkingDirectories: new Map(),
          alwaysAllowRules: {},
          alwaysDenyRules: {},
          alwaysAskRules: {},
          isBypassPermissionsModeAvailable: false,
        }),
        model,
        toolChoice: useHaiku
          ? { type: 'tool' as const, name: 'web_search' }
          : undefined,
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        extraToolSchemas: [toolSchema],
        querySource: 'web_search_tool' as const,
        agents: [],
        mcpTools: [],
        agentId: undefined,
        effortValue: undefined,
        langfuseTrace,
      },
    })

    const allContentBlocks: BetaContentBlock[] = []
    let currentToolUseId: string | null = null
    let currentToolUseJson = ''
    const toolUseQueries = new Map<string, string>()
    let progressCounter = 0

    for await (const event of queryStream) {
      if (event.type === 'assistant') {
        const msg = event as { message: { content: BetaContentBlock[] } }
        allContentBlocks.push(...msg.message.content)
        continue
      }

      if (event.type === 'stream_event') {
        const streamEvt = event as {
          event?: {
            type: string
            content_block?: {
              type: string
              id?: string
              tool_use_id?: string
              content?: unknown
              [key: string]: unknown
            }
            delta?: {
              type: string
              partial_json?: string
              [key: string]: unknown
            }
            [key: string]: unknown
          }
        }

        if (streamEvt.event?.type === 'content_block_start') {
          const contentBlock = streamEvt.event.content_block
          if (contentBlock && contentBlock.type === 'server_tool_use') {
            currentToolUseId = contentBlock.id as string
            currentToolUseJson = ''
            continue
          }
        }

        if (
          currentToolUseId &&
          streamEvt.event?.type === 'content_block_delta'
        ) {
          const delta = streamEvt.event.delta
          if (delta?.type === 'input_json_delta' && delta.partial_json) {
            currentToolUseJson += delta.partial_json
            try {
              const queryMatch = currentToolUseJson.match(
                /"query"\s*:\s*"((?:[^"\\]|\\.)*)"/,
              )
              if (queryMatch && queryMatch[1]) {
                const parsedQuery = jsonParse('"' + queryMatch[1] + '"')
                if (
                  !toolUseQueries.has(currentToolUseId) ||
                  toolUseQueries.get(currentToolUseId) !== parsedQuery
                ) {
                  toolUseQueries.set(currentToolUseId, parsedQuery)
                  progressCounter++
                  onProgress?.({
                    type: 'query_update',
                    query: parsedQuery,
                  })
                }
              }
            } catch {
              // Ignore parsing errors for partial JSON
            }
          }
        }

        if (streamEvt.event?.type === 'content_block_start') {
          const contentBlock = streamEvt.event.content_block
          if (contentBlock && contentBlock.type === 'web_search_tool_result') {
            const toolUseId = contentBlock.tool_use_id as string
            const actualQuery = toolUseQueries.get(toolUseId) || query
            const content = contentBlock.content
            progressCounter++
            onProgress?.({
              type: 'search_results_received',
              resultCount: Array.isArray(content) ? content.length : 0,
              query: actualQuery,
            })
          }
        }
      }
    }

    endTrace(langfuseTrace)

    // Extract SearchResult[] from content blocks
    return extractSearchResults(allContentBlocks)
  }
}

/**
 * Anthropic web search as a STANDALONE source, independent of the main loop.
 *
 * One non-streaming Messages call on a haiku-class model: the model only has
 * to invoke the server tool, and nothing downstream reads its prose. Auth,
 * base URL and headers come from getAnthropicClient, i.e. the same OAuth /
 * ANTHROPIC_API_KEY channel the rest of the CLI uses.
 */
export class AnthropicDirectSearchAdapter implements WebSearchAdapter {
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { signal, onProgress, allowedDomains, blockedDomains } = options

    if (signal?.aborted) {
      throw new AbortError()
    }

    onProgress?.({ type: 'query_update', query })

    const model = getSmallFastModel()
    const client = await getAnthropicClient({
      maxRetries: 1,
      model,
      source: 'web_search_source',
    })

    const messages: BetaMessageParam[] = [
      {
        role: 'user',
        content: `Perform a web search for the query: ${query}`,
      },
    ]

    const message = await client.beta.messages.create(
      {
        model,
        max_tokens: DIRECT_SEARCH_MAX_TOKENS,
        messages,
        tools: [makeToolSchema({ allowedDomains, blockedDomains })],
      },
      { signal },
    )

    if (signal?.aborted) {
      throw new AbortError()
    }

    const results = extractSearchResults(message.content)

    onProgress?.({
      type: 'search_results_received',
      resultCount: results.length,
      query,
    })

    return results
  }
}

function extractSearchResults(blocks: BetaContentBlock[]): SearchResult[] {
  const results: SearchResult[] = []
  // A web_search_tool_result whose content is NOT an array is a
  // WebSearchToolResultError (`{ error_code }`) — official Claude Code
  // surfaces it as "Web search error: <code>" instead of dropping it. We keep
  // that behaviour: collect the codes and only raise if the whole call
  // produced no hits, so a partial failure across max_uses searches still
  // returns whatever did come back.
  const errorCodes: string[] = []

  for (const block of blocks) {
    if (block.type !== 'web_search_tool_result') continue

    if (!Array.isArray(block.content)) {
      const errorCode = (block.content as { error_code?: string } | undefined)
        ?.error_code
      errorCodes.push(errorCode ?? 'unknown')
      continue
    }

    for (const r of block.content as Array<{
      title: string
      url: string
      page_age?: string
      type?: string
    }>) {
      results.push({
        title: r.title,
        url: r.url,
      })
    }
  }

  if (results.length === 0 && errorCodes.length > 0) {
    throw new Error(`Web search error: ${errorCodes[0]}`)
  }

  return results
}
