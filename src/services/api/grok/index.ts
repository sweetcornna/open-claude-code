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
} from '../../../types/message.js'
import type { Tools } from '../../../Tool.js'
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions/completions.mjs'
import { getGrokClient } from './client.js'
import { updateOpenAIUsage } from '../openai/openaiShared.js'
import {
  anthropicMessagesToOpenAI,
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
  adaptOpenAIStreamToAnthropic,
  resolveGrokModel,
} from '@ant/model-provider'
import {
  createAssistantAPIErrorMessageFromError,
  normalizeMessagesForAPI,
} from '../../../utils/messages.js'
import { toolToAPISchema } from '../../../utils/telemetry/api.js'
import { logForDebugging } from '../../../utils/telemetry/debug.js'
import { addToTotalSessionCost } from '../../../cost-tracker.js'
import { calculateUSDCost } from '../../../utils/model/modelCost.js'
import { recordLLMObservation } from '../../../services/langfuse/tracing.js'
import {
  convertMessagesToLangfuse,
  convertOutputToLangfuse,
  convertToolsToLangfuse,
} from '../../../services/langfuse/convert.js'
import type { Options } from '../claude.js'
import { resolveAppliedEffort } from '../../../utils/model/effort.js'
import { resolveGrokReasoningEffort } from './reasoning.js'
import { OpenAIRequestError } from '../openai/retry.js'
import { assembleFinalAssistantOutputs } from '../streamAssembly.js'
import { isUserAbort } from '../userAbort.js'

const GROK_MAX_TOKENS_ENV_HINT =
  'GROK_MAX_TOKENS or CLAUDE_CODE_MAX_OUTPUT_TOKENS'

/**
 * Grok (xAI) query path. Grok uses an OpenAI-compatible API, so we reuse
 * the OpenAI message/tool converters and stream adapter. Only the client
 * (different base URL + API key) and model mapping are Grok-specific.
 */
export async function* queryModelGrok(
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
    const grokModel = resolveGrokModel(options.model)
    const messagesForAPI = normalizeMessagesForAPI(messages, tools)

    const toolSchemas = await Promise.all(
      tools.map(tool =>
        toolToAPISchema(tool, {
          getToolPermissionContext: options.getToolPermissionContext,
          tools,
          agents: options.agents,
          allowedAgentTypes: options.allowedAgentTypes,
          model: options.model,
        }),
      ),
    )
    const standardTools = toolSchemas.filter(
      (t): t is BetaToolUnion & { type: string } => {
        const anyT = t as unknown as Record<string, unknown>
        return (
          anyT.type !== 'advisor_20260301' && anyT.type !== 'computer_20250124'
        )
      },
    )

    const openaiMessages = anthropicMessagesToOpenAI(
      messagesForAPI,
      systemPrompt,
    )
    const openaiTools = anthropicToolsToOpenAI(standardTools)
    const openaiToolChoice = anthropicToolChoiceToOpenAI(options.toolChoice)

    const client = getGrokClient({
      maxRetries: 0,
      fetchOverride: options.fetchOverride as typeof fetch | undefined,
      source: options.querySource,
    })

    logForDebugging(
      `[Grok] Calling model=${grokModel}, messages=${openaiMessages.length}, tools=${openaiTools.length}`,
    )

    // Opt-in output cap: without it the endpoint's own default applies (the
    // historical behavior). GROK_MAX_TOKENS wins over the generic key so a
    // provider profile can carry a per-provider value.
    const grokMaxTokens = parseInt(
      process.env.GROK_MAX_TOKENS ??
        process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ??
        '',
      10,
    )

    const grokReasoningEffort = resolveGrokReasoningEffort(
      grokModel,
      resolveAppliedEffort(options.model, options.effortValue),
    )

    const stream = await client.chat.completions.create(
      {
        model: grokModel,
        messages: openaiMessages,
        ...(openaiTools.length > 0 && {
          tools: openaiTools,
          ...(openaiToolChoice && { tool_choice: openaiToolChoice }),
        }),
        stream: true,
        stream_options: { include_usage: true },
        ...(Number.isFinite(grokMaxTokens) &&
          grokMaxTokens > 0 && { max_tokens: grokMaxTokens }),
        ...(options.temperatureOverride !== undefined && {
          temperature: options.temperatureOverride,
        }),
        // Only the grok-3-mini family takes this; the grok-4 reasoning models
        // reject it, so the resolver returns undefined for them and the body is
        // byte-identical to what it has always been.
        ...(grokReasoningEffort && { reasoning_effort: grokReasoningEffort }),
      } as ChatCompletionCreateParamsStreaming,
      {
        signal,
      },
    )

    const adaptedStream = adaptOpenAIStreamToAnthropic(
      stream as AsyncIterable<ChatCompletionChunk>,
      grokModel,
    )

    const contentBlocks: Record<number, Record<string, unknown>> = {}
    const collectedMessages: AssistantMessage[] = []
    let partialMessage: BetaMessage | null = null
    let usage: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens: number
      cache_read_input_tokens: number
    } = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    let stopReason: string | null = null
    let sawMessageStop = false
    let ttftMs = 0
    const start = Date.now()

    for await (const event of adaptedStream) {
      switch (event.type) {
        case 'message_start': {
          partialMessage = event.message
          ttftMs = Date.now() - start
          if (event.message.usage) {
            usage = updateOpenAIUsage(
              usage,
              event.message.usage as unknown as Parameters<
                typeof updateOpenAIUsage
              >[1],
            )
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
          // Block accumulation is complete; assembly happens at message_stop
          // so the persisted message carries the trailing usage chunk (xAI
          // reports prompt_tokens_details.cached_tokens only there).
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
          sawMessageStop = true
          if (partialMessage) {
            for (const output of assembleFinalAssistantOutputs({
              partialMessage,
              contentBlocks,
              tools,
              agentId: options.agentId,
              usage,
              stopReason,
              ...(Number.isFinite(grokMaxTokens) && grokMaxTokens > 0
                ? { maxTokens: grokMaxTokens }
                : {}),
              maxTokensEnvHint: GROK_MAX_TOKENS_ENV_HINT,
            })) {
              if (output.type === 'assistant') {
                collectedMessages.push(output)
              }
              yield output
            }
            // Reset so the post-loop safety fallback does not double-yield.
            partialMessage = null
          }
          if (usage.input_tokens + usage.output_tokens > 0) {
            const costUSD = calculateUSDCost(
              grokModel,
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

      yield {
        type: 'stream_event',
        event,
        ...(event.type === 'message_start' ? { ttftMs } : undefined),
      } as StreamEvent
    }

    if (!sawMessageStop) {
      throw new OpenAIRequestError('Grok stream ended before message_stop', {
        retryable: true,
      })
    }

    // Record LLM observation in Langfuse (no-op if not configured)
    recordLLMObservation(options.langfuseTrace ?? null, {
      model: grokModel,
      provider: 'grok',
      input: convertMessagesToLangfuse(messagesForAPI, systemPrompt),
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
    })
  } catch (error) {
    // A user interrupt is not a failure — see isUserAbort.
    if (isUserAbort(error, signal)) {
      logForDebugging('[Grok] Request aborted by user')
      return
    }
    logForDebugging('[Grok] API request failed', { level: 'error' })
    yield createAssistantAPIErrorMessageFromError({
      apiError: 'api_error',
      sourceError: error,
      provider: 'Grok',
    })
  }
}
