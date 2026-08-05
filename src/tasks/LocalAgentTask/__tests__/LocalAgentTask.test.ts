import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { stateMockWith } from '../../../../tests/mocks/state.js'
import { setupAnalyticsMock } from '../../../../tests/mocks/analytics.js'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { setupMessageQueueManagerMock } from '../../../../tests/mocks/messageQueueManager.js'
import { setupSessionStorageMock } from '../../../../tests/mocks/sessionStorage.js'
import { setupTaskDiskOutputMock } from '../../../../tests/mocks/taskDiskOutput.js'

// ─── Mocks ───
//
// The four shared mocks below are complete-surface. They used to be
// hand-written partial ones (4 / 4 / 1 / 6 exports); because Bun's mock.module
// is process-global and last-write-wins, those erased ~60 / 12 / 23 other
// exports for every file loaded later in the same process — co-running this
// file with src/components/tasks/*.test.tsx died on
// "Export named 'getTranscriptPathForSession' not found".
//
// Timing follows the documented pattern: setup() installs the all-real
// delegating surface at module load, overrides are installed in beforeAll and
// dropped in afterAll, so they apply to THIS file's tests and no one else's.
// Delegation resolves at call time, so importing the module under test before
// beforeAll runs is safe.

const noop = () => {}

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

const sessionStorageMock = setupSessionStorageMock()
const diskOutputMock = setupTaskDiskOutputMock()
const messageQueueManagerMock = setupMessageQueueManagerMock()
// The real analytics module is an inert no-op shell, so no overrides needed —
// this exists purely to stop a hand-rolled partial surface from drifting.
const analyticsMock = setupAnalyticsMock()

// Capture enqueuePendingNotification calls for verification
const enqueuedNotifications: string[] = []
const enqueuedCommands: any[] = []

beforeAll(() => {
  sessionStorageMock.set({
    getAgentTranscriptPath: (id: string) => `/tmp/transcripts/${id}.jsonl`,
    recordSidechainTranscript: async () => {},
    recordQueueOperation: async () => {},
    writeAgentMetadata: async () => {},
  })
  diskOutputMock.set({
    evictTaskOutput: async () => {},
    getTaskOutputPath: (id: string) => `/tmp/output/${id}`,
    initTaskOutputAsSymlink: async () => '',
    getTaskOutputDelta: async () => ({ content: '', newOffset: 0 }),
  })
  messageQueueManagerMock.set({
    enqueuePendingNotification: (cmd: any) => {
      enqueuedNotifications.push(cmd.value)
      enqueuedCommands.push(cmd)
    },
  })
})

afterAll(() => {
  sessionStorageMock.reset()
  diskOutputMock.reset()
  messageQueueManagerMock.reset()
  analyticsMock.reset()
})

mock.module(
  'src/bootstrap/state.js',
  stateMockWith({
    getSdkAgentProgressSummariesEnabled: () => false,
    getSessionId: () => 'test-session-001',
    getProjectRoot: () => '/test/project',
    getIsNonInteractiveSession: () => false,
    addSlowOperation: noop,
  }),
)

mock.module('src/services/PromptSuggestion/speculation.js', () => ({
  abortSpeculation: noop,
}))

const cleanupFns: (() => void)[] = []
mock.module('src/utils/process/cleanupRegistry.js', () => ({
  registerCleanup: () => noop,
}))

mock.module('src/utils/process/abortController.js', () => ({
  createAbortController: () => new AbortController(),
  createChildAbortController: (parent: AbortController) => {
    const ac = new AbortController()
    parent.signal.addEventListener('abort', () => ac.abort())
    return ac
  },
}))

mock.module('src/utils/task/sdkProgress.js', () => ({
  emitTaskProgress: noop,
}))

mock.module('src/utils/session/sdkEventQueue.js', () => ({
  enqueueSdkEvent: noop,
}))

