import { ToolExecutionTimeoutError } from './errors.js'

type TimeoutContext = {
  abortController: AbortController
}

type TimeoutScheduler = {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

const scheduler: TimeoutScheduler = {
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    timer.unref?.()
    return timer
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export async function callToolWithExecutionTimeout<
  Context extends TimeoutContext,
  Progress,
  Result,
>({
  toolName,
  timeoutMs,
  context,
  onProgress,
  call,
  timerScheduler = scheduler,
}: {
  toolName: string
  timeoutMs: number
  context: Context
  onProgress?: (progress: Progress) => void
  call: (
    context: Context,
    onProgress?: (progress: Progress) => void,
  ) => Promise<Result>
  timerScheduler?: TimeoutScheduler
}): Promise<Result> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return call(context, onProgress)
  }

  const childController = new AbortController()
  const parentSignal = context.abortController.signal
  const forwardParentAbort = (): void => {
    childController.abort(parentSignal.reason)
  }
  if (parentSignal.aborted) {
    forwardParentAbort()
  } else {
    parentSignal.addEventListener('abort', forwardParentAbort, { once: true })
  }

  let acceptsProgress = true
  const guardedProgress = onProgress
    ? (progress: Progress): void => {
        if (acceptsProgress) onProgress(progress)
      }
    : undefined
  const callPromise = call(
    { ...context, abortController: childController },
    guardedProgress,
  )
  void callPromise.catch(() => {})

  let timeoutHandle: unknown
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = timerScheduler.setTimeout(() => {
      const error = new ToolExecutionTimeoutError(toolName, timeoutMs)
      acceptsProgress = false
      reject(error)
      childController.abort(error)
    }, timeoutMs)
  })

  try {
    return await Promise.race([callPromise, timeoutPromise])
  } finally {
    acceptsProgress = false
    timerScheduler.clearTimeout(timeoutHandle)
    parentSignal.removeEventListener('abort', forwardParentAbort)
  }
}
