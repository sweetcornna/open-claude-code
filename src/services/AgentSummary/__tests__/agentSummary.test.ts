import { beforeEach, describe, expect, test } from 'bun:test'
import { asAgentId } from '../../../types/ids.js'
import type { Message } from '../../../types/message.js'
import type {
  CacheSafeParams,
  ForkedAgentResult,
} from '../../../utils/agents/forkedAgent.js'
import {
  _resetSummaryConcurrencyForTest,
  type AgentSummaryDependencies,
  startAgentSummarization,
} from '../agentSummary.js'

const transcriptMessages = [
  { type: 'user', message: { content: 'start' }, uuid: 'u1' },
  {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'working' }] },
    uuid: 'a1',
  },
  { type: 'user', message: { content: 'continue' }, uuid: 'u2' },
] as unknown as Message[]

type ForkCall = {
  cacheSafeParams: CacheSafeParams
  skipCacheWrite?: boolean
  skipTranscript?: boolean
}

describe('startAgentSummarization', () => {
  let scheduled: (() => void | Promise<void>) | undefined
  let handle: { stop: () => void } | undefined
  let forkCalls: ForkCall[]
  let updateCalls: Array<{ taskId: string; summary: string }>
  let transcriptMessagesForTest: Message[]
  let debugLogs: string[]
  let loggedErrors: Error[]
  let clearedHandles: unknown[]
  let scheduledCount: number
  let lastTimerHandle: unknown

  function startTestSummarization(
    dependencies: AgentSummaryDependencies = {},
  ): { stop: () => void } {
    return startAgentSummarization(
      'task-1',
      asAgentId('a0000000000000000'),
      {
        forkContextMessages: [
          { type: 'user', message: { content: 'stale' }, uuid: 'old' },
        ],
        model: 'claude-test',
      } as unknown as CacheSafeParams,
      () => undefined,
      {
        clearTimeout: ((timeoutId: unknown) => {
          clearedHandles.push(timeoutId)
        }) as typeof clearTimeout,
        getAgentTranscript: async () => ({
          messages: transcriptMessagesForTest,
          contentReplacements: [],
        }),
        isPoorModeActive: () => false,
        logError: error => {
          loggedErrors.push(
            error instanceof Error ? error : new Error(String(error)),
          )
        },
        logForDebugging: message => {
          debugLogs.push(message)
        },
        runForkedAgent: async (args: ForkCall) => {
          forkCalls.push(args)
          return {
            messages: [
              {
                type: 'assistant',
                message: {
                  content: [{ type: 'text', text: 'Reading udsClient.ts' }],
                },
              },
            ],
          } as unknown as ForkedAgentResult
        },
        setTimeout: ((callback: TimerHandler) => {
          if (typeof callback !== 'function') {
            throw new Error('Expected timer callback')
          }
          scheduledCount += 1
          scheduled = callback as () => void | Promise<void>
          lastTimerHandle = { id: scheduledCount }
          return lastTimerHandle as ReturnType<typeof setTimeout>
        }) as unknown as typeof setTimeout,
        updateAgentSummary: (taskId: string, summary: string) => {
          updateCalls.push({ taskId, summary })
        },
        ...dependencies,
      },
    )
  }

  beforeEach(() => {
    forkCalls = []
    updateCalls = []
    scheduled = undefined
    handle = undefined
    transcriptMessagesForTest = transcriptMessages
    debugLogs = []
    loggedErrors = []
    clearedHandles = []
    scheduledCount = 0
    lastTimerHandle = undefined
  })

  function expectDebugLogContaining(fragment: string): void {
    expect(debugLogs.some(message => message.includes(fragment))).toBe(true)
  }

  test('summarizes bounded transcript once and skips unchanged fingerprints', async () => {
    handle = startTestSummarization()

    expect(typeof scheduled).toBe('function')
    await scheduled!()

    expect(forkCalls).toHaveLength(1)
    expect(updateCalls).toEqual([
      { taskId: 'task-1', summary: 'Reading udsClient.ts' },
    ])

    const forkContext = forkCalls[0].cacheSafeParams.forkContextMessages ?? []
    expect(forkContext.map(message => String(message.uuid))).toEqual([
      'u1',
      'a1',
      'u2',
    ])
    expect(forkContext.some(message => String(message.uuid) === 'old')).toBe(
      false,
    )

    await scheduled!()

    expect(forkCalls).toHaveLength(1)
    expect(updateCalls).toHaveLength(1)
    expect(loggedErrors).toEqual([])
  })

  test('skips summarization when filtering leaves too little bounded context', async () => {
    transcriptMessagesForTest = [
      { type: 'user', message: { content: 'start' }, uuid: 'u1' },
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          content: [{ type: 'tool_use', id: 'missing', name: 'Read' }],
        },
      },
      { type: 'user', message: { content: 'continue' }, uuid: 'u2' },
    ] as unknown as Message[]

    handle = startTestSummarization()

    expect(typeof scheduled).toBe('function')
    await scheduled!()

    expect(forkCalls).toEqual([])
    expect(updateCalls).toEqual([])
    expectDebugLogContaining(
      '[AgentSummary] Skipping summary for task-1: no bounded context available',
    )
  })

  test('skips summarization before building context when transcript is too short', async () => {
    transcriptMessagesForTest = transcriptMessages.slice(0, 2)
    handle = startTestSummarization()

    expect(typeof scheduled).toBe('function')
    await scheduled!()

    expect(forkCalls).toEqual([])
    expect(updateCalls).toEqual([])
    expectDebugLogContaining(
      '[AgentSummary] Skipping summary for task-1: not enough messages (2)',
    )
  })

  test('skips and reschedules while poor mode is active', async () => {
    handle = startTestSummarization({
      isPoorModeActive: () => true,
    })

    expect(typeof scheduled).toBe('function')
    const initialScheduledCount = scheduledCount
    const initialTimerHandle = lastTimerHandle
    await scheduled!()

    expect(forkCalls).toEqual([])
    expect(updateCalls).toEqual([])
    expectDebugLogContaining(
      '[AgentSummary] Skipping summary — poor mode active',
    )
    expect(scheduledCount).toBe(initialScheduledCount + 1)
    expect(lastTimerHandle).not.toBe(initialTimerHandle)
  })

  test('logs summary errors and schedules the next timer', async () => {
    const error = new Error('fork failed')
    handle = startTestSummarization({
      runForkedAgent: async () => {
        throw error
      },
    })

    expect(typeof scheduled).toBe('function')
    const initialScheduledCount = scheduledCount
    const initialTimerHandle = lastTimerHandle
    await scheduled!()

    expect(loggedErrors).toEqual([error])
    expect(updateCalls).toEqual([])
    expect(scheduledCount).toBe(initialScheduledCount + 1)
    expect(lastTimerHandle).not.toBe(initialTimerHandle)
  })

  test('stop clears the pending summary timer', () => {
    handle = startTestSummarization()
    const pendingHandle = lastTimerHandle

    handle.stop()

    expectDebugLogContaining('[AgentSummary] Stopping summarization for task-1')
    expect(clearedHandles).toEqual([pendingHandle])
  })
})

