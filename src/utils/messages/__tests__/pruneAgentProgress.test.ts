import { afterEach, describe, expect, test } from 'bun:test'
import type { Message } from '../../../types/message.js'
import {
  pruneFinishedAgentProgress,
  resolvedToolUseIDsIn,
  retainedAgentProgressCount,
} from '../pruneAgentProgress.js'

const saved = process.env.CLAUDE_CODE_AGENT_PROGRESS_RETAIN
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CODE_AGENT_PROGRESS_RETAIN
  else process.env.CLAUDE_CODE_AGENT_PROGRESS_RETAIN = saved
})

function agentProgress(toolUseID: string, n: number): Message[] {
  return Array.from(
    { length: n },
    (_, i) =>
      ({
        type: 'progress',
        parentToolUseID: toolUseID,
        uuid: `p-${toolUseID}-${i}`,
        data: { type: 'agent_progress', message: { seq: i } },
      }) as unknown as Message,
  )
}

function bashProgress(toolUseID: string): Message {
  return {
    type: 'progress',
    parentToolUseID: toolUseID,
    uuid: `bash-${toolUseID}`,
    data: { type: 'bash_progress' },
  } as unknown as Message
}

function assistant(id: string): Message {
  return {
    type: 'assistant',
    uuid: id,
    message: { content: [] },
  } as unknown as Message
}

function toolResult(...ids: string[]): Message {
  return {
    type: 'user',
    uuid: `res-${ids.join('-')}`,
    message: {
      content: ids.map(id => ({
        type: 'tool_result',
        tool_use_id: id,
        content: 'ok',
      })),
    },
  } as unknown as Message
}

describe('resolvedToolUseIDsIn', () => {
  test('extracts tool_use ids from a tool_result message', () => {
    expect(resolvedToolUseIDsIn(toolResult('a', 'b'))).toEqual(['a', 'b'])
  })

  test('returns nothing for assistant messages or plain user text', () => {
    expect(resolvedToolUseIDsIn(assistant('x'))).toEqual([])
    expect(
      resolvedToolUseIDsIn({
        type: 'user',
        message: { content: 'hello' },
      } as unknown as Message),
    ).toEqual([])
  })
})

describe('pruneFinishedAgentProgress', () => {
  test('keeps only the tail for a finished agent', () => {
    const messages = [assistant('a'), ...agentProgress('t1', 100)]
    const pruned = pruneFinishedAgentProgress(messages, ['t1'], 20)

    const kept = pruned.filter(m => m.type === 'progress')
    expect(kept).toHaveLength(20)
    // The tail survives — how the agent ended is what people look for.
    expect((kept[0] as unknown as { uuid: string }).uuid).toBe('p-t1-80')
    expect((kept.at(-1) as unknown as { uuid: string }).uuid).toBe('p-t1-99')
    expect(pruned[0]).toBe(messages[0])
  })

  test('an agent shorter than the cap is untouched, by identity', () => {
    // The overwhelming majority of agents land here: no copy, no behavior change.
    const messages = [assistant('a'), ...agentProgress('t1', 5)]
    expect(pruneFinishedAgentProgress(messages, ['t1'], 20)).toBe(messages)
  })

  test('does not touch a still-running agent', () => {
    const messages = [
      ...agentProgress('running', 100),
      ...agentProgress('done', 100),
    ]
    const pruned = pruneFinishedAgentProgress(messages, ['done'], 10)

    expect(
      pruned.filter(
        m => (m as { parentToolUseID?: string }).parentToolUseID === 'running',
      ),
    ).toHaveLength(100)
    expect(
      pruned.filter(
        m => (m as { parentToolUseID?: string }).parentToolUseID === 'done',
      ),
    ).toHaveLength(10)
  })

  test('leaves non-agent progress alone', () => {
    // bash/mcp ticks are already replaced in place upstream; double-handling
    // them here would drop the single tick the UI renders.
    const messages = [bashProgress('t1'), ...agentProgress('t1', 50)]
    const pruned = pruneFinishedAgentProgress(messages, ['t1'], 5)

    expect(
      pruned.filter(
        m => (m as { data?: { type?: string } }).data?.type === 'bash_progress',
      ),
    ).toHaveLength(1)
    expect(
      pruned.filter(
        m =>
          (m as { data?: { type?: string } }).data?.type === 'agent_progress',
      ),
    ).toHaveLength(5)
  })

  test('prunes several agents finishing in one message', () => {
    // Head-pinned: index 0 belongs to t1 and is never dropped, so t1 keeps
    // 1 + 3 and t2 keeps 3.
    const messages = [
      assistant('head'),
      ...agentProgress('t1', 40),
      ...agentProgress('t2', 40),
    ]
    const pruned = pruneFinishedAgentProgress(messages, ['t1', 't2'], 3)
    expect(pruned).toHaveLength(7)
    expect(
      pruned.filter(
        m => (m as { parentToolUseID?: string }).parentToolUseID === 't1',
      ),
    ).toHaveLength(3)
    expect(
      pruned.filter(
        m => (m as { parentToolUseID?: string }).parentToolUseID === 't2',
      ),
    ).toHaveLength(3)
  })

  test('a tool_result with no trail returns the same array — the hot path', () => {
    // Every tool_result reaches this function, and almost none own a trail.
    // Returning a copy here would defeat the render memoization on every Read
    // and Bash call in the session.
    const messages = [assistant('a'), ...agentProgress('t1', 100)]
    expect(pruneFinishedAgentProgress(messages, ['not-an-agent'], 5)).toBe(
      messages,
    )
  })

  test('no finished ids is a no-op by identity', () => {
    const messages = agentProgress('t1', 100)
    expect(pruneFinishedAgentProgress(messages, [], 5)).toBe(messages)
  })

  test('retain 0 drops a finished trail entirely', () => {
    const messages = [assistant('a'), ...agentProgress('t1', 30)]
    expect(pruneFinishedAgentProgress(messages, ['t1'], 0)).toHaveLength(1)
  })

  test('env override controls the cap; garbage falls back to the default', () => {
    process.env.CLAUDE_CODE_AGENT_PROGRESS_RETAIN = '7'
    expect(retainedAgentProgressCount()).toBe(7)
    process.env.CLAUDE_CODE_AGENT_PROGRESS_RETAIN = '0'
    expect(retainedAgentProgressCount()).toBe(0)
    process.env.CLAUDE_CODE_AGENT_PROGRESS_RETAIN = 'lots'
    expect(retainedAgentProgressCount()).toBe(20)
  })
})

describe('transcript-writer safety', () => {
  test('never drops index 0 — the head uuid is how a shrink is told from a compaction', () => {
    // useLogMessages compares messages[0].uuid to classify the change. A moved
    // head routes a prune through the compaction branch, which rebuilds the
    // transcript parent chain on different assumptions.
    const messages = agentProgress('t1', 100)
    const pruned = pruneFinishedAgentProgress(messages, ['t1'], 5)

    expect(pruned[0]).toBe(messages[0])
    expect(pruned).toHaveLength(6) // the pinned head + the 5-entry tail
  })
})
