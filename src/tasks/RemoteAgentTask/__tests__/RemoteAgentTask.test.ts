import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import type { SDKMessage } from '../../../entrypoints/agentSdkTypes.js'
import type { AppState } from '../../../state/AppState.js'
import type { TaskContext } from '../../../Task.js'
import { extractAutofixResultFromLog } from '../../../commands/autofix-pr/extractAutofixResult.js'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { setupMessageQueueManagerMock } from '../../../../tests/mocks/messageQueueManager.js'
import { setupSdkEventQueueMock } from '../../../../tests/mocks/sdkEventQueue.js'
import { setupSessionStorageMock } from '../../../../tests/mocks/sessionStorage.js'
import { setupTaskDiskOutputMock } from '../../../../tests/mocks/taskDiskOutput.js'
import { setupTeleportMock } from '../../../../tests/mocks/teleport.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('bun:bundle', () => ({ feature: () => false }))

const pollRemoteSessionEvents = mock(
  async (): Promise<{
    newEvents: SDKMessage[]
    lastEventId: string | null
    sessionStatus: 'running' | 'archived'
  }> => ({ newEvents: [], lastEventId: null, sessionStatus: 'running' }),
)
const appendedOutput: string[] = []
const notifications: string[] = []

const teleportMock = setupTeleportMock()
const sessionStorageMock = setupSessionStorageMock()
const diskOutputMock = setupTaskDiskOutputMock()
const messageQueueMock = setupMessageQueueManagerMock()
const sdkEventQueueMock = setupSdkEventQueueMock()

let state: AppState
let context: TaskContext
let registerRemoteAgentTask: typeof import('../RemoteAgentTask.js').registerRemoteAgentTask
let registerContentExtractor: typeof import('../RemoteAgentTask.js').registerContentExtractor

beforeAll(async () => {
  teleportMock.set({ pollRemoteSessionEvents })
  sessionStorageMock.set({
    writeRemoteAgentMetadata: async () => {},
    deleteRemoteAgentMetadata: async () => {},
  })
  diskOutputMock.set({
    appendTaskOutput: (_taskId, content) => appendedOutput.push(content),
    evictTaskOutput: async () => {},
    getTaskOutputPath: taskId => `/tmp/${taskId}.output`,
    initTaskOutput: async taskId => `/tmp/${taskId}.output`,
  })
  messageQueueMock.set({
    enqueuePendingNotification: command => {
      if (typeof command.value === 'string') notifications.push(command.value)
    },
  })
  sdkEventQueueMock.set({
    enqueueSdkEvent: () => {},
    emitTaskTerminatedSdk: () => {},
  })

  const sut = await import('../RemoteAgentTask.js')
  registerRemoteAgentTask = sut.registerRemoteAgentTask
  registerContentExtractor = sut.registerContentExtractor
  registerContentExtractor('autofix-pr', extractAutofixResultFromLog)
})

afterAll(() => {
  teleportMock.reset()
  sessionStorageMock.reset()
  diskOutputMock.reset()
  messageQueueMock.reset()
  sdkEventQueueMock.reset()
})

beforeEach(() => {
  state = { tasks: {} } as unknown as AppState
  context = {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: updater => {
      state = updater(state)
    },
  }
  appendedOutput.length = 0
  notifications.length = 0
  pollRemoteSessionEvents.mockClear()
})

function textEvent(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  } as unknown as SDKMessage
}

function todoEvent(
  todos: Array<{
    content: string
    status: 'pending' | 'in_progress' | 'completed'
    activeForm: string
  }>,
): SDKMessage {
  return {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'TodoWrite',
          input: { todos },
        },
      ],
    },
  } as unknown as SDKMessage
}

function currentTask(
  taskId: string,
): import('../RemoteAgentTask.js').RemoteAgentTaskState {
  return state.tasks[
    taskId
  ] as import('../RemoteAgentTask.js').RemoteAgentTaskState
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for remote task polling')
    await Bun.sleep(10)
  }
}

