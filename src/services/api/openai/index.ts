import type {
  BetaToolUnion,
  BetaMessage,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { SystemPrompt } from '../../../utils/session/systemPromptType.js'
import type {
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  AssistantMessage,
  UserMessage,
} from '../../../types/message.js'
import type { Tools } from '../../../Tool.js'
import { isChatGPTCodexReasoningModel } from 'src/utils/model/chatgptModels.js'
import { isGptTuningActiveForModel } from 'src/utils/model/gptTuning.js'
import { asSystemPrompt } from 'src/utils/session/systemPromptType.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { getOpenAIClient } from './client.js'
import {
  formatOpenAIPromptCacheKey,
  getOpenAIPromptCacheKey,
  resolveOpenAIVerbosity,
  updateOpenAIUsage,
} from './openaiShared.js'
import { getGptBehaviorPromptSection } from './gptBehaviorPrompt.js'
import {
  anthropicMessagesToOpenAI,
  resolveOpenAIModel,
  adaptOpenAIStreamToAnthropic,
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
  OPENAI_REASONING_ITEMS_FIELD,
  type OpenAIReasoningItem,
} from '@ant/model-provider'
import { isChatGPTAuthEnabled } from './chatgptAuth.js'
import { resolveOpenAIWireProtocol } from './wireProtocol.js'
import {
  adaptResponsesStreamToAnthropic,
  buildResponsesRequest,
  createChatGPTResponsesStream,
  createOpenAIResponsesStream,
} from './responsesAdapter.js'
import {
  getChatReasoningEffort,
  getResponsesReasoningEffort,
} from './reasoning.js'
import { normalizeMessagesForAPI } from '../../../utils/messages.js'
import { toolToAPISchema } from '../../../utils/telemetry/api.js'
import {
  getEmptyToolPermissionContext,
  toolMatchesName,
} from '../../../Tool.js'
import { logForDebugging } from '../../../utils/telemetry/debug.js'
import { addToTotalSessionCost } from '../../../cost-tracker.js'
import { calculateUSDCost } from '../../../utils/model/modelCost.js'
import {
  isOpenAIThinkingEnabled,
  resolveOpenAIMaxTokens,
  buildOpenAIRequestBody,
} from './requestBody.js'
import { recordLLMObservation } from '../../../services/langfuse/tracing.js'
import {
  convertMessagesToLangfuse,
  convertOutputToLangfuse,
  convertToolsToLangfuse,
} from '../../../services/langfuse/convert.js'
export {
  isOpenAIThinkingEnabled,
  resolveOpenAIMaxTokens,
  buildOpenAIRequestBody,
}
import { assembleFinalAssistantOutputs } from '../streamAssembly.js'
import { getModelMaxOutputTokens } from '../../../utils/session/context.js'
import type { Options } from '../claude.js'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
} from '../../../utils/messages.js'
import type { SDKAssistantMessageError } from '../../../entrypoints/agentSdkTypes.js'
import {
  isSearchExtraToolsEnabled,
  isDeferredToolsDeltaEnabled,
} from '../../../utils/tools/searchExtraTools.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  SEARCH_EXTRA_TOOLS_TOOL_NAME,
} from '@open-claude-code/builtin-tools/tools/SearchExtraToolsTool/prompt.js'

/**
 * Mirrors the Anthropic request path's deferred-tool announcement for OpenAI.
 *
 * OpenAI-compatible endpoints cannot consume Anthropic's `defer_loading` or
 * `tool_reference` beta payloads directly, so the model needs the same textual
 * list of deferred MCP tool names that Anthropic receives before it can ask
 * SearchExtraToolsTool to load their full schemas.
 */
function prependDeferredToolListIfNeeded(
  messages: (AssistantMessage | UserMessage)[],
  tools: Tools,
  deferredToolNames: Set<string>,
  useSearchExtraTools: boolean,
): (AssistantMessage | UserMessage)[] {
  if (!useSearchExtraTools || isDeferredToolsDeltaEnabled()) return messages

  const deferredToolList = tools
    .filter(tool => deferredToolNames.has(tool.name))
    .map(formatDeferredToolLine)
    .sort()
    .join('\n')

  if (!deferredToolList) return messages

  return [
    createUserMessage({
      content: `<available-deferred-tools>\n${deferredToolList}\n</available-deferred-tools>`,
      isMeta: true,
    }),
    ...messages,
  ]
}

