import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../tests/mocks/log'
import { debugMock } from '../../tests/mocks/debug'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

import { fixtureUuid } from '../../tests/mocks/fixtures/conversation.js'
import type { Message } from '../types/message.js'
import type { CompactionResult } from '../services/compact/compact.js'
import {
  type AppliedCompaction,
  applyCompaction,
  recordCompactionFailure,
} from '../query.js'

const BOUNDARY = fixtureUuid(1)
const SUMMARY = fixtureUuid(2)

function compactionResult(): CompactionResult {
  return {
    boundaryMarker: {
      type: 'system',
      uuid: BOUNDARY,
      timestamp: '2026-01-01T00:00:00.000Z',
      subtype: 'compact_boundary',
      content: '',
      isMeta: true,
      compactMetadata: { trigger: 'auto', preTokens: 1000 },
    } as unknown as CompactionResult['boundaryMarker'],
    summaryMessages: [
      {
        type: 'user',
        uuid: SUMMARY,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'summary' },
      },
    ] as unknown as CompactionResult['summaryMessages'],
    attachments: [],
    hookResults: [],
    messagesToKeep: [],
  }
}

async function drain(
  gen: ReturnType<typeof applyCompaction>,
): Promise<{ yielded: Message[]; returned: AppliedCompaction }> {
  const yielded: Message[] = []
  let step = await gen.next()
  while (!step.done) {
    yielded.push(step.value)
    step = await gen.next()
  }
  return { yielded, returned: step.value }
}

type Overrides = Partial<Parameters<typeof applyCompaction>[0]>

function run(overrides: Overrides = {}) {
  return applyCompaction({
    compactionResult: compactionResult(),
    preCompactMessages: [],
    originalMessageCount: 12,
    trigger: 'predictive',
    taskBudget: undefined,
    taskBudgetRemaining: undefined,
    queryChainId: 'chain-1' as never,
    queryDepth: 0,
    uuid: () => 'turn-uuid',
    ...overrides,
  })
}

describe('applyCompaction', () => {
  test('yields the post-compact messages', async () => {
    // The caller's history is built from what query() yields, so a compaction
    // that yields nothing is discarded when the turn ends.
    const { yielded } = await drain(run())
    expect(yielded.map(m => m.uuid)).toEqual([BOUNDARY, SUMMARY])
  })

  test('returns the post-compact messages it yielded', async () => {
    const { yielded, returned } = await drain(run())
    expect(returned.messages).toEqual(yielded)
  })

  test('marks tracking compacted even when there was no prior tracking', async () => {
    // The predictive path used to preserve `undefined` here, so the first
    // compaction of a session left autoCompactIfNeeded believing none had
    // ever happened.
    const { returned } = await drain(run())
    expect(returned.tracking).toEqual({
      compacted: true,
      turnId: 'turn-uuid',
      turnCounter: 0,
      consecutiveFailures: 0,
    })
  })

  test('resets the failure count on a successful compaction', async () => {
    const { returned } = await drain(run())
    expect(returned.tracking.consecutiveFailures).toBe(0)
  })

  test('leaves the task budget alone when there is no budget', async () => {
    const { returned } = await drain(run({ taskBudgetRemaining: 42 }))
    expect(returned.taskBudgetRemaining).toBe(42)
  })

  test('seeds the task budget from the total on the first compaction', async () => {
    const { returned } = await drain(
      run({ taskBudget: { total: 5000 }, taskBudgetRemaining: undefined }),
    )
    // No usage-bearing message in preCompactMessages, so nothing is
    // subtracted and the remaining budget is the full total.
    expect(returned.taskBudgetRemaining).toBe(5000)
  })

  test('never drives the task budget below zero', async () => {
    const messages = [
      {
        type: 'assistant',
        uuid: fixtureUuid(9),
        timestamp: '2026-01-01T00:00:00.000Z',
        requestId: 'req_9',
        message: {
          id: 'msg_9',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'x' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 9_000_000,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      } as unknown as Message,
    ]
    const { returned } = await drain(
      run({ taskBudget: { total: 100 }, preCompactMessages: messages }),
    )
    expect(returned.taskBudgetRemaining).toBe(0)
  })
})

describe('recordCompactionFailure', () => {
  test('passes tracking through when there is no failure count', () => {
    const tracking = {
      compacted: true,
      turnId: 't',
      turnCounter: 3,
      consecutiveFailures: 1,
    }
    expect(recordCompactionFailure(tracking, undefined)).toBe(tracking)
  })

  test('leaves undefined tracking undefined when nothing failed', () => {
    expect(recordCompactionFailure(undefined, undefined)).toBeUndefined()
  })

  test('records the failure count so the circuit breaker can trip', () => {
    // Dropping this let a session that cannot be compacted retry compaction
    // on every single turn.
    expect(recordCompactionFailure(undefined, 2)).toEqual({
      compacted: false,
      turnId: '',
      turnCounter: 0,
      consecutiveFailures: 2,
    })
  })

  test('keeps the rest of an existing tracking state', () => {
    const tracking = {
      compacted: true,
      turnId: 'prev',
      turnCounter: 4,
      consecutiveFailures: 1,
    }
    expect(recordCompactionFailure(tracking, 3)).toEqual({
      compacted: true,
      turnId: 'prev',
      turnCounter: 4,
      consecutiveFailures: 3,
    })
  })
})
