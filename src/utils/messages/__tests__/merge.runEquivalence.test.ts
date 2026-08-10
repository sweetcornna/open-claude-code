import { describe, expect, test } from 'bun:test'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.mjs'
import type { Message, UserMessage } from '../../../types/message.js'
import {
  mergeUserMessageRun,
  mergeUserMessages,
  upsertMessageByUuid,
} from '../merge.js'

// Deterministic PRNG — Math.random would make failures unreproducible.
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let uuidCounter = 0
function makeUserMessage(
  content: string | ContentBlockParam[],
  isMeta: boolean,
): UserMessage {
  uuidCounter++
  return {
    type: 'user',
    uuid: `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, '0')}`,
    timestamp: '2026-08-02T00:00:00.000Z',
    isMeta,
    message: { role: 'user', content },
  } as unknown as UserMessage
}

function randomBlocks(rand: () => number, n: number): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = []
  for (let i = 0; i < n; i++) {
    const roll = rand()
    if (roll < 0.5) {
      blocks.push({ type: 'text', text: `t${Math.floor(rand() * 1000)}` })
    } else {
      blocks.push({
        type: 'tool_result',
        tool_use_id: `toolu_${Math.floor(rand() * 1e9)}`,
        content: `r${Math.floor(rand() * 1000)}`,
      } as ContentBlockParam)
    }
  }
  return blocks
}

function randomRun(rand: () => number, length: number): UserMessage[] {
  return Array.from({ length }, () => {
    const isMeta = rand() < 0.4
    // Mix string content and block arrays (including empty arrays)
    if (rand() < 0.3) {
      return makeUserMessage(`s${Math.floor(rand() * 1000)}`, isMeta)
    }
    return makeUserMessage(randomBlocks(rand, Math.floor(rand() * 4)), isMeta)
  })
}

/** The pre-optimization reference: left-fold of pairwise merges. */
function foldOracle(run: UserMessage[]): UserMessage {
  return run.reduce((acc, msg) => mergeUserMessages(acc, msg))
}

describe('upsertMessageByUuid', () => {
  test('appends a message whose uuid is new', () => {
    const original = makeUserMessage('original', false)
    const incoming = makeUserMessage('incoming', false)
    const messages: Message[] = [original]

    const result = upsertMessageByUuid(messages, incoming)

    expect(result).toEqual([original, incoming])
    expect(messages).toEqual([original])
  })

  test('replaces a replayed message in place without duplicating its uuid', () => {
    const original = makeUserMessage('before compaction', false)
    const replayed = {
      ...original,
      message: { ...original.message, content: 'preserved after compaction' },
    } as UserMessage
    const trailing = makeUserMessage('trailing', false)

    const result = upsertMessageByUuid([original, trailing], replayed)

    expect(result).toEqual([replayed, trailing])
    expect(
      result.filter(message => message.uuid === original.uuid),
    ).toHaveLength(1)
  })

  test('drops the payload the compaction replay is there to release', () => {
    // `stripToolUseResults` re-emits messagesToKeep under their original uuids
    // with `toolUseResult` removed, specifically to release large tool payloads
    // from the heap. Swapping the object out is what makes the old one
    // unreachable — keeping the richer entry would quietly undo that.
    const withResult = Object.assign(makeUserMessage('tool output', false), {
      toolUseResult: { stdout: 'x'.repeat(1024) },
    })
    const { toolUseResult: _dropped, ...stripped } = withResult

    const result = upsertMessageByUuid([withResult], stripped as UserMessage)

    expect(result).toHaveLength(1)
    expect(result[0]).not.toBe(withResult)
    expect(result[0]).not.toHaveProperty('toolUseResult')
  })

  test('returns the same array when the same message object is replayed', () => {
    const message = makeUserMessage('same object', false)
    const messages: Message[] = [message]

    expect(upsertMessageByUuid(messages, message)).toBe(messages)
  })
})

describe('mergeUserMessageRun ≡ pairwise fold (oracle)', () => {
  test('random runs: byte-identical output across sizes and seeds', () => {
    for (const seed of [1, 42, 20260802]) {
      const rand = mulberry32(seed)
      for (const length of [1, 2, 3, 5, 20, 80, 200]) {
        const run = randomRun(rand, length)
        const expected = foldOracle(run)
        const actual = mergeUserMessageRun(run)
        expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
      }
    }
  })

  test('directed edge cases match the fold', () => {
    const cases: UserMessage[][] = [
      // text-text seams glue with '\n'
      [makeUserMessage('a', false), makeUserMessage('b', false)],
      // first message ends in tool_result (raw un-hoisted seam on step 1)
      [
        makeUserMessage(
          [
            { type: 'text', text: 'x' },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'r',
            } as ContentBlockParam,
          ],
          false,
        ),
        makeUserMessage('y', false),
        makeUserMessage('z', false),
      ],
      // all-meta run (uuid follows the LAST message)
      [
        makeUserMessage('m1', true),
        makeUserMessage('m2', true),
        makeUserMessage('m3', true),
      ],
      // empty-content members
      [
        makeUserMessage([], false),
        makeUserMessage('after-empty', false),
        makeUserMessage([], false),
      ],
    ]
    for (const run of cases) {
      expect(JSON.stringify(mergeUserMessageRun(run))).toBe(
        JSON.stringify(foldOracle(run)),
      )
    }
  })
})
