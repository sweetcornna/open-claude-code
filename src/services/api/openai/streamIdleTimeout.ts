import { OpenAIRequestError } from './retry.js'

/**
 * How long a streaming response may go without producing anything before it is
 * treated as dead.
 *
 * The SDK-level `timeout` (see `API_TIMEOUT_MS` in client.ts) does not cover
 * this: openai 6.x clears that timer once the fetch promise resolves, i.e. as
 * soon as the response headers arrive. A stream that opens and then stalls has
 * no deadline at all, so a turn — an auto-compact in particular, which the user
 * never asked for and cannot see — waits until Esc.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000

/**
 * Resolve the idle budget from `CLAUDE_STREAM_IDLE_TIMEOUT_MS`.
 *
 * Semantics are the Responses lane's, verbatim, because this function replaced
 * that expression: a non-numeric value **and** `0` both fall back to the 90s
 * default (`Number.parseInt(...) || DEFAULT`), so the variable cannot be used to
 * disable the watchdog. Gemini's own watchdog resolves the same key the same way.
 */
export function resolveStreamIdleTimeoutMs(
  raw: string | undefined = process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS,
): number {
  return Number.parseInt(raw ?? '', 10) || DEFAULT_STREAM_IDLE_TIMEOUT_MS
}

/**
 * The failure a stalled stream raises.
 *
 * Retryable on purpose: `retryThirdPartyEventStream` reads that flag, and an
 * attempt that produced no visible output is safe to re-send. `replayable:
 * false` is for the callers whose partial output has already reached the
 * reader — passing `replayable: true` (or omitting it) leaves the default.
 */
export function streamIdleTimeoutError(
  label: string,
  timeoutMs: number,
  options?: { replayable?: boolean },
): OpenAIRequestError {
  return new OpenAIRequestError(
    `${label} stream idle timeout after ${timeoutMs}ms`,
    {
      retryable: true,
      ...(options?.replayable === false ? { replayable: false } : {}),
    },
  )
}

/**
 * Re-yield `source`, failing the iteration when a single step takes longer than
 * `timeoutMs`.
 *
 * The clock restarts on every chunk, so this bounds silence rather than total
 * duration — a long but productive response is untouched, and a stream that
 * keeps flowing yields exactly the values it always did, in order.
 *
 * `onTimeout` is where the transport actually dies: rejecting the pending read
 * does not close a socket, so the OpenAI-compatible lanes abort their
 * per-attempt `AbortController` there (the Responses lane does the same with
 * its reader). Without it the request would keep draining in the background
 * while the retry ladder started another one.
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  options: {
    timeoutMs: number
    /** Route name used in the error message, e.g. `OpenAI Chat`. */
    label: string
    onTimeout?: (error: OpenAIRequestError) => void
    /** Runs once the iteration ends, however it ends. */
    onClose?: () => void
  },
): AsyncGenerator<T, void> {
  const iterator = source[Symbol.asyncIterator]()

  const step = (): Promise<IteratorResult<T>> =>
    new Promise((resolve, reject) => {
      let settled = false
      const settle = (finish: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        finish()
      }
      const timer = setTimeout(() => {
        const error = streamIdleTimeoutError(options.label, options.timeoutMs)
        settle(() => reject(error))
        options.onTimeout?.(error)
      }, options.timeoutMs)
      // Both handlers are attached up front, so the read this timer abandons
      // cannot surface later as an unhandled rejection.
      iterator.next().then(
        value => settle(() => resolve(value)),
        error => settle(() => reject(error)),
      )
    })

  try {
    while (true) {
      const result = await step()
      if (result.done) return
      yield result.value
    }
  } finally {
    // Close the source the way a `for await` loop would on abrupt completion.
    // Not awaited: an async generator queues `return()` behind the read that
    // just timed out, and that read is exactly the one that never settles.
    void Promise.resolve(iterator.return?.()).catch(() => {})
    options.onClose?.()
  }
}
