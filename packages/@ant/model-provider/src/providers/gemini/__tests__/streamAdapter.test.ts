import { describe, expect, test } from 'bun:test'
import { adaptGeminiStreamToAnthropic } from '../streamAdapter.js'
import type { GeminiStreamChunk } from '../types.js'

function mockStream(
  chunks: GeminiStreamChunk[],
): AsyncIterable<GeminiStreamChunk> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        async next() {
          if (index >= chunks.length) {
            return { done: true, value: undefined }
          }
          return { done: false, value: chunks[index++] }
        },
      }
    },
  }
}

async function collectEvents(chunks: GeminiStreamChunk[]) {
  const events: any[] = []
  for await (const event of adaptGeminiStreamToAnthropic(
    mockStream(chunks),
    'gemini-2.5-flash',
  )) {
    events.push(event)
  }
  return events
}

describe('adaptGeminiStreamToAnthropic', () => {
  test('converts text chunks', async () => {
    const events = await collectEvents([
      {
        candidates: [
          {
            content: {
              parts: [{ text: 'Hello' }],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [{ text: ' world' }],
            },
            finishReason: 'STOP',
          },
        ],
      },
    ])

    const textDeltas = events.filter(
      event =>
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta',
    )

    expect(events[0].type).toBe('message_start')
    expect(textDeltas).toHaveLength(2)
    expect(textDeltas[0].delta.text).toBe('Hello')
    expect(textDeltas[1].delta.text).toBe(' world')

    const messageDelta = events.find(event => event.type === 'message_delta')
    expect(messageDelta.delta.stop_reason).toBe('end_turn')
  })

  test('converts thinking chunks and signatures', async () => {
    const events = await collectEvents([
      {
        candidates: [
          {
            content: {
              parts: [{ text: 'Think', thought: true }],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [{ thought: true, thoughtSignature: 'sig-123' }],
            },
            finishReason: 'STOP',
          },
        ],
      },
    ])

    const blockStart = events.find(
      event => event.type === 'content_block_start',
    )
    expect(blockStart.content_block.type).toBe('thinking')

    const signatureDelta = events.find(
      event =>
        event.type === 'content_block_delta' &&
        event.delta.type === 'signature_delta',
    )
    expect(signatureDelta.delta.signature).toBe('sig-123')
  })

  test('converts function calls to tool_use blocks', async () => {
    const events = await collectEvents([
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'bash',
                    args: { command: 'ls' },
                  },
                  thoughtSignature: 'sig-tool',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
    ])

    const blockStart = events.find(
      event => event.type === 'content_block_start',
    )
    expect(blockStart.content_block.type).toBe('tool_use')
    expect(blockStart.content_block.name).toBe('bash')

    const signatureDelta = events.find(
      event =>
        event.type === 'content_block_delta' &&
        event.delta.type === 'signature_delta',
    )
    expect(signatureDelta.delta.signature).toBe('sig-tool')

    const inputDelta = events.find(
      event =>
        event.type === 'content_block_delta' &&
        event.delta.type === 'input_json_delta',
    )
    expect(inputDelta.delta.partial_json).toBe('{"command":"ls"}')

    const messageDelta = events.find(event => event.type === 'message_delta')
    expect(messageDelta.delta.stop_reason).toBe('tool_use')
  })

  test('maps usage metadata into output tokens', async () => {
    const events = await collectEvents([
      {
        candidates: [
          {
            content: {
              parts: [{ text: 'Hello' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 2,
        },
      },
    ])

    const messageStart = events.find(event => event.type === 'message_start')
    expect(messageStart.message.usage.input_tokens).toBe(10)

    const messageDelta = events.find(event => event.type === 'message_delta')
    expect(messageDelta.usage.output_tokens).toBe(7)
  })

  test('subtracts cached tokens from input_tokens', async () => {
    // Gemini counts the cached prefix inside promptTokenCount. Anthropic's
    // fields are disjoint, so leaving it in would double-count the prefix and
    // cap the reported hit rate at 50%.
    const events = await collectEvents([
      {
        candidates: [
          {
            content: {
              parts: [{ text: 'Hello' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 30_000,
          cachedContentTokenCount: 20_000,
          candidatesTokenCount: 5,
        },
      },
    ])

    const messageDelta = events.find(event => event.type === 'message_delta')
    expect(messageDelta.usage.input_tokens).toBe(10_000)
    expect(messageDelta.usage.cache_read_input_tokens).toBe(20_000)
    expect(messageDelta.usage.cache_creation_input_tokens).toBe(0)

    const { input_tokens, cache_read_input_tokens } = messageDelta.usage
    const hitRate =
      cache_read_input_tokens / (input_tokens + cache_read_input_tokens)
    expect(hitRate).toBeCloseTo(2 / 3, 5)
  })

  test('clamps cached tokens that exceed the reported prompt total', async () => {
    const events = await collectEvents([
      {
        candidates: [
          { content: { parts: [{ text: 'Hi' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 500,
          candidatesTokenCount: 1,
        },
      },
    ])

    const messageDelta = events.find(event => event.type === 'message_delta')
    expect(messageDelta.usage.input_tokens).toBe(0)
    expect(messageDelta.usage.cache_read_input_tokens).toBe(100)
  })

  test('a later chunk without usageMetadata does not zero the cache read', async () => {
    // Gemini repeats usageMetadata on most chunks but not reliably all of
    // them; recomputing from a bare chunk would erase an observed cache hit.
    const events = await collectEvents([
      {
        candidates: [{ content: { parts: [{ text: 'Hi' }] } }],
        usageMetadata: {
          promptTokenCount: 30_000,
          cachedContentTokenCount: 20_000,
          candidatesTokenCount: 2,
        },
      },
      {
        candidates: [
          { content: { parts: [{ text: '!' }] }, finishReason: 'STOP' },
        ],
      },
    ])

    const messageDelta = events.find(event => event.type === 'message_delta')
    expect(messageDelta.usage.cache_read_input_tokens).toBe(20_000)
    expect(messageDelta.usage.input_tokens).toBe(10_000)
  })

  test('a trailing chunk reporting only totals keeps the earlier cache read', async () => {
    const events = await collectEvents([
      {
        candidates: [{ content: { parts: [{ text: 'Hi' }] } }],
        usageMetadata: {
          promptTokenCount: 30_000,
          cachedContentTokenCount: 20_000,
        },
      },
      {
        candidates: [
          { content: { parts: [{ text: '!' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 30_000, candidatesTokenCount: 9 },
      },
    ])

    const messageDelta = events.find(event => event.type === 'message_delta')
    expect(messageDelta.usage.cache_read_input_tokens).toBe(20_000)
    expect(messageDelta.usage.output_tokens).toBe(9)
  })
})
