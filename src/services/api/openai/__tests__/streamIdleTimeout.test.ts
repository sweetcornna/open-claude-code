import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  isAPIErrorReplayable,
  isRetryableAPIError,
} from '../../retryClassification.js'
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  resolveStreamIdleTimeoutMs,
  streamIdleTimeoutError,
  withIdleTimeout,
} from '../streamIdleTimeout.js'

const ENV_KEY = 'CLAUDE_STREAM_IDLE_TIMEOUT_MS'

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

describe('resolveStreamIdleTimeoutMs', () => {
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env[ENV_KEY]
    delete process.env[ENV_KEY]
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = saved
  })

  test('defaults to 90s when the variable is unset', () => {
    expect(resolveStreamIdleTimeoutMs()).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
  })

  test('reads the ambient variable', () => {
    process.env[ENV_KEY] = '1500'
    expect(resolveStreamIdleTimeoutMs()).toBe(1500)
  })

  test('falls back for junk and for zero', () => {
    // Pinned deliberately: this is the Responses lane's own expression, so `0`
    // has never been a way to switch the watchdog off, and the chat/Grok lanes
    // must not quietly invent one.
    expect(resolveStreamIdleTimeoutMs('nonsense')).toBe(
      DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    )
    expect(resolveStreamIdleTimeoutMs('0')).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
  })
})

describe('streamIdleTimeoutError', () => {
  test('is retryable and replayable by default', () => {
    const error = streamIdleTimeoutError('OpenAI Chat', 90_000)
    expect(error.message).toBe('OpenAI Chat stream idle timeout after 90000ms')
    expect(isRetryableAPIError(error)).toBe(true)
    expect(isAPIErrorReplayable(error)).toBe(true)
  })

  test('can be pinned non-replayable once output has left', () => {
    const error = streamIdleTimeoutError('OpenAI Responses', 90_000, {
      replayable: false,
    })
    expect(isRetryableAPIError(error)).toBe(true)
    expect(isAPIErrorReplayable(error)).toBe(false)
  })
})

describe('withIdleTimeout', () => {
  test('passes a flowing stream through unchanged', async () => {
    const values = await collect(
      withIdleTimeout(
        (async function* () {
          yield 'a'
          await new Promise(resolve => setTimeout(resolve, 5))
          yield 'b'
          await new Promise(resolve => setTimeout(resolve, 5))
          yield 'c'
        })(),
        { timeoutMs: 200, label: 'Test' },
      ),
    )

    // The clock restarts per chunk, so a slow-but-productive stream is not a
    // stalled one: total elapsed here exceeds no budget that matters.
    expect(values).toEqual(['a', 'b', 'c'])
  })

  test('fails a stream that opens and then stalls', async () => {
    let cancelled = false
    const stalled = (async function* () {
      try {
        yield 'first'
        await new Promise(() => {})
      } finally {
        cancelled = true
      }
    })()

    const timeouts: Error[] = []
    let closed = false
    const seen: string[] = []
    let caught: unknown
    try {
      for await (const value of withIdleTimeout(stalled, {
        timeoutMs: 30,
        label: 'OpenAI Chat',
        onTimeout: error => timeouts.push(error),
        onClose: () => {
          closed = true
        },
      })) {
        seen.push(value)
      }
    } catch (error) {
      caught = error
    }

    expect(seen).toEqual(['first'])
    expect((caught as Error | undefined)?.message).toBe(
      'OpenAI Chat stream idle timeout after 30ms',
    )
    // Retryable and replayable: nothing the reader can see has been produced,
    // so retryThirdPartyEventStream is free to re-send.
    expect(isRetryableAPIError(caught)).toBe(true)
    expect(isAPIErrorReplayable(caught)).toBe(true)
    // The transport hook is the half that actually ends the request; rejecting
    // a pending read closes no socket.
    expect(timeouts).toHaveLength(1)
    expect(closed).toBe(true)
    void cancelled
  })

  test('propagates a source failure without dressing it as a timeout', async () => {
    let caught: unknown
    try {
      await collect(
        withIdleTimeout(
          (async function* () {
            yield 1
            throw new Error('socket reset')
          })(),
          { timeoutMs: 5_000, label: 'Grok' },
        ),
      )
    } catch (error) {
      caught = error
    }
    expect((caught as Error | undefined)?.message).toBe('socket reset')
  })

  test('closes the source when the consumer stops early', async () => {
    let cancelled = false
    const source = (async function* () {
      try {
        yield 1
        yield 2
      } finally {
        cancelled = true
      }
    })()

    for await (const value of withIdleTimeout(source, {
      timeoutMs: 5_000,
      label: 'Grok',
    })) {
      if (value === 1) break
    }
    // Yield to the microtask queue: the source is closed fire-and-forget, for
    // the reason spelled out at the call site.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(cancelled).toBe(true)
  })
})
