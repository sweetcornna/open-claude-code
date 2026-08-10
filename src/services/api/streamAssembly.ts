import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID } from 'crypto'
import type { AgentId } from '../../types/ids.js'
import type {
  AssistantMessage,
  SystemAPIErrorMessage,
} from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import {
  createAssistantAPIErrorMessage,
  normalizeContentFromAPI,
} from '../../utils/messages.js'

/**
 * Usage shape shared by every third-party adapter. Mirrors Anthropic's
 * disjoint accounting: input + cache_creation + cache_read sum to the total
 * prompt size, and never overlap.
 */
export type AdapterUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

/**
 * Assemble the final AssistantMessage (and optional max_tokens error) from
 * accumulated stream state.
 *
 * Every third-party path must funnel through this at `message_stop` rather
 * than yielding one AssistantMessage per `content_block_stop`. Per-block
 * messages can only carry the `message_start` usage snapshot, which is empty
 * for OpenAI-compatible streams (usage arrives in the trailing chunk) and
 * output-less for Gemini. That leaves `cache_read_input_tokens` at 0 on every
 * persisted message, so getCurrentUsage()/the cache-hit-rate readouts see no
 * cache reads at all and report a 0% hit rate no matter how well the provider
 * cached.
 */
export function assembleFinalAssistantOutputs(params: {
  partialMessage: BetaMessage | null
  contentBlocks: Record<number, Record<string, unknown>>
  tools: Tools
  agentId: string | undefined
  usage: AdapterUsage
  stopReason: string | null
  /** Requested output cap, when the path sends one. */
  maxTokens?: number
  /** Env vars named in the truncation error, most specific first. */
  maxTokensEnvHint: string
  /**
   * Extra provider-specific fields to stamp onto `message`. Message-level (not
   * block-level) on purpose: a mid-session model switch drops these, whereas
   * block-level metadata would ride along into another provider's request.
   */
  providerMetadata?: Record<string, unknown>
  terminalError?: {
    content: string
    errorDetails: string
  }
}): (AssistantMessage | SystemAPIErrorMessage)[] {
  const {
    partialMessage,
    contentBlocks,
    tools,
    agentId,
    usage,
    stopReason,
    maxTokens,
    maxTokensEnvHint,
    providerMetadata,
    terminalError,
  } = params
  const outputs: (AssistantMessage | SystemAPIErrorMessage)[] = []

  const allBlocks = Object.keys(contentBlocks)
    .sort((a, b) => Number(a) - Number(b))
    .map(k => contentBlocks[Number(k)])
    .filter(Boolean)

  if (allBlocks.length > 0 && partialMessage) {
    outputs.push({
      message: {
        ...partialMessage,
        content: normalizeContentFromAPI(
          allBlocks as unknown as BetaMessage['content'],
          tools,
          agentId as AgentId | undefined,
        ),
        usage,
        stop_reason: stopReason,
        stop_sequence: null,
        ...providerMetadata,
      } as AssistantMessage['message'],
      requestId: undefined,
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    } as AssistantMessage)
  }

  if (stopReason === 'max_tokens') {
    outputs.push(
      createAssistantAPIErrorMessage({
        content:
          maxTokens !== undefined
            ? `Output truncated: response exceeded the ${maxTokens} token limit. ` +
              `Set ${maxTokensEnvHint} to override.`
            : `Output truncated: response hit the endpoint's output token limit. ` +
              `Set ${maxTokensEnvHint} to raise it.`,
        apiError: 'max_output_tokens',
        error: 'max_output_tokens',
      }),
    )
  }

  if (terminalError) {
    outputs.push(
      createAssistantAPIErrorMessage({
        content: terminalError.content,
        apiError: 'api_error',
        error: 'unknown',
        errorDetails: terminalError.errorDetails,
      }),
    )
  }

  return outputs
}