// src/constants/xml.js is deliberately NOT mocked. It is a pure data module
// (CLAUDE.md: don't mock those), its old 10-key partial surface broke every
// later import of the other tags in the same process, and its snake_case stubs
// didn't even match the real kebab-case wire format — so the assertions below
// were pinning a shape production never emits.

mock.module('src/utils/session/collapseReadSearch.js', () => ({
  getSearchExtraToolsOrReadInfo: () => undefined,
}))

// ─── Import after mocks ───

const {
  createProgressTracker,
  updateProgressFromMessage,
  getProgressUpdate,
  completeAgentTask,
  failAgentTask,
  killAsyncAgent,
  enqueueAgentNotification,
  registerAsyncAgent,
  updateAgentProgress,
  updateAgentSummary,
  isLocalAgentTask,
} = await import('../LocalAgentTask.js')

// ─── Helpers ───

type AppStateLike = { tasks: Record<string, any> }
type SetAppStateLike = (f: (prev: AppStateLike) => AppStateLike) => void

function createSetAppState(initial: AppStateLike = { tasks: {} }): {
  setAppState: SetAppStateLike
  getState: () => AppStateLike
} {
  let state = initial
  return {
    setAppState: f => {
      state = f(state)
    },
    getState: () => state,
  }
}

function makeRunningTask(overrides: Record<string, any> = {}): any {
  return {
    id: 'test-agent-001',
    type: 'local_agent',
    status: 'running',
    description: 'Test agent',
    agentId: 'test-agent-001',
    prompt: 'do something',
    agentType: 'general-purpose',
    abortController: new AbortController(),
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    notified: false,
    startTime: Date.now(),
    outputFile: '/tmp/output/test-agent-001',
    outputOffset: 0,
    ...overrides,
  }
}

function makeAssistantMessage(usage: any, content: any[] = []): any {
  return {
    type: 'assistant',
    message: {
      usage,
      content,
    },
  }
}

afterEach(() => {
  enqueuedNotifications.length = 0
  enqueuedCommands.length = 0
})

// ─── Tests ───

describe('createProgressTracker', () => {
  test('returns initial state with zero counts', () => {
    const tracker = createProgressTracker()
    expect(tracker.toolUseCount).toBe(0)
    expect(tracker.latestInputTokens).toBe(0)
    expect(tracker.cumulativeOutputTokens).toBe(0)
    expect(tracker.recentActivities).toEqual([])
  })
})

describe('updateProgressFromMessage', () => {
  test('skips non-assistant messages', () => {
    const tracker = createProgressTracker()
    updateProgressFromMessage(tracker, { type: 'user', message: {} } as any)
    expect(tracker.toolUseCount).toBe(0)
    expect(tracker.latestInputTokens).toBe(0)
  })

  test('updates token counts from assistant message usage', () => {
    const tracker = createProgressTracker()
    const msg = makeAssistantMessage({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
    })
    updateProgressFromMessage(tracker, msg)
    expect(tracker.latestInputTokens).toBe(150) // 100 + 20 + 30
    expect(tracker.cumulativeOutputTokens).toBe(50)
  })

  test('counts tool_use blocks and tracks recent activities', () => {
    const tracker = createProgressTracker()
    const msg = makeAssistantMessage({ input_tokens: 0, output_tokens: 0 }, [
      { type: 'tool_use', name: 'Read', input: { file_path: '/foo.ts' } },
      { type: 'text', text: 'thinking...' },
      { type: 'tool_use', name: 'Write', input: { file_path: '/bar.ts' } },
    ])
    updateProgressFromMessage(tracker, msg)
    expect(tracker.toolUseCount).toBe(2)
    expect(tracker.recentActivities).toHaveLength(2)
    expect(tracker.recentActivities[0]!.toolName).toBe('Read')
    expect(tracker.recentActivities[1]!.toolName).toBe('Write')
  })

  test('caps recentActivities at 5', () => {
    const tracker = createProgressTracker()
    for (let i = 0; i < 7; i++) {
      const msg = makeAssistantMessage({ input_tokens: 0, output_tokens: 0 }, [
        { type: 'tool_use', name: `Tool${i}`, input: {} },
      ])
      updateProgressFromMessage(tracker, msg)
    }
    expect(tracker.recentActivities).toHaveLength(5)
  })

  test('skips without usage', () => {
    const tracker = createProgressTracker()
    const msg = makeAssistantMessage(null)
    updateProgressFromMessage(tracker, msg)
    expect(tracker.latestInputTokens).toBe(0)
  })
})

