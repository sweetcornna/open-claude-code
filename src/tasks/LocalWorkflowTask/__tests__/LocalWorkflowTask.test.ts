import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { setupMessageQueueManagerMock } from '../../../../tests/mocks/messageQueueManager.js'
import { setupTaskDiskOutputMock } from '../../../../tests/mocks/taskDiskOutput.js'

// ─── Mocks（仅 mock 有副作用的依赖链）───

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

// src/utils/session/sdkEventQueue.js is deliberately NOT mocked either: the
// real enqueueSdkEvent returns early outside non-interactive sessions, so the
// old `() => {}` stub changed nothing here while erasing drainSdkEvents and
// emitTaskTerminatedSdk for every file loaded afterwards in the shard.
//
// src/constants/xml.js is deliberately NOT mocked: it is a pure data module
// (CLAUDE.md), and the old 10-key partial surface broke every later import of
// the module's other tags in the same process — mock.module is process-global
// and last-write-wins, so a co-running suite hit
// "Export named 'COMMAND_ARGS_TAG' not found".

// Shared complete-surface mocks: setup() at module load installs the all-real
// delegating surface, overrides live only for this file's tests (beforeAll →
// afterAll). Delegation resolves at call time, so the module under test can be
// imported before beforeAll runs.
const messageQueueManagerMock = setupMessageQueueManagerMock()
const diskOutputMock = setupTaskDiskOutputMock()

beforeAll(() => {
  messageQueueManagerMock.set({ enqueuePendingNotification: () => {} })
  diskOutputMock.set({
    getTaskOutputDelta: async () => ({ content: '', newOffset: 0 }),
    getTaskOutputPath: (id: string) => `/tmp/${id}`,
    evictTaskOutput: async () => {},
    initTaskOutputAsSymlink: async () => '',
  })
})

afterAll(() => {
  messageQueueManagerMock.reset()
  diskOutputMock.reset()
})

// ─── Import after mocks ───

const { registerLocalWorkflowTask, failWorkflowTask } = await import(
  '../LocalWorkflowTask.js'
)

// ─── Helpers ───

type AppStateLike = { tasks: Record<string, any> }
type SetAppStateLike = (f: (prev: AppStateLike) => AppStateLike) => void

function createSetState(): {
  setAppState: SetAppStateLike
  getState: () => AppStateLike
} {
  let state: AppStateLike = { tasks: {} }
  return {
    setAppState: f => {
      state = f(state)
    },
    getState: () => state,
  }
}

// ─── Tests ───

describe('failWorkflowTask', () => {
  test('保存 error 字符串到 state（供 BackgroundTasksDialog 显示失败原因）', () => {
    const { setAppState, getState } = createSetState()
    const taskId = registerLocalWorkflowTask(setAppState as any, {
      description: 'test',
      workflowName: 'wf',
      workflowFile: '/tmp/wf.ts',
    })
    failWorkflowTask(taskId, setAppState as any, 'agent X 抛 Error: boom')
    const task = getState().tasks[taskId]
    expect(task.status).toBe('failed')
    expect(task.error).toBe('agent X 抛 Error: boom')
  })

  test('不传 error 时 state.error 保持 undefined（向后兼容现有调用）', () => {
    const { setAppState, getState } = createSetState()
    const taskId = registerLocalWorkflowTask(setAppState as any, {
      description: 'test',
      workflowName: 'wf',
      workflowFile: '/tmp/wf.ts',
    })
    failWorkflowTask(taskId, setAppState as any)
    const task = getState().tasks[taskId]
    expect(task.status).toBe('failed')
    expect(task.error).toBeUndefined()
  })
})
