/**
 * Tests for the render-loop lookups policy used by Messages.tsx.
 *
 * Two things matter here and they pull against each other:
 *  - soundness: whatever the policy returns must equal a full rebuild, always;
 *  - effectiveness: the expensive path must actually be avoided.
 *
 * So every replay asserts equality against a fresh rebuild at each step *and*
 * pins which path was taken. A policy that always rebuilds is sound and
 * useless; one that always reuses is fast and wrong.
 *
 * No `mock.module` calls: everything under test is pure (see the note at the
 * top of messages.characterization.test.ts).
 */
import { describe, expect, test } from 'bun:test'
import type { Message, NormalizedMessage } from 'src/types/message.js'
import {
  assistantText,
  assistantToolUse,
  fixtureUuid,
  progressTick,
  userText,
  userToolResult,
} from '../../../tests/mocks/fixtures/conversation.js'
import {
  buildMessageLookups,
  type MessageLookupsCache,
  type MessageLookupsSource,
  normalizeMessages,
  resolveMessageLookups,
} from '../messages.js'

/** Messages.tsx never shows progress entries; it passes the filtered array. */
function shownFrom(
  normalized: NormalizedMessage[],
  window?: number,
): Message[] {
  const shown = normalized.filter(msg => msg.type !== 'progress') as Message[]
  return window === undefined ? shown : shown.slice(-window)
}

/**
 * Append one message at a time the way the REPL does, asserting after every
 * step that the policy's lookups match a full rebuild over the same input.
 *
 * `window` mimics the transcript cap, which slices a fixed-size tail.
 */
function replay(
  messages: Message[],
  window?: number,
): { sources: MessageLookupsSource[]; cache: MessageLookupsCache } {
  const accumulated: Message[] = []
  const sources: MessageLookupsSource[] = []
  let cache: MessageLookupsCache | null = null

  for (const [step, message] of messages.entries()) {
    accumulated.push(message)
    const normalized = normalizeMessages(accumulated)
    const shown = shownFrom(normalized, window)

    const resolved = resolveMessageLookups(cache, normalized, shown)
    cache = resolved.cache
    sources.push(resolved.source)

    expect({ step, lookups: resolved.lookups }).toEqual({
      step,
      lookups: buildMessageLookups(normalized, shown),
    })
  }

  return { sources, cache: cache! }
}

describe('resolveMessageLookups', () => {
  test('rebuilds on the first render and then updates incrementally', () => {
    const { sources } = replay([
      userText(fixtureUuid(1), 'go'),
      assistantToolUse({ messageId: 'msg_1', uuid: fixtureUuid(2) }, [
        { id: 'toolu_1', name: 'Bash' },
      ]),
      userToolResult(fixtureUuid(3), 'toolu_1', 'ok'),
      assistantText({ messageId: 'msg_2', uuid: fixtureUuid(4) }, 'done'),
    ])

    // The turn boundaries here (assistant -> user -> assistant) used to force a
    // full rebuild on every single message, because the call site rebuilt
    // whenever the trailing assistant message id changed. That is now handled
    // inside the updater, so the whole agentic loop stays on the fast path.
    expect(sources).toEqual([
      'rebuild',
      'incremental',
      'incremental',
      'incremental',
    ])
  })

  test('reuses the cached lookups when only message content changed', () => {
    const base: Message[] = [
      userText(fixtureUuid(1), 'go'),
      assistantText({ messageId: 'msg_1', uuid: fixtureUuid(2) }, 'thin'),
    ]
    const normalized = normalizeMessages(base)
    const first = resolveMessageLookups(null, normalized, shownFrom(normalized))
    expect(first.source).toBe('rebuild')

    // A streaming text delta: same structure, longer text.
    const streamed: Message[] = [
      base[0]!,
      assistantText(
        { messageId: 'msg_1', uuid: fixtureUuid(2) },
        'thinking about it',
      ),
    ]
    const streamedNormalized = normalizeMessages(streamed)
    const second = resolveMessageLookups(
      first.cache,
      streamedNormalized,
      shownFrom(streamedNormalized),
    )

    expect(second.source).toBe('cached')
    expect(second.lookups).toBe(first.lookups)
  })

  test('rebuilds when a trailing progress tick was replaced in place', () => {
    const base: Message[] = [
      userText(fixtureUuid(1), 'go'),
      assistantToolUse({ messageId: 'msg_1', uuid: fixtureUuid(2) }, [
        { id: 'toolu_1', name: 'Bash' },
      ]),
      progressTick(fixtureUuid(3), 'toolu_1'),
    ]
    const normalized = normalizeMessages(base)
    const first = resolveMessageLookups(null, normalized, shownFrom(normalized))

    // REPL.tsx swaps the ephemeral tick to bound the array: same lengths, fresh
    // tick. Reusing here would freeze ShellProgressMessage's elapsed time.
    const replaced = [...base]
    replaced[2] = progressTick(fixtureUuid(4), 'toolu_1')
    const replacedNormalized = normalizeMessages(replaced)
    const second = resolveMessageLookups(
      first.cache,
      replacedNormalized,
      shownFrom(replacedNormalized),
    )

    expect(second.source).toBe('rebuild')
    const ticks = second.lookups.progressMessagesByToolUseID.get('toolu_1')
    expect(ticks).toHaveLength(1)
    expect(ticks![0]!.uuid).toBe(fixtureUuid(4))
  })

  test('rebuilds instead of reusing stale lookups when the shown window slides', () => {
    // The transcript cap keeps a fixed-size tail: once saturated, appending a
    // message keeps the length identical while the contents shift. The counts
    // alone would still look append-only, and the updater — which reads
    // nothing before the cached count — would skip the new messages entirely.
    const conversation: Message[] = [
      userText(fixtureUuid(1), 'one'),
      userText(fixtureUuid(2), 'two'),
      userText(fixtureUuid(3), 'three'),
      assistantToolUse({ messageId: 'msg_1', uuid: fixtureUuid(4) }, [
        { id: 'toolu_late', name: 'Bash' },
      ]),
      userToolResult(fixtureUuid(5), 'toolu_late', 'ok'),
    ]

    // replay() already asserts equality with a rebuild at every step, which is
    // what would fail if the window slide went unnoticed.
    const { sources, cache } = replay(conversation, 3)

    // A tool use that only ever appears inside the slid window must still be
    // in the lookups.
    expect(cache.lookups.toolUseByToolUseID.has('toolu_late')).toBe(true)
    expect(cache.lookups.resolvedToolUseIDs.has('toolu_late')).toBe(true)
    // Once the window saturates it can no longer take the incremental path.
    expect(sources.slice(3)).toEqual(['rebuild', 'rebuild'])
  })

  test('stays sound across a long append-only conversation', () => {
    const conversation: Message[] = [userText(fixtureUuid(1), 'go')]
    for (let turn = 0; turn < 12; turn++) {
      conversation.push(
        assistantToolUse(
          { messageId: `msg_${turn}`, uuid: fixtureUuid(100 + turn * 3) },
          [{ id: `toolu_${turn}`, name: 'Bash' }],
        ),
        progressTick(fixtureUuid(101 + turn * 3), `toolu_${turn}`),
        userToolResult(fixtureUuid(102 + turn * 3), `toolu_${turn}`, 'ok'),
      )
    }

    const { sources, cache } = replay(conversation)

    expect(cache.lookups.toolUseByToolUseID.size).toBe(12)
    // One rebuild to prime the cache; everything after stays off it.
    expect(sources.filter(source => source === 'rebuild')).toEqual(['rebuild'])
  })
})
