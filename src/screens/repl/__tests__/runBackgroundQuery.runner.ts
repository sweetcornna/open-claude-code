import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  enqueuePendingNotification,
  getCommandQueue,
  resetCommandQueue,
} from '../../../utils/session/messageQueueManager.js'
import {
  type BackgroundQueryContext,
  runBackgroundQuery,
} from '../runBackgroundQuery.js'

beforeEach(() => resetCommandQueue())
afterEach(() => resetCommandQueue())

test('preparation failure preserves the foreground query and queued notifications', async () => {
  const abortController = new AbortController()
  const notification = {
    value: '<task-notification>done</task-notification>',
    mode: 'task-notification' as const,
    priority: 'later' as const,
  }
  enqueuePendingNotification(notification)

  runBackgroundQuery({
    abortController,
    appendSystemPrompt: undefined,
    canUseTool: undefined,
    customSystemPrompt: undefined,
    getToolUseContext: () => {
      throw new Error('context initialization failed')
    },
    mainLoopModel: 'test-model',
    mainThreadAgentDefinition: undefined,
    messagesRef: { current: [] },
    setAppState: () => {},
    terminalTitle: 'foreground session',
    toolPermissionContext: {
      additionalWorkingDirectories: new Map(),
    },
  } as unknown as BackgroundQueryContext)

  await new Promise(resolve => setTimeout(resolve, 0))

  expect(abortController.signal.aborted).toBe(false)
  expect(getCommandQueue()).toHaveLength(1)
  expect(getCommandQueue()[0]).toMatchObject(notification)
})
