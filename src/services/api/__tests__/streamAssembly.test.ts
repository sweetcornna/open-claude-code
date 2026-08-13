import { describe, expect, test } from 'bun:test'
import type {
  BetaMessage,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  assembleFinalAssistantOutputs,
  retryThirdPartyEventStream,
} from '../streamAssembly.js'

const PARTIAL: BetaMessage = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  content: [],
  model: 'test-model',
  stop_reason: null,
  stop_sequence: null,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
} as unknown as BetaMessage

const CACHED_USAGE = {
  input_tokens: 1_200,
  output_tokens: 340,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 28_800,
}

async function collectStream(
  stream: AsyncIterable<BetaRawMessageStreamEvent>,
): Promise<BetaRawMessageStreamEvent[]> {
  const events: BetaRawMessageStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

const messageStart = {
  type: 'message_start',
  message: PARTIAL,
} as unknown as BetaRawMessageStreamEvent
const messageStop = {
  type: 'message_stop',
} as BetaRawMessageStreamEvent

function socketClosed(): Error {
  return Object.assign(new Error('other side closed'), {
    code: 'UND_ERR_SOCKET',
  })
}

describe('retryThirdPartyEventStream', () => {
  test('retries UND_ERR_SOCKET before any model output', async () => {
    let attempts = 0
    const events = await collectStream(
      retryThirdPartyEventStream({
        signal: new AbortController().signal,
        maxRetries: 1,
        delay: async () => {},
        create: async () =>
          (async function* () {
            attempts++
            if (attempts === 1) throw socketClosed()
            yield messageStart
            yield messageStop
          })(),
      }),
    )

    expect(attempts).toBe(2)
    expect(events).toEqual([messageStart, messageStop])
  })

  test('retries a thinking-only disconnect at most twice', async () => {
    let attempts = 0
    const events = await collectStream(
      retryThirdPartyEventStream({
        signal: new AbortController().signal,
        maxRetries: 10,
        delay: async () => {},
        create: async () =>
          (async function* () {
            attempts++
            yield messageStart
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking', thinking: '', signature: '' },
            } as BetaRawMessageStreamEvent
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: 'reasoning' },
            } as BetaRawMessageStreamEvent
            if (attempts < 3) throw socketClosed()
            yield { type: 'content_block_stop', index: 0 }
            yield messageStop
          })(),
      }),
    )

    expect(attempts).toBe(3)
    expect(events.filter(event => event.type === 'message_stop')).toHaveLength(
      3,
    )
  })

  test('finalizes visible output instead of replaying the request', async () => {
    let attempts = 0
    const events = await collectStream(
      retryThirdPartyEventStream({
        signal: new AbortController().signal,
        maxRetries: 10,
        delay: async () => {},
        create: async () =>
          (async function* () {
            attempts++
            yield messageStart
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            } as BetaRawMessageStreamEvent
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'visible' },
            } as BetaRawMessageStreamEvent
            throw socketClosed()
          })(),
      }),
    )

    expect(attempts).toBe(1)
    expect(events.at(-2)).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
    })
    expect(events.at(-1)).toEqual(messageStop)
  })
})