describe('summary fork cache behaviour', () => {
  test('asks the fork not to write a cache entry', async () => {
    // The context window is a reverse suffix, so the entry written for this
    // tick can never be read by the next one — writing it is a pure 1.25x
    // premium on tokens nothing will hit.
    const forkCalls: ForkCall[] = []
    let scheduled: (() => void | Promise<void>) | undefined

    startAgentSummarization(
      'task-cache',
      asAgentId('a0000000000000001'),
      { model: 'claude-test' } as unknown as CacheSafeParams,
      () => undefined,
      {
        getAgentTranscript: async () => ({
          messages: transcriptMessages,
          contentReplacements: [],
        }),
        isPoorModeActive: () => false,
        logForDebugging: () => {},
        runForkedAgent: async (args: ForkCall) => {
          forkCalls.push(args)
          return { messages: [] } as unknown as ForkedAgentResult
        },
        setTimeout: ((callback: TimerHandler) => {
          scheduled = callback as () => void | Promise<void>
          return {} as ReturnType<typeof setTimeout>
        }) as unknown as typeof setTimeout,
        updateAgentSummary: () => {},
      },
    )

    await scheduled!()

    expect(forkCalls).toHaveLength(1)
    expect(forkCalls[0].skipCacheWrite).toBe(true)
    // Still ephemeral: no sidechain transcript for the summary conversation.
    expect(forkCalls[0].skipTranscript).toBe(true)
  })
})