describe('getProgressUpdate', () => {
  test('returns correct progress snapshot', () => {
    const tracker = createProgressTracker()
    tracker.toolUseCount = 3
    tracker.latestInputTokens = 100
    tracker.cumulativeOutputTokens = 50
    tracker.recentActivities.push({ toolName: 'Read', input: {} })

    const progress = getProgressUpdate(tracker)
    expect(progress.toolUseCount).toBe(3)
    expect(progress.tokenCount).toBe(150)
    expect(progress.lastActivity).toBeDefined()
    expect(progress.lastActivity!.toolName).toBe('Read')
  })

  test('returns undefined lastActivity when no activities', () => {
    const tracker = createProgressTracker()
    const progress = getProgressUpdate(tracker)
    expect(progress.lastActivity).toBeUndefined()
  })
})

describe('completeAgentTask', () => {
  test('transitions running task to completed', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: { 'test-agent-001': makeRunningTask() },
    })

    completeAgentTask(
      {
        agentId: 'test-agent-001',
        content: [],
        totalToolUseCount: 0,
        totalDurationMs: 100,
      } as any,
      setAppState as any,
    )

    const task = getState().tasks['test-agent-001']
    expect(task.status).toBe('completed')
    expect(task.endTime).toBeDefined()
    expect(task.evictAfter).toBeDefined()
  })

  test('no-op if task not running', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: { 'test-agent-001': makeRunningTask({ status: 'completed' }) },
    })

    completeAgentTask(
      {
        agentId: 'test-agent-001',
        content: [],
        totalToolUseCount: 0,
        totalDurationMs: 100,
      } as any,
      setAppState as any,
    )

    const task = getState().tasks['test-agent-001']
    expect(task.status).toBe('completed')
  })
})

describe('failAgentTask', () => {
  test('transitions running task to failed with error message', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: { 'test-agent-001': makeRunningTask() },
    })

    failAgentTask('test-agent-001', 'Stream idle timeout', setAppState as any)

    const task = getState().tasks['test-agent-001']
    expect(task.status).toBe('failed')
    expect(task.error).toBe('Stream idle timeout')
    expect(task.endTime).toBeDefined()
  })

  test('no-op if task not running', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: { 'test-agent-001': makeRunningTask({ status: 'killed' }) },
    })

    failAgentTask('test-agent-001', 'error', setAppState as any)

    const task = getState().tasks['test-agent-001']
    expect(task.status).toBe('killed')
    expect(task.error).toBeUndefined()
  })
})

describe('killAsyncAgent', () => {
  test('transitions running task to killed', () => {
    const ac = new AbortController()
    const cleanup = mock(() => {})
    const { setAppState, getState } = createSetAppState({
      tasks: {
        'test-agent-001': makeRunningTask({
          abortController: ac,
          unregisterCleanup: cleanup,
        }),
      },
    })

    killAsyncAgent('test-agent-001', setAppState as any)

    const task = getState().tasks['test-agent-001']
    expect(task.status).toBe('killed')
    expect(ac.signal.aborted).toBe(true)
    expect(cleanup).toHaveBeenCalled()
    expect(task.abortController).toBeUndefined()
  })

  test('no-op if task not running', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: { 'test-agent-001': makeRunningTask({ status: 'completed' }) },
    })

    killAsyncAgent('test-agent-001', setAppState as any)

    const task = getState().tasks['test-agent-001']
    expect(task.status).toBe('completed')
  })
})

