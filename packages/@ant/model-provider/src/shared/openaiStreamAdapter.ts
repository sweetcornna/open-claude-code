import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import { randomUUID } from 'crypto'
import {
  normalizeOpenAIUsage,
  readOpenAICachedTokens,
  readOpenAICacheWriteTokens,
} from './openaiUsage.js'

/**
 * Adapt an OpenAI streaming response into Anthropic BetaRawMessageStreamEvent.
 *
 * Mapping:
 *   First chunk              → message_start
 *   delta.reasoning_content  → content_block_start(thinking) + thinking_delta + content_block_stop
 *   delta.content            → content_block_start(text) + text_delta + content_block_stop
 *   delta.tool_calls         → content_block_start(tool_use) + input_json_delta + content_block_stop
 *   finish_reason            → message_delta(stop_reason) + message_stop
 *
 * Usage field mapping (OpenAI → Anthropic):
 *   prompt_tokens - cached_tokens - cache_write_tokens → input_tokens
 *   completion_tokens                         → output_tokens
 *   prompt_tokens_details.cached_tokens       → cache_read_input_tokens
 *   prompt_tokens_details.cache_write_tokens  → cache_creation_input_tokens
 *
 *   All four fields are emitted in the post-loop message_delta (not message_start)
 *   so that trailing usage chunks (sent after finish_reason by some
 *   OpenAI-compatible endpoints) are fully captured before the final counts are reported.
 *
 * Thinking support:
 *   DeepSeek and compatible providers send `delta.reasoning_content` for chain-of-thought.
 *   This is mapped to Anthropic's `thinking` content blocks:
 *     content_block_start: { type: 'thinking', thinking: '', signature: '' }
 *     content_block_delta: { type: 'thinking_delta', thinking: '...' }
 *
 * Prompt caching:
 *   OpenAI reports cached tokens in usage.prompt_tokens_details.cached_tokens.
 *   DeepSeek reports usage.prompt_cache_hit_tokens; some proxies flatten it to
 *   usage.cached_tokens. All three map to Anthropic's cache_read_input_tokens.
 */
class IncompleteOpenAIStreamError extends Error {
  readonly retryable = true

  constructor() {
    super('OpenAI-compatible stream ended before finish_reason')
    this.name = 'IncompleteOpenAIStreamError'
  }
}

