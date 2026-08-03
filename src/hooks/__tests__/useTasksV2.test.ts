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
})
