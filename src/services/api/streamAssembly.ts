import { APIUserAbortError } from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
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
import { sleep } from '../../utils/process/sleep.js'
import {
  isAPIErrorReplayable,
  isRetryableAPIError,
  NonRetryableError,
} from './retryClassification.js'
import { getOpenAIRetryDelay, resolveOpenAIMaxRetries } from './openai/retry.js'

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

type StreamCommitment = 'none' | 'thinking' | 'visible'

function streamCommitment(
  current: StreamCommitment,
  event: BetaRawMessageStreamEvent,
): StreamCommitment {
  if (current === 'visible') return current
  if (
    event.type === 'content_block_start' &&
    (event.content_block.type === 'tool_use' ||
      event.content_block.type === 'server_tool_use')
  ) {
    return 'visible'
  }
  if (event.type !== 'content_block_delta') return current
  if (event.delta.type === 'thinking_delta') {
    return current === 'none' && event.delta.thinking.length > 0
      ? 'thinking'
      : current
  }
  if (event.delta.type === 'signature_delta') {
    return current === 'none' && event.delta.signature.length > 0
      ? 'thinking'
      : current
  }
  if (
    (event.delta.type === 'text_delta' && event.delta.text.length > 0) ||
    (event.delta.type === 'input_json_delta' &&
      event.delta.partial_json.length > 0)
  ) {
    return 'visible'
  }
  return current
}

function finalizeInterruptedAttempt(
  commitment: StreamCommitment,
  lastContentIndex: number,
  hasToolUse: boolean,
  sawMessageStart: boolean,
): BetaRawMessageStreamEvent[] {
  if (commitment === 'none' && !sawMessageStart) return []
  return [
    ...(lastContentIndex >= 0
      ? ([
          {
            type: 'content_block_stop',
            index: lastContentIndex,
          } as BetaRawMessageStreamEvent,
        ] as BetaRawMessageStreamEvent[])
      : []),
    ...(commitment === 'visible'
      ? ([
          {
            type: 'message_delta',
            delta: {
              stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
              stop_sequence: null,
            },
            usage: { output_tokens: 0 },
          } as BetaRawMessageStreamEvent,
        ] as BetaRawMessageStreamEvent[])
      : []),
    { type: 'message_stop' } as BetaRawMessageStreamEvent,
  ]
}

/**
 * The failure a caller sees when a stream dies after the reader has already
 * been shown output.
 *
 * The partial blocks stay — they are on the terminal and on the SDK stream
 * already, and dropping them would replace one silence with another. What this
 * adds is the sentence saying they are partial. Without it, the synthesized
 * `message_delta` + `message_stop` below made a truncated answer
 * indistinguishable from a completed one: the turn simply ended early, and a
 * `tool_use` block whose argument JSON was cut mid-object reached
 * `normalizeContentFromAPI`, which cannot parse it and substitutes `{}`.
 *
 * Modelled on the official CLI, which finalizes the same way and then yields
 * "Connection lost mid-response. The response above may be incomplete."
 *
 * `NonRetryableError` (not a bare Error) so no ladder above re-sends a request
 * whose output has already been delivered, and so the SDK error category is
 * `server_error` rather than being guessed from the prose.
 */
function interruptedAfterOutputError(
  error: unknown,
  toolUseWasOpen: boolean,
): NonRetryableError {
  const cause =
    error instanceof Error ? error.message : String(error ?? 'unknown error')
  const toolNote = toolUseWasOpen
    ? ' A tool call was cut off mid-arguments, so its input is incomplete.'
    : ''
  // The cause is spelled into the message rather than attached: describeAPIError
  // reports the innermost `cause`'s message, which would bury this sentence.
  return new NonRetryableError(
    `Connection lost mid-response. The response above may be incomplete.${toolNote} Cause: ${cause}`,
    { category: 'server_error' },
  )
}

export async function* retryThirdPartyEventStream(params: {
  create: () => Promise<AsyncIterable<BetaRawMessageStreamEvent>>
  signal: AbortSignal
  maxRetries?: number
  delay?: (delayMs: number, signal: AbortSignal) => Promise<void>
  onRetry?: (error: unknown) => void | Promise<void>
}): AsyncGenerator<BetaRawMessageStreamEvent, void> {
  const maxRetries = params.maxRetries ?? resolveOpenAIMaxRetries()
  const delay =
    params.delay ??
    ((delayMs: number, signal: AbortSignal) =>
      sleep(delayMs, signal, { abortError: () => new APIUserAbortError() }))
  let noOutputRetries = 0
  let thinkingRetries = 0

  while (true) {
    if (params.signal.aborted) throw new APIUserAbortError()
    let commitment: StreamCommitment = 'none'
    let lastContentIndex = -1
    let sawMessageStart = false
    let sawMessageStop = false
    let hasToolUse = false
    // Index of a tool_use block opened but not yet closed. While this is set,
    // the block's accumulated argument JSON is a prefix, not a document.
    let openToolUseIndex = -1
    let stream: AsyncIterable<BetaRawMessageStreamEvent>
    try {
      stream = await params.create()
      for await (const event of stream) {
        commitment = streamCommitment(commitment, event)
        if (
          event.type === 'content_block_start' ||
          event.type === 'content_block_delta' ||
          event.type === 'content_block_stop'
        ) {
          lastContentIndex = Math.max(lastContentIndex, event.index)
        }
        if (
          event.type === 'content_block_stop' &&
          event.index === openToolUseIndex
        ) {
          openToolUseIndex = -1
        }
        if (
          event.type === 'content_block_start' &&
          (event.content_block.type === 'tool_use' ||
            event.content_block.type === 'server_tool_use')
        ) {
          hasToolUse = true
          openToolUseIndex = event.index
        }
        if (event.type === 'message_start') sawMessageStart = true
        if (event.type === 'message_stop') sawMessageStop = true
        yield event
      }
      if (!sawMessageStop) throw new Error('Stream ended before message_stop')
      return
    } catch (error) {
      if (params.signal.aborted || !isRetryableAPIError(error)) {
        throw error
      }
      if (commitment === 'visible') {
        for (const event of finalizeInterruptedAttempt(
          commitment,
          lastContentIndex,
          hasToolUse,
          sawMessageStart,
        )) {
          yield event
        }
        throw interruptedAfterOutputError(error, openToolUseIndex >= 0)
      }
      // Not gated on `commitment === 'none'` any more. An adapter stamps
      // `replayable: false` the moment output crosses its own visibility
      // barrier, and the Responses adapter's barrier includes reasoning text —
      // which arrives here as `thinking_delta`, i.e. commitment 'thinking'.
      // Re-running that stream re-renders reasoning the reader cannot un-see
      // and yields a second AssistantMessage for the same response.
      if (!isAPIErrorReplayable(error)) {
        throw error
      }
      const retry =
        commitment === 'thinking'
          ? ++thinkingRetries <= 2
          : ++noOutputRetries <= maxRetries
      if (!retry) throw error
      await params.onRetry?.(error)
      for (const event of finalizeInterruptedAttempt(
        commitment,
        lastContentIndex,
        hasToolUse,
        sawMessageStart,
      )) {
        yield event
      }
      if (commitment === 'none') {
        await delay(getOpenAIRetryDelay(noOutputRetries), params.signal)
      } else {
        await delay(100 * thinkingRetries, params.signal)
      }
    }
  }
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