describe('long-running remote task log retention', () => {
  test('retains 200 events while preserving rich content, Todo state, and full disk output', async () => {
    const todo = {
      content: 'Keep monitoring',
      status: 'in_progress' as const,
      activeForm: 'Monitoring',
    }
    const rich = '<autofix-result>early complete result</autofix-result>'
    const firstBatch = [
      textEvent(rich),
      todoEvent([todo]),
      ...Array.from({ length: 203 }, (_, i) => textEvent(`filler-${i}`)),
    ]
    pollRemoteSessionEvents
      .mockImplementationOnce(async () => ({
        newEvents: firstBatch,
        lastEventId: 'batch-1',
        sessionStatus: 'running',
      }))
      .mockImplementationOnce(async () => ({
        newEvents: [],
        lastEventId: 'batch-1',
        sessionStatus: 'archived',
      }))

    const handle = registerRemoteAgentTask({
      remoteTaskType: 'autofix-pr',
      session: { id: 'remote-session', title: 'Autofix monitor' },
      command: '/autofix-pr 42',
      context,
      isLongRunning: true,
    })

    await waitFor(
      () => currentTask(handle.taskId).logEventCount === firstBatch.length,
    )
    const running = currentTask(handle.taskId)
    expect(running.log).toHaveLength(200)
    expect(running.todoList).toEqual([todo])
    expect(appendedOutput.join('')).toContain(rich)
    expect(appendedOutput.join('')).toContain('filler-202')

    await waitFor(() => currentTask(handle.taskId).status === 'completed')
    const completed = currentTask(handle.taskId)
    expect(completed.log).toHaveLength(200)
    expect(completed.logEventCount).toBe(firstBatch.length)
    expect(completed.todoList).toEqual([todo])
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toContain(rich)
    handle.cleanup()
  })

  test('an explicit empty TodoWrite list clears the retained Todo state', async () => {
    const todo = {
      content: 'Temporary item',
      status: 'pending' as const,
      activeForm: 'Working on temporary item',
    }
    pollRemoteSessionEvents
      .mockImplementationOnce(async () => ({
        newEvents: [todoEvent([todo])],
        lastEventId: 'todo-1',
        sessionStatus: 'running',
      }))
      .mockImplementationOnce(async () => ({
        newEvents: [todoEvent([])],
        lastEventId: 'todo-2',
        sessionStatus: 'archived',
      }))

    const handle = registerRemoteAgentTask({
      remoteTaskType: 'remote-agent',
      session: { id: 'todo-session', title: 'Todo monitor' },
      command: 'monitor todos',
      context,
      isLongRunning: true,
    })

    await waitFor(() => currentTask(handle.taskId).todoList.length === 1)
    await waitFor(() => currentTask(handle.taskId).status === 'completed')
    expect(currentTask(handle.taskId).todoList).toEqual([])
    handle.cleanup()
  })

  test('does not trim Ultraplan or remote-review logs', async () => {
    for (const flags of [{ isUltraplan: true }, { isRemoteReview: true }]) {
      const events = Array.from({ length: 205 }, (_, i) =>
        textEvent(`event-${i}`),
      )
      pollRemoteSessionEvents.mockImplementationOnce(async () => ({
        newEvents: events,
        lastEventId: 'complete',
        sessionStatus: 'archived',
      }))

      const handle = registerRemoteAgentTask({
        remoteTaskType: flags.isUltraplan ? 'ultraplan' : 'ultrareview',
        session: { id: 'untrimmed-session', title: 'Untrimmed session' },
        command: 'run',
        context,
        isLongRunning: true,
        ...flags,
      })

      await waitFor(() => currentTask(handle.taskId).status === 'completed')
      expect(currentTask(handle.taskId).log).toHaveLength(events.length)
      expect(currentTask(handle.taskId).logEventCount).toBe(events.length)
      handle.cleanup()
    }
  })
})
