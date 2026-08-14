import { describe, expect, test } from 'bun:test'
import type { Message } from 'src/types/message.js'
import { tokenCountWithEstimation } from '../tokens.js'

/**
 * `tokenCountWithEstimation` anchors on the most recent API-reported usage.
 *
 * Every third-party adapter (openai/index.ts:517, openai/responsesAdapter.ts:913,
 * gemini/index.ts:182, grok/index.ts:169) seeds that usage with {0,0,0,0} and
 * fills it from the stream's terminal event. A stream that ends early therefore
 * leaves an assistant record carrying a REAL model id and no counts — which
 * getTokenUsage's synthetic-model filter does not catch. Anchoring there
 * reports a ~0 context, so shouldAutoCompact says "plenty of room" and
 * autocompact stays off for the rest of the turn.
 *
 * getCurrentUsage has guarded against this since the context-counter-flashes-
 * to-zero fix; this pins the same guard on the threshold path.
 */

function assistant(
  id: string,
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  },
): Message {
  return {
    type: 'assistant',
    uuid: `00000000-0000-4000-8000-0000000000${id.slice(-2)}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      id,
      role: 'assistant',
      model: 'gpt-5.6-sol',
      content: [{ type: 'text', text: 'ok' }],
      usage,
    },
  } as unknown as Message
}

const REAL = {
  input_tokens: 3890,
  output_tokens: 572,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 367_104,
}
const PLACEHOLDER = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

describe('tokenCountWithEstimation', () => {
  test('counts the full context from the latest real usage', () => {
    expect(tokenCountWithEstimation([assistant('msg_a', REAL)])).toBe(371_566)
  })

  test('does not anchor on an all-zero placeholder from a truncated stream', () => {
    const count = tokenCountWithEstimation([
      assistant('msg_a', REAL),
      assistant('msg_b', PLACEHOLDER),
    ])

    // Falls back to the previous real anchor (plus a rough estimate for the
    // placeholder record's own content) rather than reporting ~0.
    expect(count).toBeGreaterThanOrEqual(371_566)
  })

  test('reports zero only when no record ever carried usage', () => {
    expect(
      tokenCountWithEstimation([assistant('msg_a', PLACEHOLDER)]),
    ).toBeLessThan(1_000)
  })
})