describe('assembleFinalAssistantOutputs', () => {
  test('lands the accumulated usage on the assembled message', () => {
    // The whole point of assembling at message_stop: OpenAI-compatible and
    // Gemini streams only report cache reads in their trailing chunks, so a
    // message built from the message_start snapshot persists a 0% hit rate.
    const outputs = assembleFinalAssistantOutputs({
      partialMessage: PARTIAL,
      contentBlocks: { 0: { type: 'text', text: 'done' } },
      tools: [],
      agentId: undefined,
      usage: CACHED_USAGE,
      stopReason: 'end_turn',
      maxTokensEnvHint: 'TEST_MAX_TOKENS',
    })

    expect(outputs).toHaveLength(1)
    const assembled = outputs[0]!
    expect(assembled.type).toBe('assistant')
    const usage = (assembled as { message: { usage: typeof CACHED_USAGE } })
      .message.usage
    expect(usage.cache_read_input_tokens).toBe(28_800)
    expect(usage.input_tokens).toBe(1_200)
    expect(usage.output_tokens).toBe(340)
  })

  test('stamps provider metadata onto the message, not onto a content block', () => {
    // The Responses path stashes reasoning items here so the next turn can
    // replay them. Message-level on purpose: a mid-session model switch drops
    // these, whereas block-level metadata would ride into another provider's
    // request.
    const outputs = assembleFinalAssistantOutputs({
      partialMessage: PARTIAL,
      contentBlocks: { 0: { type: 'text', text: 'done' } },
      tools: [],
      agentId: undefined,
      usage: CACHED_USAGE,
      stopReason: 'end_turn',
      maxTokensEnvHint: 'TEST_MAX_TOKENS',
      providerMetadata: { _openaiReasoningItems: [{ id: 'rs_1' }] },
    })

    const message = (outputs[0] as { message: Record<string, unknown> }).message
    expect(message._openaiReasoningItems).toEqual([{ id: 'rs_1' }])
    const content = message.content as Record<string, unknown>[]
    expect('_openaiReasoningItems' in content[0]!).toBe(false)
  })

  test('omits provider metadata entirely when there is none', () => {
    const outputs = assembleFinalAssistantOutputs({
      partialMessage: PARTIAL,
      contentBlocks: { 0: { type: 'text', text: 'done' } },
      tools: [],
      agentId: undefined,
      usage: CACHED_USAGE,
      stopReason: 'end_turn',
      maxTokensEnvHint: 'TEST_MAX_TOKENS',
    })

    const message = (outputs[0] as { message: Record<string, unknown> }).message
    expect('_openaiReasoningItems' in message).toBe(false)
  })

  test('orders content blocks numerically, not lexicographically', () => {
    const outputs = assembleFinalAssistantOutputs({
      partialMessage: PARTIAL,
      contentBlocks: {
        0: { type: 'text', text: 'a' },
        2: { type: 'text', text: 'c' },
        10: { type: 'text', text: 'k' },
      },
      tools: [],
      agentId: undefined,
      usage: CACHED_USAGE,
      stopReason: 'end_turn',
      maxTokensEnvHint: 'TEST_MAX_TOKENS',
    })

    const content = (outputs[0] as { message: { content: { text: string }[] } })
      .message.content
    expect(content.map(block => block.text)).toEqual(['a', 'c', 'k'])
  })

  test('emits nothing when no content blocks accumulated', () => {
    expect(
      assembleFinalAssistantOutputs({
        partialMessage: PARTIAL,
        contentBlocks: {},
        tools: [],
        agentId: undefined,
        usage: CACHED_USAGE,
        stopReason: 'end_turn',
        maxTokensEnvHint: 'TEST_MAX_TOKENS',
      }),
    ).toHaveLength(0)
  })

  test('appends a truncation error naming the cap when one was sent', () => {
    const outputs = assembleFinalAssistantOutputs({
      partialMessage: PARTIAL,
      contentBlocks: { 0: { type: 'text', text: 'cut off' } },
      tools: [],
      agentId: undefined,
      usage: CACHED_USAGE,
      stopReason: 'max_tokens',
      maxTokens: 4_096,
      maxTokensEnvHint: 'TEST_MAX_TOKENS',
    })

    expect(outputs).toHaveLength(2)
    const error = JSON.stringify(outputs[1])
    expect(error).toContain('4096')
    expect(error).toContain('TEST_MAX_TOKENS')
  })

  test('truncation error stays useful when no cap was sent', () => {
    const outputs = assembleFinalAssistantOutputs({
      partialMessage: PARTIAL,
      contentBlocks: { 0: { type: 'text', text: 'cut off' } },
      tools: [],
      agentId: undefined,
      usage: CACHED_USAGE,
      stopReason: 'max_tokens',
      maxTokensEnvHint: 'TEST_MAX_TOKENS',
    })

    expect(outputs).toHaveLength(2)
    expect(JSON.stringify(outputs[1])).toContain('TEST_MAX_TOKENS')
  })

  test('preserves partial output but appends a provider termination error', () => {
    const outputs = assembleFinalAssistantOutputs({
      partialMessage: PARTIAL,
      contentBlocks: { 0: { type: 'text', text: 'partial answer' } },
      tools: [],
      agentId: undefined,
      usage: CACHED_USAGE,
      stopReason: 'SAFETY',
      maxTokensEnvHint: 'TEST_MAX_TOKENS',
      terminalError: {
        content: 'Gemini stopped the response: SAFETY.',
        errorDetails: 'Gemini finishReason=SAFETY',
      },
    })

    expect(outputs).toHaveLength(2)
    expect(outputs[0]?.type).toBe('assistant')
    expect('isApiErrorMessage' in outputs[0]!).toBe(false)
    expect(outputs[1]).toMatchObject({
      type: 'assistant',
      isApiErrorMessage: true,
      apiError: 'api_error',
      error: 'unknown',
      errorDetails: 'Gemini finishReason=SAFETY',
    })
    expect(JSON.stringify(outputs[1])).toContain('SAFETY')
  })
})
