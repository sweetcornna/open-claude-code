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
const { resolveTaskControlTarget } = await import('../../stopTask.js')

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

describe('run directory and eviction grace', () => {
  test('runDir 由 runsDir + runId 推导（fresh run 用新生成的 task id）', () => {
    const { setAppState, getState } = createSetState()
    const taskId = registerLocalWorkflowTask(setAppState as any, {
      description: 'test',
      workflowName: 'wf',
      workflowFile: '/tmp/wf.ts',
      runsDir: '/proj/.occ/workflow-runs',
    })
    const task = getState().tasks[taskId]
    expect(task.runId).toBe(taskId)
    expect(task.runDir).toBe(`/proj/.occ/workflow-runs/${taskId}`)
  })

  test('resume 保留原 runId，runDir 跟着 runId 走而不是新 task id', () => {
    const { setAppState, getState } = createSetState()
    const taskId = registerLocalWorkflowTask(setAppState as any, {
      description: 'test',
      workflowName: 'wf',
      workflowFile: '/tmp/wf.ts',
      runId: 'w0ldrunid',
      runsDir: '/proj/.occ/workflow-runs',
    })
    const task = getState().tasks[taskId]
    expect(task.runId).toBe('w0ldrunid')
    expect(taskId).not.toBe('w0ldrunid')
    expect(task.runDir).toBe('/proj/.occ/workflow-runs/w0ldrunid')
  })

  test('TaskStop 的 runId 与任一 wrapper id 都解析到当前 running wrapper', () => {
    const { setAppState, getState } = createSetState()
    const originalId = registerLocalWorkflowTask(setAppState as any, {
      description: 'first',
      workflowName: 'wf',
      workflowFile: '/tmp/wf.ts',
    })
    failWorkflowTask(originalId, setAppState as any, 'old generation')
    const activeId = registerLocalWorkflowTask(setAppState as any, {
      description: 'resume',
      workflowName: 'wf',
      workflowFile: '/tmp/wf.ts',
      runId: originalId,
    })

    expect(
      resolveTaskControlTarget(originalId, getState() as any)?.taskId,
    ).toBe(activeId)
    expect(resolveTaskControlTarget(activeId, getState() as any)?.taskId).toBe(
      activeId,
    )
  })

  test('不传 runsDir 时不写 runDir（保持字段可选）', () => {
    const { setAppState, getState } = createSetState()
    const taskId = registerLocalWorkflowTask(setAppState as any, {
      description: 'test',
      workflowName: 'wf',
      workflowFile: '/tmp/wf.ts',
    })
    expect(getState().tasks[taskId].runDir).toBeUndefined()
  })

  test('终态会盖上 evictAfter —— 没有它，任务在完成的那一刻就满足驱逐条件', () => {
    const { setAppState, getState } = createSetState()
    const taskId = registerLocalWorkflowTask(setAppState as any, {
      description: 'test',
      workflowName: 'wf',
      workflowFile: '/tmp/wf.ts',
    })
    expect(getState().tasks[taskId].evictAfter).toBeUndefined()
    failWorkflowTask(taskId, setAppState as any, 'boom')
    expect(getState().tasks[taskId].evictAfter).toBeGreaterThan(Date.now())
  })
})
