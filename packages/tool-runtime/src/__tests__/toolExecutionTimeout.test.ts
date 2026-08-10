import { describe, expect, test } from 'bun:test'
import { ToolExecutionTimeoutError } from '../errors.js'
import { callToolWithExecutionTimeout } from '../toolExecutionTimeout.js'

function fakeScheduler() {
  let callback: (() => void) | undefined
  let cleared = false
  return {
    scheduler: {
      setTimeout(next: () => void) {
        callback = next
        return 1
      },
      clearTimeout() {
        cleared = true
      },
    },
    fire() {
      callback?.()
    },
    wasCleared() {
      return cleared
    },
  }
}

describe('callToolWithExecutionTimeout', () => {
  test('aborts only the child context when the deadline expires', async () => {
    const parent = new AbortController()
    const timer = fakeScheduler()
    let childSignal: AbortSignal | undefined

    const pending = callToolWithExecutionTimeout({
      toolName: 'WebSearch',
      timeoutMs: 60_000,
      context: { abortController: parent },
      call: async context => {
        childSignal = context.abortController.signal
        return new Promise<never>(() => {})
      },
      timerScheduler: timer.scheduler,
    })

    timer.fire()

    await expect(pending).rejects.toBeInstanceOf(ToolExecutionTimeoutError)
    expect(parent.signal.aborted).toBe(false)
    expect(childSignal?.aborted).toBe(true)
    expect(childSignal?.reason).toBeInstanceOf(ToolExecutionTimeoutError)
    expect(timer.wasCleared()).toBe(true)
  })

  test('forwards parent cancellation and preserves its reason', async () => {
    const parent = new AbortController()
    const timer = fakeScheduler()
    const reason = new Error('user cancelled')

    const pending = callToolWithExecutionTimeout({
      toolName: 'WebSearch',
      timeoutMs: 60_000,
      context: { abortController: parent },
      call: async context =>
        new Promise<never>((_, reject) => {
          context.abortController.signal.addEventListener(
            'abort',
            () => reject(context.abortController.signal.reason),
            { once: true },
          )
        }),
      timerScheduler: timer.scheduler,
    })

    parent.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(timer.wasCleared()).toBe(true)
  })

  test('suppresses progress emitted after a timed-out call settles', async () => {
    const timer = fakeScheduler()
    const progress: string[] = []
    let emitProgress: ((value: string) => void) | undefined

    const pending = callToolWithExecutionTimeout({
      toolName: 'WebSearch',
      timeoutMs: 60_000,
      context: { abortController: new AbortController() },
      onProgress: (value: string) => progress.push(value),
      call: async (_context, onProgress) => {
        emitProgress = onProgress
        return new Promise<never>(() => {})
      },
      timerScheduler: timer.scheduler,
    })

    timer.fire()
    await expect(pending).rejects.toBeInstanceOf(ToolExecutionTimeoutError)
    emitProgress?.('late update')

    expect(progress).toEqual([])
  })

  test('a non-positive timeout leaves the original context untouched', async () => {
    const parent = new AbortController()
    const timer = fakeScheduler()
    let received: AbortController | undefined

    const result = await callToolWithExecutionTimeout({
      toolName: 'NoLimit',
      timeoutMs: 0,
      context: { abortController: parent },
      call: async context => {
        received = context.abortController
        return 'ok'
      },
      timerScheduler: timer.scheduler,
    })

    expect(result).toBe('ok')
    expect(received).toBe(parent)
    expect(timer.wasCleared()).toBe(false)
  })
})
