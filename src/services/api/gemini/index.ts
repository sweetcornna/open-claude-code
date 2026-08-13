import type {
  BetaToolUnion,
  BetaMessage,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import { type Tools } from '../../../Tool.js'
import { toolToAPISchema } from '../../../utils/telemetry/api.js'
import { logForDebugging } from '../../../utils/telemetry/debug.js'
import {
  createAssistantAPIErrorMessageFromError,
  normalizeMessagesForAPI,
} from '../../../utils/messages.js'
import { assembleFinalAssistantOutputs } from '../streamAssembly.js'
import { isUserAbort } from '../userAbort.js'
import { resolveAppliedEffort } from '../../../utils/model/effort.js'
import { applyGeminiEffortToThinkingBudget } from './reasoning.js'
import { updateOpenAIUsage } from '../openai/openaiShared.js'
import { addToTotalSessionCost } from '../../../cost-tracker.js'
import { calculateUSDCost } from '../../../utils/model/modelCost.js'
import type { SystemPrompt } from '../../../utils/session/systemPromptType.js'
import type { ThinkingConfig } from '../../../utils/model/thinking.js'
import type { Options } from '../claude.js'
import { recordLLMObservation } from '../../../services/langfuse/tracing.js'
import {
  convertMessagesToLangfuse,
  convertOutputToLangfuse,
  convertToolsToLangfuse,
} from '../../../services/langfuse/convert.js'
import { streamGeminiGenerateContent } from './client.js'
import {
  anthropicMessagesToGemini,
  resolveGeminiModel,
  adaptGeminiStreamToAnthropic,
  anthropicToolsToGemini,
  anthropicToolChoiceToGemini,
  GEMINI_THOUGHT_SIGNATURE_FIELD,
} from '@ant/model-provider'

const GEMINI_MAX_TOKENS_ENV_HINT =
  'GEMINI_MAX_TOKENS or CLAUDE_CODE_MAX_OUTPUT_TOKENS'

function getGeminiTerminationError(stopReason: string | null) {
  if (
    stopReason === null ||
    stopReason === 'end_turn' ||
    stopReason === 'tool_use' ||
    stopReason === 'max_tokens'
  ) {
    return undefined
  }
  return {
    content: `Gemini stopped the response: ${stopReason}.`,
    errorDetails: `Gemini finishReason=${stopReason}`,
  }
}

export async function* queryModelGemini(
  messages: Message[],
  systemPrompt: SystemPrompt,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
  thinkingConfig: ThinkingConfig,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  try {
    const geminiModel = resolveGeminiModel(options.model)
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
        const anyTool = t as unknown as Record<string, unknown>
        return (
          anyTool.type !== 'advisor_20260301' &&
          anyTool.type !== 'computer_20250124'
        )
      },
    )

    const { contents, systemInstruction } = anthropicMessagesToGemini(
      messagesForAPI,
      systemPrompt,
    )
    const geminiTools = anthropicToolsToGemini(standardTools)
    const toolChoice = anthropicToolChoiceToGemini(options.toolChoice)

    // Opt-in output cap: without it the endpoint's own default applies
    // (the historical behavior). GEMINI_MAX_TOKENS wins over the generic key.
    const geminiMaxTokensRaw = parseInt(
      process.env.GEMINI_MAX_TOKENS ??
        process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ??
        '',
      10,
    )
    const geminiMaxTokens =
      Number.isFinite(geminiMaxTokensRaw) && geminiMaxTokensRaw > 0
        ? geminiMaxTokensRaw
        : undefined

    const stream = streamGeminiGenerateContent({
      model: geminiModel,
      signal,
      fetchOverride: options.fetchOverride as typeof fetch | undefined,
      body: {
        contents,
        ...(systemInstruction && { systemInstruction }),
        ...(geminiTools.length > 0 && { tools: geminiTools }),
        ...(toolChoice && {
          toolConfig: {
            functionCallingConfig: toolChoice,
          },
        }),
        generationConfig: {
          ...(options.temperatureOverride !== undefined && {
            temperature: options.temperatureOverride,
          }),
          ...(geminiMaxTokens !== undefined
            ? { maxOutputTokens: geminiMaxTokens }
            : {}),
          ...(thinkingConfig.type !== 'disabled' && {
            thinkingConfig: {
              includeThoughts: true,
              ...(thinkingConfig.type === 'enabled' && {
                // Gemini has no effort vocabulary; the budget IS the knob, so
                // the ladder scales it. `high` is the identity and the family
                // default, so an untouched session sends what it always did.
                thinkingBudget: applyGeminiEffortToThinkingBudget(
                  thinkingConfig.budgetTokens,
                  resolveAppliedEffort(
                    options.model,
                    options.effortValue,
                    options.modelSettingsSlot,
                    options.sessionModelSettingsOverrides,
                  ),
                ),
              }),
            },
          }),
        },
      },
    })

    logForDebugging(
      `[Gemini] Calling model=${geminiModel}, messages=${contents.length}, tools=${geminiTools.length}`,
    )

    const adaptedStream = adaptGeminiStreamToAnthropic(stream, geminiModel)
    const contentBlocks: Record<number, Record<string, unknown>> = {}
    const collectedMessages: AssistantMessage[] = []
    let partialMessage: BetaMessage | null = null
    let usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    let stopReason: string | null = null
    let ttftMs = 0
    const start = Date.now()

    for await (const event of adaptedStream) {
      switch (event.type) {
        case 'message_start':
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
            if (block.type === 'thinking') {
              block.signature = delta.signature
            } else {
              block[GEMINI_THOUGHT_SIGNATURE_FIELD] = delta.signature
            }
          }
          break
        }
        case 'content_block_stop': {
          // Block accumulation is complete; assembly happens at message_stop.
          // Gemini only reports final token counts (including
          // cachedContentTokenCount) on the trailing chunks, so a message
          // built here would persist a zeroed cache read.
          break
        }
        case 'message_delta': {
          if (event.usage) {
            usage = updateOpenAIUsage(
              usage,
              event.usage as unknown as Parameters<typeof updateOpenAIUsage>[1],
            )
          }
          if (event.delta.stop_reason != null) {
            stopReason = event.delta.stop_reason
          }
          break
        }
        case 'message_stop': {
          if (partialMessage) {
            for (const output of assembleFinalAssistantOutputs({
              partialMessage,
              contentBlocks,
              tools,
              agentId: options.agentId,
              usage,
              stopReason,
              ...(geminiMaxTokens !== undefined
                ? { maxTokens: geminiMaxTokens }
                : {}),
              maxTokensEnvHint: GEMINI_MAX_TOKENS_ENV_HINT,
              terminalError: getGeminiTerminationError(stopReason),
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
              geminiModel,
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

    // Record LLM observation in Langfuse (no-op if not configured)
    recordLLMObservation(options.langfuseTrace ?? null, {
      model: geminiModel,
      provider: 'gemini',
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
      thinking:
        thinkingConfig.type !== 'disabled'
          ? {
              type: thinkingConfig.type,
              ...(thinkingConfig.type === 'enabled' && {
                budgetTokens: thinkingConfig.budgetTokens,
              }),
            }
          : undefined,
    })

    // Safety: if the stream ended without message_stop, assemble what we have
    // so the turn still carries usage instead of vanishing.
    if (partialMessage) {
      for (const output of assembleFinalAssistantOutputs({
        partialMessage,
        contentBlocks,
        tools,
        agentId: options.agentId,
        usage,
        stopReason,
        ...(geminiMaxTokens !== undefined
          ? { maxTokens: geminiMaxTokens }
          : {}),
        maxTokensEnvHint: GEMINI_MAX_TOKENS_ENV_HINT,
        terminalError: getGeminiTerminationError(stopReason),
      })) {
        yield output
      }
    }
  } catch (error) {
    // A user interrupt is not a failure — see isUserAbort.
    if (isUserAbort(error, signal)) {
      logForDebugging('[Gemini] Request aborted by user')
      return
    }
    logForDebugging('[Gemini] API request failed', { level: 'error' })
    yield createAssistantAPIErrorMessageFromError({
      apiError: 'api_error',
      sourceError: error,
      provider: 'Gemini',
    })
  }
}