describe('global summary fork concurrency cap', () => {
  type Agent = {
    tick: () => Promise<void>
    forkCount: () => number
    releaseFork: () => void
    debugLogs: string[]
  }

  function startAgent(id: string): Agent {
    let scheduled: (() => void | Promise<void>) | undefined
    let release: (() => void) | undefined
    let forks = 0
    const debugLogs: string[] = []

    startAgentSummarization(
      id,
      asAgentId('a0000000000000002'),
      { model: 'claude-test' } as unknown as CacheSafeParams,
      () => undefined,
      {
        getAgentTranscript: async () => ({
          messages: transcriptMessages,
          contentReplacements: [],
        }),
        isPoorModeActive: () => false,
        logForDebugging: message => {
          debugLogs.push(message)
        },
        runForkedAgent: async () => {
          forks++
          // Hang until the test releases it, so the slot stays occupied.
          await new Promise<void>(resolve => {
            release = resolve
          })
          return { messages: [] } as unknown as ForkedAgentResult
        },
        setTimeout: ((callback: TimerHandler) => {
          scheduled = callback as () => void | Promise<void>
          return {} as ReturnType<typeof setTimeout>
        }) as unknown as typeof setTimeout,
        updateAgentSummary: () => {},
      },
    )

    return {
      // Fire the tick without awaiting: the fork deliberately never settles
      // until releaseFork(), which is the whole point of the test.
      tick: async () => {
        void scheduled!()
        // Let runSummary reach the awaited fork.
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      },
      forkCount: () => forks,
      releaseFork: () => release?.(),
      debugLogs,
    }
  }

  beforeEach(() => {
    _resetSummaryConcurrencyForTest()
  })

  test('a third agent skips its tick while two forks are in flight', async () => {
    // N background agents each own an independent 30s timer with no shared
    // schedule, so without a global cap N forks can hit the rate limit at once
    // and compete with the user's own turn.
    const a = startAgent('task-a')
    const b = startAgent('task-b')
    const c = startAgent('task-c')

    await a.tick()
    await b.tick()
    await c.tick()

    expect(a.forkCount()).toBe(1)
    expect(b.forkCount()).toBe(1)
    expect(c.forkCount()).toBe(0)
    expect(
      c.debugLogs.some(m => m.includes('summary forks already in flight')),
    ).toBe(true)

    // Once a slot frees up the skipped agent gets through on its next tick.
    a.releaseFork()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    await c.tick()
    expect(c.forkCount()).toBe(1)

    b.releaseFork()
    c.releaseFork()
  })

  test('the slot is released even when the fork throws', async () => {
    let scheduled: (() => void | Promise<void>) | undefined
    let calls = 0

    startAgentSummarization(
      'task-throw',
      asAgentId('a0000000000000003'),
      { model: 'claude-test' } as unknown as CacheSafeParams,
      () => undefined,
      {
        getAgentTranscript: async () => ({
          messages: transcriptMessages,
          contentReplacements: [],
        }),
        isPoorModeActive: () => false,
        logError: () => {},
        logForDebugging: () => {},
        runForkedAgent: async () => {
          calls++
          throw new Error('fork exploded')
        },
        setTimeout: ((callback: TimerHandler) => {
          scheduled = callback as () => void | Promise<void>
          return {} as ReturnType<typeof setTimeout>
        }) as unknown as typeof setTimeout,
        updateAgentSummary: () => {},
      },
    )

    // Three failing ticks in a row: if the counter leaked on the error path,
    // the cap would be exhausted after two and the third would never fork.
    await scheduled!()
    await scheduled!()
    await scheduled!()

    expect(calls).toBe(3)
  })
})
