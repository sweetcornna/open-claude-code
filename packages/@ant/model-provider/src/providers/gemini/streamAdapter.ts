import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID } from 'crypto'
import { normalizeGeminiUsage } from './usage.js'
import type {
  GeminiPart,
  GeminiStreamChunk,
  GeminiUsageMetadata,
} from './types.js'

export async function* adaptGeminiStreamToAnthropic(
  stream: AsyncIterable<GeminiStreamChunk>,
  model: string,
): AsyncGenerator<BetaRawMessageStreamEvent, void> {
  const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  let started = false
  let stopped = false
  let nextContentIndex = 0
  let openTextLikeBlock: { index: number; type: 'text' | 'thinking' } | null =
    null
  let sawToolUse = false
  let finishReason: string | undefined
  let deferContentEvents = false
  const deferredContentEvents: BetaRawMessageStreamEvent[] = []
  const toolContentIndexes = new Set<number>()
  const queueContentEvent = (
    event: BetaRawMessageStreamEvent,
  ): BetaRawMessageStreamEvent | undefined => {
    if (deferContentEvents) {
      deferredContentEvents.push(event)
      return undefined
    }
    return event
  }
  // Token accounting (including the promptTokenCount/cachedContentTokenCount
  // overlap correction) lives in normalizeGeminiUsage — shared with the
  // non-streaming side-query path so the two cannot drift.
  //
  // Fields are carried forward across chunks rather than read fresh each time:
  // Gemini repeats usageMetadata on most chunks but not reliably on all, and
  // a chunk that omits cachedContentTokenCount must not zero the cache read.
  let rawUsage: GeminiUsageMetadata = {}
  let usageTotals = normalizeGeminiUsage(undefined)

  for await (const chunk of stream) {
    const usage = chunk.usageMetadata
    if (usage) {
      rawUsage = {
        promptTokenCount: usage.promptTokenCount ?? rawUsage.promptTokenCount,
        candidatesTokenCount:
          usage.candidatesTokenCount ?? rawUsage.candidatesTokenCount,
        thoughtsTokenCount:
          usage.thoughtsTokenCount ?? rawUsage.thoughtsTokenCount,
        cachedContentTokenCount:
          usage.cachedContentTokenCount ?? rawUsage.cachedContentTokenCount,
      }
      usageTotals = normalizeGeminiUsage(rawUsage)
    }

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
          usage: { ...usageTotals, output_tokens: 0 },
        },
      } as unknown as BetaRawMessageStreamEvent
    }
    const candidate = chunk.candidates?.[0]
    const parts = candidate?.content?.parts ?? []

    for (const part of parts) {
      if (part.functionCall) {
        if (openTextLikeBlock) {
          const event = queueContentEvent({
            type: 'content_block_stop',
            index: openTextLikeBlock.index,
          } as BetaRawMessageStreamEvent)
          if (event) yield event
          openTextLikeBlock = null
        }

        sawToolUse = true
        const toolIndex = nextContentIndex++
        toolContentIndexes.add(toolIndex)
        deferContentEvents = true
        const toolId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        queueContentEvent({
          type: 'content_block_start',
          index: toolIndex,
          content_block: {
            type: 'tool_use',
            id: toolId,
            name: part.functionCall.name || '',
            input: {},
          },
        } as BetaRawMessageStreamEvent)

        if (part.thoughtSignature) {
          queueContentEvent({
            type: 'content_block_delta',
            index: toolIndex,
            delta: {
              type: 'signature_delta',
              signature: part.thoughtSignature,
            },
          } as BetaRawMessageStreamEvent)
        }

        if (
          part.functionCall.args &&
          Object.keys(part.functionCall.args).length > 0
        ) {
          queueContentEvent({
            type: 'content_block_delta',
            index: toolIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify(part.functionCall.args),
            },
          } as BetaRawMessageStreamEvent)
        }

        queueContentEvent({
          type: 'content_block_stop',
          index: toolIndex,
        } as BetaRawMessageStreamEvent)
        continue
      }

      const textLikeType = getTextLikeBlockType(part)
      if (textLikeType) {
        if (!openTextLikeBlock || openTextLikeBlock.type !== textLikeType) {
          if (openTextLikeBlock) {
            const event = queueContentEvent({
              type: 'content_block_stop',
              index: openTextLikeBlock.index,
            } as BetaRawMessageStreamEvent)
            if (event) yield event
          }

          openTextLikeBlock = {
            index: nextContentIndex++,
            type: textLikeType,
          }

          const event = queueContentEvent({
            type: 'content_block_start',
            index: openTextLikeBlock.index,
            content_block:
              textLikeType === 'thinking'
                ? {
                    type: 'thinking',
                    thinking: '',
                    signature: '',
                  }
                : {
                    type: 'text',
                    text: '',
                  },
          } as BetaRawMessageStreamEvent)
          if (event) yield event
        }

        if (part.text) {
          const event = queueContentEvent({
            type: 'content_block_delta',
            index: openTextLikeBlock.index,
            delta:
              textLikeType === 'thinking'
                ? {
                    type: 'thinking_delta',
                    thinking: part.text,
                  }
                : {
                    type: 'text_delta',
                    text: part.text,
                  },
          } as BetaRawMessageStreamEvent)
          if (event) yield event
        }

        if (part.thoughtSignature) {
          const event = queueContentEvent({
            type: 'content_block_delta',
            index: openTextLikeBlock.index,
            delta: {
              type: 'signature_delta',
              signature: part.thoughtSignature,
            },
          } as BetaRawMessageStreamEvent)
          if (event) yield event
        }

        continue
      }

      if (part.thoughtSignature && openTextLikeBlock) {
        const event = queueContentEvent({
          type: 'content_block_delta',
          index: openTextLikeBlock.index,
          delta: {
            type: 'signature_delta',
            signature: part.thoughtSignature,
          },
        } as BetaRawMessageStreamEvent)
        if (event) yield event
      }
    }

    if (candidate?.finishReason) {
      finishReason = candidate.finishReason
    } else if (chunk.promptFeedback?.blockReason) {
      finishReason = chunk.promptFeedback.blockReason
    }
  }

  if (!started) {
    return
  }

  if (openTextLikeBlock) {
    const event = queueContentEvent({
      type: 'content_block_stop',
      index: openTextLikeBlock.index,
    } as BetaRawMessageStreamEvent)
    if (event) yield event
  }

  const malformedFunctionCall = finishReason === 'MALFORMED_FUNCTION_CALL'
  for (const event of deferredContentEvents) {
    const index = (event as { index?: number }).index
    if (
      !malformedFunctionCall ||
      index === undefined ||
      !toolContentIndexes.has(index)
    ) {
      yield event
    }
  }

  if (!stopped) {
    yield {
      type: 'message_delta',
      delta: {
        stop_reason: mapGeminiFinishReason(
          finishReason,
          sawToolUse && !malformedFunctionCall,
        ),
        stop_sequence: null,
      },
      usage: usageTotals,
    } as BetaRawMessageStreamEvent

    yield {
      type: 'message_stop',
    } as BetaRawMessageStreamEvent
    stopped = true
  }
}

function getTextLikeBlockType(part: GeminiPart): 'text' | 'thinking' | null {
  if (typeof part.text !== 'string') {
    return null
  }
  return part.thought ? 'thinking' : 'text'
}

function mapGeminiFinishReason(
  reason: string | undefined,
  sawToolUse: boolean,
): string {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'max_tokens'
    case 'STOP':
    case undefined:
      return sawToolUse ? 'tool_use' : 'end_turn'
    default:
      // Gemini policy and malformed-call reasons are meaningful terminal states,
      // not successful end turns. Keep the provider reason intact so callers do
      // not execute or silently accept a blocked response.
      return reason
  }
}
