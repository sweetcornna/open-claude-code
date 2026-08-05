import { describe, expect, mock, test } from 'bun:test'
import type { FSWatcher } from 'fs'
import type { Task } from '../../utils/task/tasks.js'
import { debugMock } from '../../../tests/mocks/debug.js'
import { logMock } from '../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

const { _test } = await import('../useTasksV2.js')

describe('TasksV2Store lifecycle', () => {
  test('an in-flight fetch cannot recreate timers after the last unsubscribe', async () => {
    let resolveTasks: ((tasks: Task[]) => void) | undefined
    const tasksPromise = new Promise<Task[]>(resolve => {
      resolveTasks = resolve
    })
    let closeCount = 0
    const scheduled: Array<ReturnType<typeof setTimeout>> = []

    const store = _test.createStore({
      watch() {
        return {
          close() {
            closeCount++
          },
          unref() {
            return this
          },
        } as unknown as FSWatcher
      },
      getTaskListId: () => 'tasks-v2',
      getTasksDir: () => '/tmp/tasks-v2',
      listTasks: () => tasksPromise,
      onTasksUpdated: () => () => {},
      resetTaskList: async () => {},
      setTimeout(callback) {
        const timer = {
          callback,
          unref() {
            return this
          },
        } as unknown as ReturnType<typeof setTimeout>
        scheduled.push(timer)
        return timer
      },
      clearTimeout(timer) {
        const index = scheduled.indexOf(timer)
        if (index >= 0) scheduled.splice(index, 1)
      },
    })

    const unsubscribe = store.subscribe(() => {})
    unsubscribe()
    expect(closeCount).toBe(1)

    resolveTasks?.([
      {
        id: '1',
        subject: 'pending',
        description: '',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      },
    ])
    await Promise.resolve()
    await Promise.resolve()

    expect(scheduled).toHaveLength(0)
  })

  // A synchronous subagent gets the whole TaskCreate/Update/List/Get set and
  // getTaskListId() has no agent dimension, so its private breakdown lands in
  // the user's own task directory. TaskCreate now tags those; this store — the
  // one behind the REPL/Spinner task UI — must drop them.
  test('subagent-tagged tasks never reach the main session task list', async () => {
    const listed: Task[] = [
      {
        id: '1',
        subject: 'user task',
        description: '',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      },
      {
        id: '2',
        subject: 'subagent bookkeeping',
        description: '',
        status: 'pending',
        blocks: [],
        blockedBy: [],
        metadata: { _agentId: 'agent-9' },
      },
      {
        id: '3',
        subject: 'internal',
        description: '',
        status: 'pending',
        blocks: [],
        blockedBy: [],
        metadata: { _internal: true },
      },
    ]

    const store = _test.createStore({
      watch() {
        return {
          close() {},
          unref() {
            return this
          },
        } as unknown as FSWatcher
      },
      getTaskListId: () => 'tasks-v2-filter',
      getTasksDir: () => '/tmp/tasks-v2-filter',
      listTasks: async () => listed,
      onTasksUpdated: () => () => {},
      resetTaskList: async () => {},
      setTimeout(callback) {
        return {
          callback,
          unref() {
            return this
          },
        } as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout() {},
    })

    const unsubscribe = store.subscribe(() => {})
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(store.getSnapshot()?.map(t => t.id)).toEqual(['1'])
    unsubscribe()
  })
})

describe('TasksV2Store hide-timer recheck', () => {
  type HarnessOptions = {
    listed: Task[]
    onReset?: (taskListId: string) => void
  }

  /**
   * Drives the store to the point where the hide timer fires. setTimeout is
   * captured so the test can invoke the callback synchronously instead of
   * waiting HIDE_DELAY_MS.
   */
  async function runHideTimer({ listed, onReset }: HarnessOptions): Promise<{
    hidden: boolean
    resetCalls: string[]
  }> {
    const resetCalls: string[] = []
    const timers: Array<() => void> = []

    const store = _test.createStore({
      watch() {
        return {
          close() {},
          unref() {
            return this
          },
        } as unknown as FSWatcher
      },
      getTaskListId: () => 'hide-timer-list',
      getTasksDir: () => '/tmp/hide-timer-list',
      listTasks: async () => listed,
      onTasksUpdated: () => () => {},
      resetTaskList: async id => {
        resetCalls.push(id)
        onReset?.(id)
      },
      setTimeout(callback) {
        timers.push(callback)
        return {
          unref() {
            return this
          },
        } as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout() {},
    })

    const unsubscribe = store.subscribe(() => {})
    // Let the initial #fetch resolve so the hide timer gets scheduled.
    for (let i = 0; i < 6; i++) await Promise.resolve()

    // Fire every scheduled callback; the hide timer is among them.
    for (const fire of timers) fire()
    for (let i = 0; i < 6; i++) await Promise.resolve()

    const hidden = store.getSnapshot() === undefined
    unsubscribe()
    return { hidden, resetCalls }
  }

  function completedUserTask(): Task {
    return {
      id: '1',
      subject: 'user task',
      description: '',
      status: 'completed',
      blocks: [],
      blockedBy: [],
    }
  }

  test('a subagent in-progress task does not pin the finished panel open', async () => {
    // The recheck used to run on the UNFILTERED list, so one in-progress
    // subagent task made allStillCompleted false forever and the user's
    // completed todo panel never went away.
    const { hidden } = await runHideTimer({
      listed: [
        completedUserTask(),
        {
          id: '2',
          subject: 'subagent still working',
          description: '',
          status: 'in_progress',
          blocks: [],
          blockedBy: [],
          metadata: { _agentId: 'agent-9' },
        },
      ],
    })

    expect(hidden).toBe(true)
  })

  test('reset is skipped while any subagent task exists, so live task files survive', async () => {
    // resetTaskList() unlinks every *.json in the directory — including the
    // ones a running subagent is still writing.
    const { hidden, resetCalls } = await runHideTimer({
      listed: [
        completedUserTask(),
        {
          id: '2',
          subject: 'subagent still working',
          description: '',
          status: 'in_progress',
          blocks: [],
          blockedBy: [],
          metadata: { _agentId: 'agent-9' },
        },
      ],
    })

    expect(resetCalls).toEqual([])
    expect(hidden).toBe(true)
  })

  test('reset still runs when nothing is agent-scoped', async () => {
    const { hidden, resetCalls } = await runHideTimer({
      listed: [completedUserTask()],
    })

    expect(resetCalls).toEqual(['hide-timer-list'])
    expect(hidden).toBe(true)
  })
})
