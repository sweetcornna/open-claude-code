import { describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import {
  createToolResultReleaseCache,
  releaseToolUseResults,
} from '../tools/toolResultRelease.js'

/**
 * The inline `.map()` that lived in query.ts before this helper existed.
 * Kept verbatim so the tests below can assert the helper is equivalent to it
 * rather than merely self-consistent.
 */
function legacyStrip(messages: Message[]): Message[] {
  return messages.map(msg => {
    if (
      msg.type !== 'user' ||
      !('toolUseResult' in msg) ||
      (msg as { toolUseResult?: unknown }).toolUseResult === undefined
    ) {
      return msg
    }
    const copy: typeof msg = { ...msg }
    delete (copy as Message & { toolUseResult?: unknown }).toolUseResult
    return copy
  })
}

function userWithResult(uuid: string, payload: unknown): Message {
  return {
    type: 'user',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: `t_${uuid}`, content: 'ok' },
      ],
    },
    toolUseResult: payload,
  } as unknown as Message
}

function userPlain(uuid: string): Message {
  return {
    type: 'user',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: 'hello' },
  } as unknown as Message
}

function assistant(uuid: string): Message {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { id: `msg_${uuid}`, role: 'assistant', content: [] },
  } as unknown as Message
}

const sample = (): Message[] => [
  userPlain('u1'),
  assistant('a1'),
  userWithResult('u2', { stdout: 'big output', stderr: '' }),
  assistant('a2'),
  userWithResult('u3', { stdout: 'more output', stderr: '' }),
]

describe('releaseToolUseResults', () => {
  test('produces the same result as the inline map it replaced', () => {
    const messages = sample()
    const actual = releaseToolUseResults(
      messages,
      createToolResultReleaseCache(),
    )
    expect(actual).toEqual(legacyStrip(messages))
  })

  test('drops toolUseResult from messages that carry one', () => {
    const messages = sample()
    const out = releaseToolUseResults(messages, createToolResultReleaseCache())
    for (const msg of out) {
      expect('toolUseResult' in msg).toBe(false)
    }
  })

  test('leaves the source messages untouched', () => {
    const messages = sample()
    const payload = (messages[2] as { toolUseResult?: unknown }).toolUseResult
    releaseToolUseResults(messages, createToolResultReleaseCache())
    // The UI still renders from these objects while the API view is derived.
    expect((messages[2] as { toolUseResult?: unknown }).toolUseResult).toBe(
      payload,
    )
    expect('toolUseResult' in messages[2]!).toBe(true)
  })

  test('passes messages without a payload through by reference', () => {
    const messages = sample()
    const out = releaseToolUseResults(messages, createToolResultReleaseCache())
    expect(out[0]).toBe(messages[0])
    expect(out[1]).toBe(messages[1])
    expect(out[3]).toBe(messages[3])
  })

  test('shares the rest of the message with the original', () => {
    const messages = sample()
    const out = releaseToolUseResults(messages, createToolResultReleaseCache())
    // A shallow copy: the content array is shared, not duplicated, so
    // stripping a 400KB payload does not clone the tool_result blocks.
    expect(out[2]).not.toBe(messages[2])
    expect((out[2] as { message: unknown }).message).toBe(
      (messages[2] as { message: unknown }).message,
    )
  })

  test('reuses the same copy across turns instead of rebuilding it', () => {
    const cache = createToolResultReleaseCache()
    const messages = sample()

    const firstTurn = releaseToolUseResults(messages, cache)
    // Next turn the loop sees the same history plus new messages appended.
    const grown = [...messages, assistant('a3'), userWithResult('u4', {})]
    const secondTurn = releaseToolUseResults(grown, cache)

    expect(secondTurn[2]).toBe(firstTurn[2])
    expect(secondTurn[4]).toBe(firstTurn[4])
  })

  test('a fresh cache rebuilds the copies', () => {
    const messages = sample()
    const first = releaseToolUseResults(
      messages,
      createToolResultReleaseCache(),
    )
    const second = releaseToolUseResults(
      messages,
      createToolResultReleaseCache(),
    )
    expect(second[2]).not.toBe(first[2])
    expect(second[2]).toEqual(first[2]!)
  })

  test('returns a fresh array so callers can append without aliasing', () => {
    const messages = sample()
    const out = releaseToolUseResults(messages, createToolResultReleaseCache())
    expect(out).not.toBe(messages)
    expect(out).toHaveLength(messages.length)
  })

  test('ignores a toolUseResult explicitly set to undefined', () => {
    const msg = userWithResult('u9', undefined)
    const out = releaseToolUseResults([msg], createToolResultReleaseCache())
    // Matches the legacy guard: `=== undefined` means nothing to release.
    expect(out[0]).toBe(msg)
  })

  test('does not strip non-user messages that happen to carry the key', () => {
    const odd = {
      type: 'assistant',
      uuid: 'a9',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { id: 'msg_a9', role: 'assistant', content: [] },
      toolUseResult: { stdout: 'x' },
    } as unknown as Message
    const out = releaseToolUseResults([odd], createToolResultReleaseCache())
    expect(out[0]).toBe(odd)
  })

  test('handles an empty history', () => {
    expect(releaseToolUseResults([], createToolResultReleaseCache())).toEqual(
      [],
    )
  })
})