export async function* adaptOpenAIStreamToAnthropic(
  stream: AsyncIterable<ChatCompletionChunk>,
  model: string,
  options?: { includeCacheWriteTokens?: boolean },
): AsyncGenerator<BetaRawMessageStreamEvent, void> {
  const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`

  let started = false
  let currentContentIndex = -1

  // Track tool_use blocks: tool_calls index → { contentIndex, id, name, arguments }
  const toolBlocks = new Map<
    number,
    { contentIndex: number; id: string; name: string; arguments: string }
  >()

  // Track thinking block state
  let thinkingBlockOpen = false

  // Track text block state
  let textBlockOpen = false

  // Track raw OpenAI usage across chunks. The normalized Anthropic fields are
  // disjoint: ordinary input + cache reads + cache writes = total input.
  let rawInputTokens = 0
  let outputTokens = 0
  let rawCacheReadTokens = 0
  let rawCacheWriteTokens = 0
  let usage = normalizeOpenAIUsage({ totalInputTokens: 0, outputTokens: 0 })

  // Track all open content block indices (for cleanup)
  const openBlockIndices = new Set<number>()

  // Deferred finish state
  let pendingFinishReason: string | null = null
  let pendingHasToolCalls = false
  let sawOutput = false
  let sawTerminalUsageChunk = false

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0]
    const delta = choice?.delta

    // Extract usage from any chunk that carries it.
    if (chunk.usage) {
      // Some OpenAI-compatible gateways close a successful stream with an
      // include_usage chunk but omit both finish_reason and [DONE]. The usage
      // chunk is terminal evidence only after actual output has been seen; an
      // empty or abruptly truncated stream must remain retryable.
      if (
        (chunk.usage.completion_tokens ?? 0) > 0 &&
        chunk.choices.length === 0
      ) {
        sawTerminalUsageChunk = true
      }
      rawInputTokens = chunk.usage.prompt_tokens ?? rawInputTokens
      outputTokens = chunk.usage.completion_tokens ?? outputTokens

      // Endpoints disagree on where the cached-prefix count lives; the field
      // preference order is centralized in readOpenAICachedTokens. Carried
      // forward when a chunk omits it — a trailing usage chunk that reports
      // only totals must not zero an already-seen cache read.
      const cachedTokens = readOpenAICachedTokens(chunk.usage)
      if (cachedTokens !== undefined) {
        rawCacheReadTokens = cachedTokens
      }
      if (options?.includeCacheWriteTokens) {
        rawCacheWriteTokens =
          readOpenAICacheWriteTokens(chunk.usage) ?? rawCacheWriteTokens
      } else {
        rawCacheWriteTokens = 0
      }

      usage = normalizeOpenAIUsage({
        totalInputTokens: rawInputTokens,
        outputTokens,
        cacheReadTokens: rawCacheReadTokens,
        cacheWriteTokens: rawCacheWriteTokens,
      })
    }

    // Emit message_start on first chunk
    if (!started) {
      started = true

      yield {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            ...usage,
            output_tokens: 0,
          },
        },
      } as unknown as BetaRawMessageStreamEvent
    }

    // Skip chunks that carry only usage data (no delta content)
    if (!delta) continue

    // Handle reasoning_content → Anthropic thinking block.
    // Empty string is a valid signal: DeepSeek v4 thinking mode sometimes
    // returns reasoning_content: "" when the model answers directly. The
    // empty thinking block must round-trip back to the API in subsequent
    // requests, otherwise DeepSeek rejects with 400.
    const reasoningContent = (delta as any).reasoning_content
    if (reasoningContent != null) {
      sawOutput = true
      if (!thinkingBlockOpen) {
        // Close an open text block first, mirroring what the text and
        // tool_call handlers below already do for each other.
        //
        // DeepSeek thinking mode reasons *between* steps ("multiple turns of
        // reasoning and tool calls" — api-docs.deepseek.com/guides/thinking_mode),
        // so reasoning genuinely arrives after text has started. Without this,
        // currentContentIndex advanced to the new thinking block while
        // textBlockOpen stayed true, and the next delta.content emitted a
        // text_delta at the thinking block's index — the visible answer was
        // appended into the model's chain of thought, and the text block was
        // left open until the end-of-stream safety sweep.
        if (textBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          openBlockIndices.delete(currentContentIndex)
          textBlockOpen = false
        }

        currentContentIndex++
        thinkingBlockOpen = true
        openBlockIndices.add(currentContentIndex)

        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: {
            type: 'thinking',
            thinking: '',
            signature: '',
          },
        } as BetaRawMessageStreamEvent
      }

      if (reasoningContent !== '') {
        yield {
          type: 'content_block_delta',
          index: currentContentIndex,
          delta: {
            type: 'thinking_delta',
            thinking: reasoningContent,
          },
        } as BetaRawMessageStreamEvent
      }
    }

    // Handle text content
    if (delta.content != null && delta.content !== '') {
      sawOutput = true
      if (!textBlockOpen) {
        // Close thinking block if still open
        if (thinkingBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          openBlockIndices.delete(currentContentIndex)
          thinkingBlockOpen = false
        }

        currentContentIndex++
        textBlockOpen = true
        openBlockIndices.add(currentContentIndex)

        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: {
            type: 'text',
            text: '',
          },
        } as BetaRawMessageStreamEvent
      }

      yield {
        type: 'content_block_delta',
        index: currentContentIndex,
        delta: {
          type: 'text_delta',
          text: delta.content,
        },
      } as BetaRawMessageStreamEvent
    }

    // Handle tool calls
    if (delta.tool_calls) {
      sawOutput = true
      for (const tc of delta.tool_calls) {
        const tcIndex = tc.index

        if (!toolBlocks.has(tcIndex)) {
          // Close thinking block if open
          if (thinkingBlockOpen) {
            yield {
              type: 'content_block_stop',
              index: currentContentIndex,
            } as BetaRawMessageStreamEvent
            openBlockIndices.delete(currentContentIndex)
            thinkingBlockOpen = false
          }

          // Close text block if open
          if (textBlockOpen) {
            yield {
              type: 'content_block_stop',
              index: currentContentIndex,
            } as BetaRawMessageStreamEvent
            openBlockIndices.delete(currentContentIndex)
            textBlockOpen = false
          }

          // Start new tool_use block
          currentContentIndex++
          const toolId =
            tc.id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`
          const toolName = tc.function?.name || ''

          toolBlocks.set(tcIndex, {
            contentIndex: currentContentIndex,
            id: toolId,
            name: toolName,
            arguments: '',
          })
          openBlockIndices.add(currentContentIndex)

          yield {
            type: 'content_block_start',
            index: currentContentIndex,
            content_block: {
              type: 'tool_use',
              id: toolId,
              name: toolName,
              input: {},
            },
          } as BetaRawMessageStreamEvent
        }

        // Stream argument fragments
        const argFragment = tc.function?.arguments
        if (argFragment) {
          toolBlocks.get(tcIndex)!.arguments += argFragment
          yield {
            type: 'content_block_delta',
            index: toolBlocks.get(tcIndex)!.contentIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: argFragment,
            },
          } as BetaRawMessageStreamEvent
        }
      }
    }

    // Handle finish
    if (choice?.finish_reason) {
      if (thinkingBlockOpen) {
        yield {
          type: 'content_block_stop',
          index: currentContentIndex,
        } as BetaRawMessageStreamEvent
        openBlockIndices.delete(currentContentIndex)
        thinkingBlockOpen = false
      }

      if (textBlockOpen) {
        yield {
          type: 'content_block_stop',
          index: currentContentIndex,
        } as BetaRawMessageStreamEvent
        openBlockIndices.delete(currentContentIndex)
        textBlockOpen = false
      }

      for (const [, block] of toolBlocks) {
        if (openBlockIndices.has(block.contentIndex)) {
          yield {
            type: 'content_block_stop',
            index: block.contentIndex,
          } as BetaRawMessageStreamEvent
          openBlockIndices.delete(block.contentIndex)
        }
      }

      pendingFinishReason = choice.finish_reason
      pendingHasToolCalls = toolBlocks.size > 0
    }
  }

  if (pendingFinishReason === null) {
    if (sawOutput && sawTerminalUsageChunk) {
      // Compatibility fallback for gateways that terminate with usage instead of
      // finish_reason. Text/reasoning answers are ordinary stops; tool output is
      // still forced to tool_use by pendingHasToolCalls below.
      pendingFinishReason = 'stop'
      pendingHasToolCalls = toolBlocks.size > 0
    } else {
      throw new IncompleteOpenAIStreamError()
    }
  }

  // Safety: close any remaining open blocks
  for (const idx of openBlockIndices) {
    yield {
      type: 'content_block_stop',
      index: idx,
    } as BetaRawMessageStreamEvent
  }

  // Emit message_delta + message_stop
  if (pendingFinishReason !== null) {
    const stopReason =
      pendingFinishReason === 'length'
        ? 'max_tokens'
        : pendingHasToolCalls
          ? 'tool_use'
          : mapFinishReason(pendingFinishReason)

    yield {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage,
    } as BetaRawMessageStreamEvent

    yield {
      type: 'message_stop',
    } as BetaRawMessageStreamEvent
  }
}

/**
 * Map OpenAI finish_reason to Anthropic stop_reason.
 */
function mapFinishReason(reason: string): string {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}