describe('enqueueAgentNotification', () => {
  test('enqueues completed notification with correct XML format', () => {
    const { setAppState } = createSetAppState({
      tasks: { 'test-agent-001': makeRunningTask({ notified: false }) },
    })

    enqueueAgentNotification({
      taskId: 'test-agent-001',
      description: 'refactor auth',
      status: 'completed',
      setAppState: setAppState as any,
      finalMessage: 'Done!',
      usage: { totalTokens: 5000, toolUses: 3, durationMs: 10000 },
    })

    expect(enqueuedNotifications).toHaveLength(1)
    expect(enqueuedNotifications[0]).toContain('<task-notification>')
    expect(enqueuedNotifications[0]).toContain(
      '<task-id>test-agent-001</task-id>',
    )
    expect(enqueuedNotifications[0]).toContain('<status>completed</status>')
    expect(enqueuedNotifications[0]).toContain(
      'Agent "refactor auth" completed',
    )
    expect(enqueuedNotifications[0]).toContain('<result>Done!</result>')
    expect(enqueuedNotifications[0]).toContain(
      '<total_tokens>5000</total_tokens>',
    )
  })

  test('enqueues failed notification with error', () => {
    const { setAppState } = createSetAppState({
      tasks: { 'test-agent-001': makeRunningTask({ notified: false }) },
    })

    enqueueAgentNotification({
      taskId: 'test-agent-001',
      description: 'test',
      status: 'failed',
      error: 'Stream idle timeout',
      setAppState: setAppState as any,
    })

    expect(enqueuedNotifications).toHaveLength(1)
    expect(enqueuedNotifications[0]).toContain('<status>failed</status>')
    expect(enqueuedNotifications[0]).toContain(
      'Agent "test" failed: Stream idle timeout',
    )
  })

  test('enqueues killed notification', () => {
    const { setAppState } = createSetAppState({
      tasks: { 'test-agent-001': makeRunningTask({ notified: false }) },
    })

    enqueueAgentNotification({
      taskId: 'test-agent-001',
      description: 'test',
      status: 'killed',
      setAppState: setAppState as any,
    })

    expect(enqueuedNotifications).toHaveLength(1)
    expect(enqueuedNotifications[0]).toContain('<status>killed</status>')
    expect(enqueuedNotifications[0]).toContain('Agent "test" was stopped')
  })

  test('prevents duplicate notifications', () => {
    const { setAppState } = createSetAppState({
      tasks: { 'test-agent-001': makeRunningTask({ notified: false }) },
    })

    enqueueAgentNotification({
      taskId: 'test-agent-001',
      description: 'test',
      status: 'completed',
      setAppState: setAppState as any,
    })

    // Second call — notified flag already set by first call
    enqueueAgentNotification({
      taskId: 'test-agent-001',
      description: 'test',
      status: 'completed',
      setAppState: setAppState as any,
    })

    expect(enqueuedNotifications).toHaveLength(1)
  })

  test('skips if task already notified', () => {
    const { setAppState } = createSetAppState({
      tasks: { 'test-agent-001': makeRunningTask({ notified: true }) },
    })

    enqueueAgentNotification({
      taskId: 'test-agent-001',
      description: 'test',
      status: 'completed',
      setAppState: setAppState as any,
    })

    expect(enqueuedNotifications).toHaveLength(0)
  })

  // The queue's default for notifications is 'later', which query.ts's
  // mid-turn drain (getCommandsByMaxPriority('next')) filters out — the
  // completion would then sit until the whole turn ended.
  test('enqueues at next priority so the mid-turn drain can pick it up', () => {
    const { setAppState } = createSetAppState({
      tasks: { 'test-agent-001': makeRunningTask({ notified: false }) },
    })

    enqueueAgentNotification({
      taskId: 'test-agent-001',
      description: 'test',
      status: 'completed',
      setAppState: setAppState as any,
    })

    expect(enqueuedCommands).toHaveLength(1)
    expect(enqueuedCommands[0].priority).toBe('next')
    expect(enqueuedCommands[0].mode).toBe('task-notification')
    // Main-thread agents carry no agentId, so the main loop's
    // `cmd.agentId === undefined` filter matches them.
    expect(enqueuedCommands[0].agentId).toBeUndefined()
  })

  test('stamps the parent agentId so nested subagents drain their own notifications', () => {
    const { setAppState } = createSetAppState({
      tasks: { 'test-agent-001': makeRunningTask({ notified: false }) },
    })

    enqueueAgentNotification({
      taskId: 'test-agent-001',
      description: 'test',
      status: 'completed',
      setAppState: setAppState as any,
      agentId: 'parent-agent-42' as any,
    })

    expect(enqueuedCommands).toHaveLength(1)
    expect(enqueuedCommands[0].agentId).toBe('parent-agent-42')
  })
})

