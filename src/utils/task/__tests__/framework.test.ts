import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { setupMessageQueueManagerMock } from '../../../../tests/mocks/messageQueueManager.js'
import { setupSdkEventQueueMock } from '../../../../tests/mocks/sdkEventQueue.js'
import { setupTaskDiskOutputMock } from '../../../../tests/mocks/taskDiskOutput.js'

// ─── Mocks ───

const noop = () => {}

mock.module('src/utils/telemetry/debug.ts', debugMock)

// Complete-surface shared mock: the real enqueueSdkEvent drops events outside
// non-interactive sessions, so the capture override stays — but drainSdkEvents
// and emitTaskTerminatedSdk now keep delegating to the real module instead of
// vanishing for every file loaded later in the shard.
const sdkEvents: any[] = []
const sdkEventQueueMock = setupSdkEventQueueMock({
  enqueueSdkEvent: (event: any) => {
    sdkEvents.push(event)
  },
})
afterAll(() => sdkEventQueueMock.reset())

const diskOutputMock = setupTaskDiskOutputMock({
  getTaskOutputPath: (id: string) => `/tmp/output/${id}`,
  getTaskOutputDelta: async () => ({ content: '', newOffset: 0 }),
  evictTaskOutput: async () => {},
  initTaskOutputAsSymlink: async (id: string) => `/tmp/output/${id}`,
})
afterAll(() => diskOutputMock.reset())

// Complete-surface shared mock: a hand-written one-export mock here erased the
// module's other 23 exports for every file loaded later in the same process.
const messageQueueManagerMock = setupMessageQueueManagerMock({
  enqueuePendingNotification: noop,
})
afterAll(() => messageQueueManagerMock.reset())

// ─── Import after mocks ───

const {
  updateTaskState,
  registerTask,
  evictTerminalTask,
  POLL_INTERVAL_MS,
  PANEL_GRACE_MS,
} = await import('../framework.js')

// ─── Helpers ───

function makeTask(overrides: Record<string, any> = {}): any {
  return {
    id: 'task-001',
    type: 'local_agent' as const,
    status: 'running' as const,
    description: 'Test task',
    startTime: Date.now(),
    outputFile: '/tmp/output/task-001',
    outputOffset: 0,
    notified: false,
    ...overrides,
  }
}

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

afterEach(() => {
  sdkEvents.length = 0
})

// Hand the queue module back to its real implementation so later files in this
// process don't inherit our override.
afterAll(() => {
  messageQueueManagerMock.reset()
})

// ─── Tests ───

describe('updateTaskState', () => {
  test('updates task in AppState', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: { 'task-001': makeTask({ status: 'running' }) },
    })

    updateTaskState('task-001', setAppState as any, (task: any) => ({
      ...task,
      status: 'completed',
    }))

    expect(getState().tasks['task-001'].status).toBe('completed')
  })

  test('returns same reference when updater returns same task (no-op)', () => {
    const task = makeTask({ status: 'running' })
    const { setAppState, getState } = createSetAppState({
      tasks: { 'task-001': task },
    })

    updateTaskState('task-001', setAppState as any, (t: any) => t)

    // Should be the exact same reference
    expect(getState().tasks['task-001']).toBe(task)
  })

  test('skips if task not found', () => {
    const { setAppState, getState } = createSetAppState({ tasks: {} })

    updateTaskState('nonexistent', setAppState as any, (t: any) => ({
      ...t,
      status: 'completed',
    }))

    // No crash, tasks unchanged
    expect(Object.keys(getState().tasks)).toHaveLength(0)
  })
})

describe('registerTask', () => {
  test('adds task to AppState.tasks', () => {
    const { setAppState, getState } = createSetAppState()

    registerTask(makeTask(), setAppState as any)

    expect(getState().tasks['task-001']).toBeDefined()
    expect(getState().tasks['task-001'].status).toBe('running')
  })

  test('emits SDK event for new task', () => {
    const { setAppState } = createSetAppState()

    registerTask(makeTask(), setAppState as any)

    expect(sdkEvents).toHaveLength(1)
    expect(sdkEvents[0].subtype).toBe('task_started')
    expect(sdkEvents[0].task_id).toBe('task-001')
  })

  test('merges retain on re-register', () => {
    const { setAppState, getState } = createSetAppState()

    // First registration
    registerTask(makeTask({ retain: true }), setAppState as any)

    // Re-register (resume)
    registerTask(makeTask({ retain: false }), setAppState as any)

    // retain should be preserved from first registration
    expect(getState().tasks['task-001'].retain).toBe(true)
    // Only one SDK event (re-register skips emit)
    expect(sdkEvents).toHaveLength(1)
  })
})

describe('evictTerminalTask', () => {
  test('removes terminal+notified task', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: {
        'task-001': makeTask({
          status: 'completed',
          notified: true,
          evictAfter: Date.now() - 1,
        }),
      },
    })

    evictTerminalTask('task-001', setAppState as any)

    expect(getState().tasks['task-001']).toBeUndefined()
  })

  test('skips if task not terminal', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: { 'task-001': makeTask({ status: 'running', notified: true }) },
    })

    evictTerminalTask('task-001', setAppState as any)

    expect(getState().tasks['task-001']).toBeDefined()
  })

  test('skips if task not notified', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: { 'task-001': makeTask({ status: 'completed', notified: false }) },
    })

    evictTerminalTask('task-001', setAppState as any)

    expect(getState().tasks['task-001']).toBeDefined()
  })

  test('skips if within evictAfter grace period', () => {
    const { setAppState, getState } = createSetAppState({
      tasks: {
        'task-001': makeTask({
          status: 'completed',
          notified: true,
          evictAfter: Date.now() + 60000, // 60s in the future
          retain: false,
        }),
      },
    })

    evictTerminalTask('task-001', setAppState as any)

    expect(getState().tasks['task-001']).toBeDefined()
  })

  test('skips if task not found', () => {
    const { setAppState, getState } = createSetAppState({ tasks: {} })

    evictTerminalTask('nonexistent', setAppState as any)

    // No crash
    expect(Object.keys(getState().tasks)).toHaveLength(0)
  })
})

describe('constants', () => {
  test('POLL_INTERVAL_MS is 1000', () => {
    expect(POLL_INTERVAL_MS).toBe(1000)
  })

  test('PANEL_GRACE_MS is 30000', () => {
    expect(PANEL_GRACE_MS).toBe(30_000)
  })
})
