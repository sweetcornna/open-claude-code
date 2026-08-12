/**
 * Ordering cover for `/copy N`: index 0 is the latest assistant text, so
 * `/copy N` reads `texts[N - 1]`. If this list ever stops being newest-first
 * (or stops skipping tool-use-only turns), `/copy 2` silently copies the wrong
 * response instead of failing.
 */
import { describe, expect, test } from 'bun:test'
import type { Message } from 'src/types/message.js'
import { collectRecentAssistantTexts } from '../copy.js'

function assistant(
  text: string,
  extra?: { isApiErrorMessage?: boolean },
): Message {
  return {
    type: 'assistant',
    isApiErrorMessage: extra?.isApiErrorMessage ?? false,
    message: { content: [{ type: 'text', text }] },
  } as unknown as Message
}

function toolUseOnly(): Message {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
    },
  } as unknown as Message
}

function user(text: string): Message {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text }] },
  } as unknown as Message
}

describe('collectRecentAssistantTexts', () => {
  test('returns assistant texts newest-first', () => {
    const texts = collectRecentAssistantTexts([
      assistant('first'),
      user('ask'),
      assistant('second'),
      assistant('third'),
    ])
    expect(texts).toEqual(['third', 'second', 'first'])
  })

  test('skips tool-use-only turns and API errors', () => {
    const texts = collectRecentAssistantTexts([
      assistant('kept'),
      toolUseOnly(),
      assistant('boom', { isApiErrorMessage: true }),
    ])
    expect(texts).toEqual(['kept'])
  })

  test('caps the lookback so /copy N cannot reach arbitrarily far back', () => {
    const messages = Array.from({ length: 40 }, (_, i) => assistant(`m${i}`))
    const texts = collectRecentAssistantTexts(messages)
    expect(texts.length).toBe(20)
    expect(texts[0]).toBe('m39')
  })
})