describe('isLocalAgentTask', () => {
  test('returns true for local_agent type', () => {
    expect(isLocalAgentTask(makeRunningTask())).toBe(true)
  })

  test('returns false for other types', () => {
    expect(isLocalAgentTask({ type: 'local_bash' })).toBe(false)
  })

  test('returns false for null/undefined', () => {
    expect(isLocalAgentTask(null)).toBe(false)
    expect(isLocalAgentTask(undefined)).toBe(false)
  })
})

describe('updateAgentSummary', () => {
  // Supply side of the recap chain: startAgentSummarization → this →
  // task.progress.summary → useBackgroundAgentTasks → getAgentRowDescription.
  // The AppState write must NOT be gated on the SDK flag (the state mock at the
  // top of this file has getSdkAgentProgressSummariesEnabled → false); only the
  // emitTaskProgress SDK event is, so TUI sessions get the recap while SDK
  // consumers who never opted in stay unaffected.
  test('stores the recap on the running task even with SDK summaries off', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: {
        'test-agent-001': makeRunningTask({
          progress: { toolUseCount: 2, tokenCount: 300 },
        }),
      },
    })

    updateAgentSummary(
      'test-agent-001',
      'Verifying runtime sampler',
      setAppState as any,
    )

    const task = getState().tasks['test-agent-001']
    expect(task.progress.summary).toBe('Verifying runtime sampler')
    // Counters must survive — the row renders elapsed/tokens next to the recap.
    expect(task.progress.toolUseCount).toBe(2)
    expect(task.progress.tokenCount).toBe(300)
  })

  test('no-op once the agent reached a terminal state', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: {
        'test-agent-001': makeRunningTask({
          status: 'completed',
          progress: { toolUseCount: 1, tokenCount: 10 },
        }),
      },
    })

    updateAgentSummary('test-agent-001', 'late summary', setAppState as any)

    expect(getState().tasks['test-agent-001'].progress.summary).toBeUndefined()
  })
})

describe('updateAgentProgress', () => {
  test('updates progress while preserving summary', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: {
        'test-agent-001': makeRunningTask({
          progress: { summary: 'Working on auth' },
        }),
      },
    })

    updateAgentProgress(
      'test-agent-001',
      {
        toolUseCount: 5,
        tokenCount: 1000,
        lastActivity: { toolName: 'Write', input: {} },
      },
      setAppState as any,
    )

    const task = getState().tasks['test-agent-001']
    expect(task.progress.toolUseCount).toBe(5)
    expect(task.progress.tokenCount).toBe(1000)
    expect(task.progress.summary).toBe('Working on auth')
  })

  test('no-op if task not running', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: {
        'test-agent-001': makeRunningTask({
          status: 'completed',
          progress: {},
        }),
      },
    })

    updateAgentProgress(
      'test-agent-001',
      { toolUseCount: 5, tokenCount: 1000 },
      setAppState as any,
    )

    const task = getState().tasks['test-agent-001']
    expect(task.progress.toolUseCount).toBeUndefined()
  })
})
