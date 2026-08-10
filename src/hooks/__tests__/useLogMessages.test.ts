/**
 * The REPL call site and the transcript writer, as one contract.
 *
 * `upsertMessageByUuid` (the REPL's catch-all stream branch) and
 * `planTranscriptWrite` (what useLogMessages decides to persist) only make
 * sense together: the first replaces a message in place, and the second is what
 * determines whether that replacement reaches disk. The cases below pin the
 * compaction replay that produces same-uuid arrivals in the first place, so a
 * later change to either side cannot silently duplicate messages on screen or
 * start rewriting the archive.
 *
 * Pure functions only — the repo has no React renderer, so hook logic is tested
 * the way useElapsedTime is (computeElapsedMs), by extracting the decision.
 */
import { describe, expect, test } from 'bun:test'
import type { UUID } from 'node:crypto'
import type { Message, UserMessage } from '../../types/message.js'
import { upsertMessageByUuid } from '../../utils/messages/merge.js'
import { planTranscriptWrite } from '../useLogMessages.js'

let uuidCounter = 0
function makeMessage(
  content: string,
  extra: Record<string, unknown> = {},
): UserMessage {
  uuidCounter++
  return {
    type: 'user',
    uuid: `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, '0')}`,
    timestamp: '2026-08-09T00:00:00.000Z',
    isMeta: false,
    message: { role: 'user', content },
    ...extra,
  } as unknown as UserMessage
}

/** What `stripToolUseResults` does to a kept message during compaction. */
function stripToolUseResult(message: Message): Message {
  const { toolUseResult: _dropped, ...rest } = message as Message & {
    toolUseResult?: unknown
  }
  return rest as Message
}

function planFor(previous: Message[], next: Message[]) {
  return planTranscriptWrite({
    length: next.length,
    firstUuid: next[0]?.uuid as UUID | undefined,
    recordedLength: previous.length,
    recordedFirstUuid: previous[0]?.uuid as UUID | undefined,
  })
}

describe('planTranscriptWrite', () => {
  test('writes only the new tail when messages are appended', () => {
    const head = makeMessage('first')
    const previous = [head, makeMessage('second')]
    const next = [...previous, makeMessage('third')]

    expect(planFor(previous, next)).toMatchObject({
      isIncremental: true,
      startIndex: 2,
      skip: false,
    })
  })

  test('rewrites from the start when compaction changes the head', () => {
    const previous = [makeMessage('old head'), makeMessage('body')]
    const next = [makeMessage('compact boundary'), makeMessage('summary')]

    expect(planFor(previous, next)).toMatchObject({
      isIncremental: false,
      startIndex: 0,
      skip: false,
    })
  })

  test('treats a same-head shrink as a full rewrite, not an append', () => {
    // Tombstone filter, rewind, snip, partial-compact.
    const head = makeMessage('head')
    const previous = [head, makeMessage('a'), makeMessage('b')]
    const next = [head, makeMessage('a')]

    expect(planFor(previous, next)).toMatchObject({
      isSameHeadShrink: true,
      isIncremental: false,
      startIndex: 0,
    })
  })

  test('writes the whole array on the very first render', () => {
    const next = [makeMessage('first'), makeMessage('second')]

    expect(planFor([], next)).toMatchObject({
      wasFirstRender: true,
      startIndex: 0,
      skip: false,
    })
  })
})

describe('compaction replay through the REPL call site', () => {
  /**
   * Fullscreen keeps the pre-compact scrollback, so when compaction replays
   * `messagesToKeep` those uuids are already in the array.
   */
  test('a replay replaces in place instead of rendering the message twice', () => {
    const head = makeMessage('head')
    const kept = makeMessage('tool call', {
      toolUseResult: { stdout: 'x'.repeat(4096) },
    })
    const before: Message[] = [head, kept]

    const after = upsertMessageByUuid(before, stripToolUseResult(kept))

    expect(after).toHaveLength(2)
    expect(after.filter(m => m.uuid === kept.uuid)).toHaveLength(1)
    expect(after[1]).not.toHaveProperty('toolUseResult')
  })

  test('the replay produces no transcript write, deliberately', () => {
    // The array is the same length with the same head, so the effect returns
    // before touching the transcript. That is correct, not a hole:
    //   - recordTranscript skips any uuid it has already written and has no
    //     update path at all (transcriptWriter.ts);
    //   - the entry on disk is the PRE-strip one, `toolUseResult` intact. The
    //     transcript is the archive; stripping is an in-memory optimization.
    //     Persisting the stripped copy would delete tool output from /resume
    //     and from exports to reclaim memory that was already reclaimed.
    const head = makeMessage('head')
    const kept = makeMessage('tool call', { toolUseResult: { stdout: 'big' } })
    const before: Message[] = [head, kept]
    const after = upsertMessageByUuid(before, stripToolUseResult(kept))

    expect(planFor(before, after).skip).toBe(true)
  })

  test('appending the replay instead would have written duplicates', () => {
    // The pre-upsert behaviour, kept as the counter-example: a plain append
    // grew the array, which reads as an incremental render and sends the
    // duplicate uuids to recordTranscript (where they are dedup-skipped) while
    // the REPL renders the message twice.
    const head = makeMessage('head')
    const kept = makeMessage('tool call', { toolUseResult: { stdout: 'big' } })
    const before: Message[] = [head, kept]
    const appended = [...before, stripToolUseResult(kept)]

    expect(appended.filter(m => m.uuid === kept.uuid)).toHaveLength(2)
    expect(planFor(before, appended)).toMatchObject({
      isIncremental: true,
      skip: false,
    })
  })

  test('a message re-emitted by reference costs no render at all', () => {
    const messages: Message[] = [makeMessage('head'), makeMessage('body')]

    expect(upsertMessageByUuid(messages, messages[1]!)).toBe(messages)
  })

  test('a genuinely new message after a replay still reaches the transcript', () => {
    const head = makeMessage('head')
    const kept = makeMessage('tool call', { toolUseResult: { stdout: 'big' } })
    const afterReplay = upsertMessageByUuid(
      [head, kept],
      stripToolUseResult(kept),
    )

    const withNew = upsertMessageByUuid(afterReplay, makeMessage('next turn'))

    expect(planFor(afterReplay, withNew)).toMatchObject({
      isIncremental: true,
      startIndex: 2,
      skip: false,
    })
  })
})
