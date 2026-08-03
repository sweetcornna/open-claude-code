import { describe, expect, test } from 'bun:test'
import type { LogOption } from '../../types/logs.js'
import type { SessionLogResult } from '../../utils/sessionStorage.js'
import { ProgressiveSessionLogLoader } from '../ResumeConversation.js'

function makeLog(firstPrompt: string, value = -1): LogOption {
  return {
    date: '2026-08-03',
    messages: [],
    value,
    created: new Date(0),
    modified: new Date(0),
    firstPrompt,
    messageCount: 0,
    isSidechain: false,
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('ProgressiveSessionLogLoader', () => {
  test('coalesces concurrent reads from the same nextIndex', async () => {
    const loader = new ProgressiveSessionLogLoader()
    const initial = makeLog('initial', 0)
    const next = makeLog('next')
    const source: SessionLogResult = {
      logs: [initial],
      allStatLogs: [initial, next],
      nextIndex: 1,
    }
    const generation = loader.beginSourceLoad()
    expect(loader.commitSource(generation, source)).toBe(true)

    const pending = deferred<{ logs: LogOption[]; nextIndex: number }>()
    let enrichCalls = 0
    const appended: LogOption[] = []
    const enrich = () => {
      enrichCalls++
      return pending.promise
    }

    const first = loader.loadMore(1, enrich, logs => appended.push(...logs))
    const second = loader.loadMore(1, enrich, logs => appended.push(...logs))

    expect(first).toBe(second)
    expect(enrichCalls).toBe(1)

    pending.resolve({ logs: [next], nextIndex: 2 })
    await first!

    expect(appended).toEqual([next])
    expect(next.value).toBe(1)
    expect(source.nextIndex).toBe(2)
  })

  test('drops a progressive result after the data source generation changes', async () => {
    const loader = new ProgressiveSessionLogLoader()
    const oldLog = makeLog('old')
    const oldSource: SessionLogResult = {
      logs: [],
      allStatLogs: [oldLog],
      nextIndex: 0,
    }
    const oldGeneration = loader.beginSourceLoad()
    expect(loader.commitSource(oldGeneration, oldSource)).toBe(true)

    const pending = deferred<{ logs: LogOption[]; nextIndex: number }>()
    const appended: LogOption[] = []
    const oldRead = loader.loadMore(
      1,
      () => pending.promise,
      logs => {
        appended.push(...logs)
      },
    )

    const newLog = makeLog('new', 0)
    const newSource: SessionLogResult = {
      logs: [newLog],
      allStatLogs: [newLog],
      nextIndex: 1,
    }
    const newGeneration = loader.beginSourceLoad()
    expect(loader.commitSource(newGeneration, newSource)).toBe(true)

    pending.resolve({ logs: [oldLog], nextIndex: 1 })
    await oldRead!

    expect(appended).toEqual([])
    expect(oldSource.nextIndex).toBe(0)
  })
})
