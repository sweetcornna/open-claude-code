import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import type { AppState } from '../../../state/AppState.js'
import type { SetAppState, TaskContext } from '../../../Task.js'
import type {
  ExecResult,
  ShellCommand,
} from '../../../utils/shell/ShellCommand.js'
import { setupCleanupRegistryMock } from '../../../../tests/mocks/cleanupRegistry.js'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { setupMessageQueueManagerMock } from '../../../../tests/mocks/messageQueueManager.js'
import { setupSpeculationMock } from '../../../../tests/mocks/speculation.js'
import { setupTaskDiskOutputMock } from '../../../../tests/mocks/taskDiskOutput.js'

mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

const activeCleanups = new Set<object>()
const cleanupRegistryMock = setupCleanupRegistryMock()
const diskOutputMock = setupTaskDiskOutputMock()
const messageQueueManagerMock = setupMessageQueueManagerMock()
const speculationMock = setupSpeculationMock()

let LocalShellTask: typeof import('../LocalShellTask.js').LocalShellTask
let spawnShellTask: typeof import('../LocalShellTask.js').spawnShellTask

beforeAll(async () => {
  cleanupRegistryMock.set({
    registerCleanup: () => {
      const registration = {}
      activeCleanups.add(registration)
      return () => {
        activeCleanups.delete(registration)
      }
    },
  })
  diskOutputMock.set({
    evictTaskOutput: async () => {},
    getTaskOutputPath: taskId => `/tmp/${taskId}.output`,
  })
  messageQueueManagerMock.set({ enqueuePendingNotification: () => {} })
  speculationMock.set({ abortSpeculation: () => {} })
  ;({ LocalShellTask, spawnShellTask } = await import('../LocalShellTask.js'))
})

beforeEach(() => {
  activeCleanups.clear()
})

afterAll(() => {
  cleanupRegistryMock.reset()
  diskOutputMock.reset()
  messageQueueManagerMock.reset()
  speculationMock.reset()
})

type DeferredShell = {
  shellCommand: ShellCommand
  resolveResult: (result: ExecResult) => void
}

function makeShellCommand(taskId: string): DeferredShell {
  let resolveResult!: (result: ExecResult) => void
  const result = new Promise<ExecResult>(resolve => {
    resolveResult = resolve
  })
  const shellCommand = {
    background: mock(() => true),
    result,
    kill: mock(() => {}),
    status: 'running',
    cleanup: mock(() => {}),
    taskOutput: {
      taskId,
      flush: mock(async () => {}),
    },
  } as unknown as ShellCommand
  return { shellCommand, resolveResult }
}

function makeState(): {
  context: TaskContext
  getState: () => AppState
} {
  let state = { tasks: {} } as AppState
  const setAppState: SetAppState = updater => {
    state = updater(state)
  }
  return {
    context: {
      abortController: new AbortController(),
      getAppState: () => state,
      setAppState,
    },
    getState: () => state,
  }
}

async function settleResultHandler(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('spawnShellTask cleanup lifecycle', () => {
  for (const [code, status] of [
    [0, 'completed'],
    [2, 'failed'],
  ] as const) {
    test(`unregisters cleanup when a task becomes ${status}`, async () => {
      const taskId = `task-${status}`
      const { shellCommand, resolveResult } = makeShellCommand(taskId)
      const { context, getState } = makeState()

      await spawnShellTask(
        { command: 'true', description: status, shellCommand },
        context,
      )
      expect(activeCleanups.size).toBe(1)

      resolveResult({ stdout: '', stderr: '', code, interrupted: false })
      await settleResultHandler()

      expect(getState().tasks[taskId]?.status).toBe(status)
      expect(activeCleanups.size).toBe(0)
    })
  }

  test('keeps cleanup unregistered when a killed task receives a late result', async () => {
    const taskId = 'task-killed'
    const { shellCommand, resolveResult } = makeShellCommand(taskId)
    const { context, getState } = makeState()

    await spawnShellTask(
      { command: 'sleep 10', description: 'killed', shellCommand },
      context,
    )
    expect(activeCleanups.size).toBe(1)

    await LocalShellTask.kill(taskId, context.setAppState)
    expect(getState().tasks[taskId]?.status).toBe('killed')
    expect(activeCleanups.size).toBe(0)

    resolveResult({ stdout: '', stderr: '', code: 143, interrupted: true })
    await settleResultHandler()

    expect(getState().tasks[taskId]?.status).toBe('killed')
    expect(activeCleanups.size).toBe(0)
  })
})
