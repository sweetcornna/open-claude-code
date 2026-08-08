import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { AppState } from '../../state/AppStateStore.js'
import { debugMock } from '../../../tests/mocks/debug.js'
import { logMock } from '../../../tests/mocks/log.js'
import { setupMessageQueueManagerMock } from '../../../tests/mocks/messageQueueManager.js'
import { setupTaskDiskOutputMock } from '../../../tests/mocks/taskDiskOutput.js'
import { setupTeleportMock } from '../../../tests/mocks/teleport.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

const archivedSessions: string[] = []
const notifications: string[] = []
const teleportMock = setupTeleportMock({
  archiveRemoteSession: async sessionId => {
    archivedSessions.push(sessionId)
  },
})
const messageQueueMock = setupMessageQueueManagerMock({
  enqueuePendingNotification: command => {
    if (typeof command.value === 'string') notifications.push(command.value)
  },
})
const diskOutputMock = setupTaskDiskOutputMock({
  evictTaskOutput: async () => {},
})

const { stopTask } = await import('../stopTask.js')

afterAll(() => {
  teleportMock.reset()
  messageQueueMock.reset()
  diskOutputMock.reset()
})

beforeEach(() => {
  archivedSessions.length = 0
  notifications.length = 0
})

function stateHarness(initial: AppState): {
  getAppState: () => AppState
  setAppState: (updater: (previous: AppState) => AppState) => void
} {
  let state = initial
  return {
    getAppState: () => state,
    setAppState: updater => {
      state = updater(state)
    },
  }
}

function baseTask(id: string, type: 'in_process_teammate' | 'remote_agent') {
  return {
    id,
    type,
    status: 'running' as const,
    description: `task ${id}`,
    startTime: Date.now(),
    outputFile: '/dev/null',
    outputOffset: 0,
    notified: false,
  }
}

describe('stopTask unified cancellation dispatch', () => {
  test('stops an in-process teammate through the task registry', async () => {
    const abortController = new AbortController()
    const task = {
      ...baseTask('teammate-1', 'in_process_teammate'),
      identity: {
        agentId: '',
        agentName: 'worker',
        teamName: '',
        planModeRequired: false,
        parentSessionId: 'leader-session',
      },
      prompt: 'work',
      awaitingPlanApproval: false,
      permissionMode: 'default' as const,
      abortController,
      pendingUserMessages: [],
      isIdle: false,
      shutdownRequested: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
    }
    const harness = stateHarness({
      tasks: { [task.id]: task },
    } as unknown as AppState)

    const result = await stopTask(task.id, harness)

    expect(result).toEqual({
      taskId: task.id,
      taskType: 'in_process_teammate',
      command: task.description,
    })
    expect(abortController.signal.aborted).toBe(true)
    expect(harness.getAppState().tasks[task.id]?.status).toBe('killed')
  })

  test('preserves ultraplan archive, state cleanup, and notifications', async () => {
    const task = {
      ...baseTask('remote-1', 'remote_agent'),
      sessionId: 'session-1',
      isUltraplan: true,
    }
    const harness = stateHarness({
      tasks: { [task.id]: task },
      ultraplanSessionUrl: 'https://example.test/session-1',
      ultraplanPendingChoice: {
        plan: 'plan',
        sessionId: task.sessionId,
        taskId: task.id,
      },
      ultraplanLaunching: true,
    } as unknown as AppState)

    await stopTask(task.id, harness)

    const state = harness.getAppState()
    expect(state.tasks[task.id]?.status).toBe('killed')
    expect(state.ultraplanSessionUrl).toBeUndefined()
    expect(state.ultraplanPendingChoice).toBeUndefined()
    expect(state.ultraplanLaunching).toBeUndefined()
    expect(archivedSessions).toEqual([task.sessionId])
    expect(notifications).toHaveLength(2)
    expect(notifications[0]).toStartWith('Ultraplan stopped.')
  })
})