function isOpenAIConvertibleMessage(
  msg: Message,
): msg is AssistantMessage | UserMessage {
  return msg.type === 'assistant' || msg.type === 'user'
}

const OPENAI_MAX_TOKENS_ENV_HINT =
  'OPENAI_MAX_TOKENS or CLAUDE_CODE_MAX_OUTPUT_TOKENS'

/**
 * Stash this turn's reasoning items on the assistant message so the next
 * request can replay them. Returns undefined when there is nothing to carry,
 * keeping the field off messages from non-reasoning routes entirely.
 */
function reasoningMetadata(
  items: OpenAIReasoningItem[],
): Record<string, unknown> | undefined {
  return items.length > 0
    ? { [OPENAI_REASONING_ITEMS_FIELD]: items }
    : undefined
}

/**
 * OpenAI-compatible query path. Converts Anthropic-format messages/tools to
 * OpenAI format, calls the OpenAI-compatible endpoint, and converts the
 * SSE stream back to Anthropic BetaRawMessageStreamEvent for consumption
 * by the existing query pipeline.
 */
export async function* queryModelOpenAI(
  messages: Message[],
  systemPrompt: SystemPrompt,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  try {
    // 1. Resolve model name
    const openaiModel = resolveOpenAIModel(options.model)

    // 2. Normalize messages using shared preprocessing
    const messagesForAPI = normalizeMessagesForAPI(messages, tools)

    // 3. Check if tool search is enabled (similar to Anthropic path)
    const useSearchExtraTools = await isSearchExtraToolsEnabled(
      options.model,
      tools,
      options.getToolPermissionContext ||
        (async () => getEmptyToolPermissionContext()),
      options.agents || [],
      options.querySource,
    )

    // 4. Build deferred tools set (similar to Anthropic path)
    const deferredToolNames = new Set<string>()
    if (useSearchExtraTools) {
      for (const t of tools) {
        if (isDeferredTool(t)) deferredToolNames.add(t.name)
      }
    }

    // 5. Filter tools (similar to Anthropic path)
    // Never include deferred tools in the API tools array — they are invoked
    // via ExecuteExtraTool which looks them up from the global tool registry
    // at runtime. Keeping the tools array stable preserves the prompt cache.
    let filteredTools = tools
    if (useSearchExtraTools && deferredToolNames.size > 0) {
      filteredTools = tools.filter(tool => {
        // Always include non-deferred tools
        if (!deferredToolNames.has(tool.name)) return true
        // Always include SearchExtraToolsTool (so it can discover more tools)
        if (toolMatchesName(tool, SEARCH_EXTRA_TOOLS_TOOL_NAME)) return true
        // All other deferred tools are excluded — use ExecuteExtraTool instead
        return false
      })
    }

    // 6. Build tool schemas with deferLoading flag
    const toolSchemas = await Promise.all(
      filteredTools.map(tool =>
        toolToAPISchema(tool, {
          getToolPermissionContext: options.getToolPermissionContext,
          tools,
          agents: options.agents,
          allowedAgentTypes: options.allowedAgentTypes,
          model: options.model,
          deferLoading: useSearchExtraTools && deferredToolNames.has(tool.name),
        }),
      ),
    )

    // 7. Filter out non-standard tools (server tools like advisor)
    const standardTools = toolSchemas.filter(
      (t): t is BetaToolUnion & { type: string } => {
        const anyT = t as unknown as Record<string, unknown>
        return (
          anyT.type !== 'advisor_20260301' && anyT.type !== 'computer_20250124'
        )
      },
    )

    // 8. Convert messages and tools to OpenAI format
    const enableThinking = isOpenAIThinkingEnabled(openaiModel)
    const openAIConvertibleMessages = messagesForAPI.filter(
      isOpenAIConvertibleMessage,
    )
    const messagesWithDeferredToolList = prependDeferredToolListIfNeeded(
      openAIConvertibleMessages,
      tools,
      deferredToolNames,
      useSearchExtraTools,
    )
    // Resolved before the message conversion because the Responses wire
    // protocol needs the previous turns' reasoning items carried through —
    // Chat Completions must not see that field.
    const useChatGPTResponses = isChatGPTAuthEnabled()
    const wireProtocol = resolveOpenAIWireProtocol(openaiModel)
    const effectiveSystemPrompt = isGptTuningActiveForModel(openaiModel)
      ? asSystemPrompt([...systemPrompt, getGptBehaviorPromptSection()])
      : systemPrompt
    const openaiMessages = anthropicMessagesToOpenAI(
      messagesWithDeferredToolList,
      effectiveSystemPrompt,
      {
        enableThinking,
        preserveReasoningItems: wireProtocol === 'responses',
      },
    )
    const openaiTools = anthropicToolsToOpenAI(standardTools)
    const openaiToolChoice = anthropicToolChoiceToOpenAI(options.toolChoice)
    const reasoningEffort = getResponsesReasoningEffort(
      openaiModel,
      options.effortValue,
    )
    const verbosity = resolveOpenAIVerbosity(openaiModel, {
      baseURL: process.env.OPENAI_BASE_URL,
      isChatGPTAuth: useChatGPTResponses,
    })

    // 9. Log tool filtering details
    if (useSearchExtraTools) {
      const includedDeferredTools = filteredTools.filter(t =>
        deferredToolNames.has(t.name),
      ).length
      logForDebugging(
        `[OpenAI] Tool search enabled: ${includedDeferredTools}/${deferredToolNames.size} deferred tools included, total tools=${openaiTools.length}`,
      )
    } else {
      logForDebugging(
        `[OpenAI] Tool search disabled, total tools=${openaiTools.length}`,
      )
    }

    // 10. Compute max_tokens — required by most OpenAI-compatible endpoints.
    //     Without this the server uses a tiny default, and when
    //     thinking is enabled the thinking phase consumes the entire budget
    //     leaving no tokens for the final response.
    //
    //     Use upperLimit (not the slot-cap default) because the Anthropic path's
    //     slot-reservation cap (CAPPED_DEFAULT_MAX_TOKENS=8k) is paired with an
    //     auto-retry at 64k in query.ts. The OpenAI path has no such retry, so
    //     using the capped 8k default would silently truncate responses in
    //     multi-turn conversations where thinking consumes most of the budget.
    //
    //     Override priority:
    //     1. options.maxOutputTokensOverride (programmatic)
    //     2. OPENAI_MAX_TOKENS env var (OpenAI-specific, useful for local models
    //        with small context windows, e.g. RTX 3060 12GB running 65536-token models)
    //     3. CLAUDE_CODE_MAX_OUTPUT_TOKENS env var (generic override)
    //     4. upperLimit default (64000)
    const { upperLimit } = getModelMaxOutputTokens(openaiModel)
    const maxTokens = resolveOpenAIMaxTokens(
      upperLimit,
      options.maxOutputTokensOverride,
    )

    // OpenAI's official OAuth and API-key routes share the same prompt-cache
    // contract. Scope the key to the real conversation so resumed turns stay
    // sticky while unrelated sessions do not share a routing bucket. Generic
    // compatible endpoints intentionally receive no OpenAI-specific fields.
    const sessionId = getSessionId()
    const sessionPromptCacheKey = formatOpenAIPromptCacheKey(sessionId)
    const promptCacheKey = useChatGPTResponses
      ? sessionPromptCacheKey
      : getOpenAIPromptCacheKey(
          process.env.OPENAI_BASE_URL,
          sessionId,
          wireProtocol,
        )
    // A key is only ever set for endpoints that speak OpenAI's cache
    // contract, which is the same condition under which cache_write_tokens
    // can appear in usage.
    const reportsCacheWrites = promptCacheKey !== undefined

    logForDebugging(
      `[OpenAI] Calling model=${openaiModel}, wire=${wireProtocol}, messages=${openaiMessages.length}, tools=${openaiTools.length}, thinking=${enableThinking}${promptCacheKey ? `, prompt_cache_key=${promptCacheKey}` : ''}`,
    )

    // Reasoning items produced by this response, in output order. Stamped onto
    // the assembled assistant message so the next turn can replay them —
    // `store: false` means the server keeps no copy, and a request that omits
    // them no longer matches the cached prefix.
    const reasoningItems: OpenAIReasoningItem[] = []

    // 11. Call OpenAI API with streaming. The Responses wire protocol serves
    // two routes — ChatGPT subscription auth (Codex backend, ChatGPT headers,
    // no max_output_tokens) and generic API-key `/responses` endpoints
    // (standard headers, max_output_tokens honored). Everything else keeps
    // the Chat Completions adapter.
    const adaptedStream =
      wireProtocol === 'responses'
        ? adaptResponsesStreamToAnthropic(
            useChatGPTResponses
              ? await createChatGPTResponsesStream({
                  request: buildResponsesRequest({
                    model: openaiModel,
                    messages: openaiMessages,
                    tools: openaiTools,
                    toolChoice: openaiToolChoice,
                    reasoningEffort,
                    verbosity,
                    promptCacheKey: sessionPromptCacheKey,
                  }),
                  signal,
                  fetchOverride:
                    options.fetchOverride as unknown as typeof fetch,
                })
              : await createOpenAIResponsesStream({
                  request: buildResponsesRequest({
                    model: openaiModel,
                    messages: openaiMessages,
                    tools: openaiTools,
                    toolChoice: openaiToolChoice,
                    reasoningEffort,
                    verbosity,
                    promptCacheKey,
                    maxOutputTokens: maxTokens,
                  }),
                  signal,
                  fetchOverride:
                    options.fetchOverride as unknown as typeof fetch,
                }),
            openaiModel,
            { onReasoningItem: item => reasoningItems.push(item) },
          )
        : adaptOpenAIStreamToAnthropic(
            await getOpenAIClient({
              maxRetries: 2,
              fetchOverride: options.fetchOverride as unknown as typeof fetch,
              source: options.querySource,
            }).chat.completions.create(
              buildOpenAIRequestBody({
                model: openaiModel,
                messages: openaiMessages,
                tools: openaiTools,
                toolChoice: openaiToolChoice,
                enableThinking,
                maxTokens,
                baseURL: process.env.OPENAI_BASE_URL,
                temperatureOverride: options.temperatureOverride,
                promptCacheKey,
                ...(isChatGPTCodexReasoningModel(openaiModel)
                  ? {
                      reasoningEffort: getChatReasoningEffort(
                        openaiModel,
                        options.effortValue,
                      ),
                    }
                  : {}),
              }),
              { signal },
            ),
            openaiModel,
            { includeCacheWriteTokens: reportsCacheWrites },
          )

    // 12. Convert OpenAI stream to Anthropic events, then process into
    //     AssistantMessage + StreamEvent (matching the Anthropic path behavior)

    // Accumulate content blocks and usage, same as the Anthropic path in claude.ts
    const contentBlocks: Record<number, Record<string, unknown>> = {}
    const collectedMessages: AssistantMessage[] = []
    let partialMessage: BetaMessage | null = null
    let stopReason: string | null = null
    let usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    let ttftMs = 0
    const start = Date.now()

    for await (const event of adaptedStream) {
      switch (event.type) {
        case 'message_start': {
          partialMessage = event.message
          ttftMs = Date.now() - start
          if (event.message.usage) {
            usage = {
              ...usage,
              ...(event.message.usage as unknown as typeof usage),
            }
          }
          break
        }
        case 'content_block_start': {
          const idx = event.index
          const cb = event.content_block
          if (cb.type === 'tool_use') {
            contentBlocks[idx] = { ...cb, input: '' }
          } else if (cb.type === 'text') {
            contentBlocks[idx] = { ...cb, text: '' }
          } else if (cb.type === 'thinking') {
            contentBlocks[idx] = { ...cb, thinking: '', signature: '' }
          } else {
            contentBlocks[idx] = { ...cb }
          }
          break
        }
        case 'content_block_delta': {
          const idx = event.index
          const delta = event.delta
          const block = contentBlocks[idx]
          if (!block) break
          if (delta.type === 'text_delta') {
            block.text = ((block.text as string | undefined) || '') + delta.text
          } else if (delta.type === 'input_json_delta') {
            block.input =
              ((block.input as string | undefined) || '') + delta.partial_json
          } else if (delta.type === 'thinking_delta') {
            block.thinking =
              ((block.thinking as string | undefined) || '') + delta.thinking
          } else if (delta.type === 'signature_delta') {
            block.signature = delta.signature
          }
          break
        }
        case 'content_block_stop': {
          // Block accumulation is complete; assembly happens at message_stop.
          break
        }
        case 'message_delta': {
          const deltaUsage = event.usage
          if (deltaUsage) {
            usage = updateOpenAIUsage(
              usage,
              deltaUsage as unknown as Parameters<typeof updateOpenAIUsage>[1],
            )
          }
          if (event.delta.stop_reason != null) {
            stopReason = event.delta.stop_reason
          }
          break
        }
        case 'message_stop': {
          // Assemble ONE AssistantMessage with ALL content blocks, matching the
          // Anthropic SDK path. Real usage (input + output tokens) is available
          // here and injected so tokenCountWithEstimation() can read it.
          if (partialMessage) {
            for (const output of assembleFinalAssistantOutputs({
              partialMessage,
              contentBlocks,
              tools,
              agentId: options.agentId,
              usage,
              stopReason,
              maxTokens,
              maxTokensEnvHint: OPENAI_MAX_TOKENS_ENV_HINT,
              providerMetadata: reasoningMetadata(reasoningItems),
            })) {
              if (output.type === 'assistant') {
                collectedMessages.push(output)
              }
              yield output
            }
            // Reset partialMessage so the post-loop safety fallback does not
            // yield a second identical AssistantMessage.
            partialMessage = null
          }
          // Track cost and token usage
          if (usage.input_tokens + usage.output_tokens > 0) {
            const costUSD = calculateUSDCost(
              openaiModel,
              usage as unknown as BetaUsage,
            )
            addToTotalSessionCost(
              costUSD,
              usage as unknown as BetaUsage,
              options.model,
            )
          }
          break
        }
      }

      // Also yield as StreamEvent for real-time display (matching Anthropic path)
      yield {
        type: 'stream_event',
        event,
        ...(event.type === 'message_start' ? { ttftMs } : undefined),
      } as StreamEvent
    }

    // Record LLM observation in Langfuse (no-op if not configured)
    recordLLMObservation(options.langfuseTrace ?? null, {
      model: openaiModel,
      provider: 'openai',
      input: convertMessagesToLangfuse(openaiMessages),
      output: convertOutputToLangfuse(collectedMessages),
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
      },
      startTime: new Date(start),
      endTime: new Date(),
      completionStartTime: ttftMs > 0 ? new Date(start + ttftMs) : undefined,
      tools: convertToolsToLangfuse(toolSchemas as unknown[]),
      ...(enableThinking && { thinking: { type: 'enabled' } }),
    })

    // Safety: if stream ended without message_stop, assemble and yield whatever we have
    if (partialMessage) {
      for (const output of assembleFinalAssistantOutputs({
        partialMessage,
        contentBlocks,
        tools,
        agentId: options.agentId,
        usage,
        stopReason,
        maxTokens,
        maxTokensEnvHint: OPENAI_MAX_TOKENS_ENV_HINT,
        providerMetadata: reasoningMetadata(reasoningItems),
      })) {
        yield output
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`[OpenAI] Error: ${errorMessage}`, { level: 'error' })
    yield createAssistantAPIErrorMessage({
      content: `API Error: ${errorMessage}`,
      apiError: 'api_error',
      error: (error instanceof Error
        ? error
        : new Error(String(error))) as unknown as SDKAssistantMessageError,
    })
  }
}
