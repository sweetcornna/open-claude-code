import { describe, expect, mock, test } from 'bun:test'
import type { FSWatcher } from 'fs'
import { debugMock } from '../../../tests/mocks/debug.js'
import { logMock } from '../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

const { _test } = await import('../useTaskListWatcher.js')

function fakeWatcher(): FSWatcher {
  return {
    close() {},
    unref() {
      return this
    },
  } as unknown as FSWatcher
}

describe('useTaskListWatcher setup', () => {
  test('waits for directory creation before watching', async () => {
    const order: string[] = []
    let finishEnsure: (() => void) | undefined
    const ensureFinished = new Promise<void>(resolve => {
      finishEnsure = resolve
    })

    const watcherPromise = _test.startTaskWatcher(
      'tasks-1',
      () => {},
      () => false,
      {
        async ensureTasksDir() {
          order.push('ensure-start')
          await ensureFinished
          order.push('ensure-finish')
        },
        getTasksDir: () => '/tmp/tasks-1',
        watch() {
          order.push('watch')
          return fakeWatcher()
        },
      },
    )

    expect(order).toEqual(['ensure-start'])
    finishEnsure?.()
    await watcherPromise

    expect(order).toEqual(['ensure-start', 'ensure-finish', 'watch'])
  })

  test('does not create a watcher after disposal during mkdir', async () => {
    let disposed = false
    let watched = false
    let finishEnsure: (() => void) | undefined
    const ensureFinished = new Promise<void>(resolve => {
      finishEnsure = resolve
    })

    const watcherPromise = _test.startTaskWatcher(
      'tasks-2',
      () => {},
      () => disposed,
      {
        ensureTasksDir: () => ensureFinished,
        getTasksDir: () => '/tmp/tasks-2',
        watch() {
          watched = true
          return fakeWatcher()
        },
      },
    )

    disposed = true
    finishEnsure?.()

    expect(await watcherPromise).toBeNull()
    expect(watched).toBe(false)
  })
})
