import { afterEach, describe, expect, test } from 'bun:test'
import {
  createOpenAIResponseError,
  OpenAIRequestError,
  parseRetryAfterFromErrorPayload,
  resolveOpenAIMaxRetries,
  retryOpenAIRequest,
} from '../retry.js'

const savedMaxRetries = process.env.CLAUDE_CODE_MAX_RETRIES

afterEach(() => {
  if (savedMaxRetries === undefined) {
    delete process.env.CLAUDE_CODE_MAX_RETRIES
  } else {
    process.env.CLAUDE_CODE_MAX_RETRIES = savedMaxRetries
  }
})

const noDelay = async (): Promise<void> => {}

async function requireSuccess(response: Response): Promise<Response> {
  if (!response.ok) {
    throw await createOpenAIResponseError(response, 'Responses API')
  }
  return response
}

describe('retryOpenAIRequest', () => {
  test('defaults to ten retries after the initial attempt', () => {
    delete process.env.CLAUDE_CODE_MAX_RETRIES
    expect(resolveOpenAIMaxRetries()).toBe(10)
  })

  test('fails after ten transient retries (eleven total attempts)', async () => {
    delete process.env.CLAUDE_CODE_MAX_RETRIES
    let calls = 0

    await expect(
      retryOpenAIRequest(
        async () => {
          calls++
          throw new TypeError('fetch failed')
        },
        { signal: new AbortController().signal, delay: noDelay },
      ),
    ).rejects.toThrow('fetch failed')
    expect(calls).toBe(11)
  })

  test('can succeed on the tenth retry', async () => {
    delete process.env.CLAUDE_CODE_MAX_RETRIES
    let calls = 0

    const result = await retryOpenAIRequest(
      async () => {
        calls++
        if (calls <= 10) throw new TypeError('fetch failed')
        return 'ok'
      },
      { signal: new AbortController().signal, delay: noDelay },
    )

    expect(result).toBe('ok')
    expect(calls).toBe(11)
  })

  test('clamps env retry counts above fifteen', async () => {
    process.env.CLAUDE_CODE_MAX_RETRIES = '999'
    let calls = 0

    await expect(
      retryOpenAIRequest(
        async () => {
          calls++
          throw new TypeError('fetch failed')
        },
        { signal: new AbortController().signal, delay: noDelay },
      ),
    ).rejects.toThrow('fetch failed')
    expect(resolveOpenAIMaxRetries()).toBe(15)
    expect(calls).toBe(16)
  })

  test('retries two 500 responses before succeeding', async () => {
    let calls = 0
    const response = await retryOpenAIRequest(
      async () => {
        calls++
        return requireSuccess(
          new Response(calls < 3 ? 'retry' : 'ok', {
            status: calls < 3 ? 500 : 200,
          }),
        )
      },
      {
        signal: new AbortController().signal,
        delay: noDelay,
      },
    )

    expect(response.status).toBe(200)
    expect(calls).toBe(3)
  })

  test('retries 429 even when Retry-After is absent', async () => {
    let calls = 0
    await retryOpenAIRequest(
      async () => {
        calls++
        return requireSuccess(
          new Response(calls === 1 ? 'rate limited' : 'ok', {
            status: calls === 1 ? 429 : 200,
          }),
        )
      },
      {
        signal: new AbortController().signal,
        delay: noDelay,
      },
    )
    expect(calls).toBe(2)
  })

  test('does not retry 425 Too Early', async () => {
    let calls = 0
    await expect(
      retryOpenAIRequest(
        async () => {
          calls++
          return requireSuccess(new Response('too early', { status: 425 }))
        },
        { signal: new AbortController().signal, delay: noDelay },
      ),
    ).rejects.toThrow('request failed (425)')
    expect(calls).toBe(1)
  })

  test('honors Retry-After seconds on 429', async () => {
    let calls = 0
    const delays: number[] = []
    await retryOpenAIRequest(
      async () => {
        calls++
        return requireSuccess(
          new Response(calls === 1 ? 'rate limited' : 'ok', {
            status: calls === 1 ? 429 : 200,
            headers: calls === 1 ? { 'Retry-After': '1' } : undefined,
          }),
        )
      },
      {
        signal: new AbortController().signal,
        delay: async delayMs => {
          delays.push(delayMs)
        },
      },
    )

    expect(calls).toBe(2)
    expect(delays).toEqual([1000])
  })

  test('stops immediately when Retry-After exceeds one minute', async () => {
    let calls = 0
    const delays: number[] = []

    await expect(
      retryOpenAIRequest(
        async () => {
          calls++
          return requireSuccess(
            new Response('rate limited', {
              status: 429,
              headers: { 'Retry-After': '7200' },
            }),
          )
        },
        {
          signal: new AbortController().signal,
          delay: async delayMs => {
            delays.push(delayMs)
          },
        },
      ),
    ).rejects.toThrow('Responses API request failed (429)')

    expect(calls).toBe(1)
    expect(delays).toEqual([])
  })

  test('still waits out a Retry-After at the edge of the ceiling', async () => {
    let calls = 0
    const delays: number[] = []
    await retryOpenAIRequest(
      async () => {
        calls++
        return requireSuccess(
          new Response(calls === 1 ? 'rate limited' : 'ok', {
            status: calls === 1 ? 429 : 200,
            headers: calls === 1 ? { 'Retry-After': '60' } : undefined,
          }),
        )
      },
      {
        signal: new AbortController().signal,
        delay: async delayMs => {
          delays.push(delayMs)
        },
      },
    )

    expect(calls).toBe(2)
    expect(delays).toEqual([60_000])
  })

  test('stops immediately for a long retry-after-ms', async () => {
    let calls = 0
    const delays: number[] = []
    await expect(
      retryOpenAIRequest(
        async () => {
          calls++
          throw new OpenAIRequestError('rate limited', {
            retryable: true,
            status: 429,
            headers: new Headers({ 'retry-after-ms': '3600000' }),
          })
        },
        {
          signal: new AbortController().signal,
          delay: async delayMs => {
            delays.push(delayMs)
          },
        },
      ),
    ).rejects.toThrow('rate limited')

    expect(calls).toBe(1)
    expect(delays).toEqual([])
  })

  test('caps the exponential backoff so late retries stay bounded', async () => {
    // Uncapped, 200 * 2^n spends its last three waits at ~26s, ~51s and ~102s —
    // nearly three minutes inside a single sleep on a ten-retry ladder whose
    // whole purpose is to outlast a blip.
    delete process.env.CLAUDE_CODE_MAX_RETRIES
    const delays: number[] = []

    await expect(
      retryOpenAIRequest(
        async () => {
          throw new TypeError('fetch failed')
        },
        {
          signal: new AbortController().signal,
          random: () => 1,
          delay: async delayMs => {
            delays.push(delayMs)
          },
        },
      ),
    ).rejects.toThrow('fetch failed')

    expect(delays).toHaveLength(10)
    // 32s ceiling, +25% jitter at random() === 1.
    expect(Math.max(...delays)).toBe(40_000)
    // The official ladder starts at 500ms and doubles.
    expect(delays.slice(0, 3)).toEqual([625, 1250, 2500])
  })

  test('retains only whitelisted response error fields', async () => {
    const error = await createOpenAIResponseError(
      new Response(
        JSON.stringify({
          error: {
            message: 'backend unavailable',
            type: 'server_error',
            code: 'upstream_failure',
            request_id: 'req_123',
            prompt: 'do not expose',
          },
        }),
        { status: 503 },
      ),
      'Responses API',
    )

    expect(error.message).toBe(
      'Responses API request failed (503): backend unavailable',
    )
    expect(error.message).not.toContain('do not expose')
    expect(error.cause).toEqual({
      message: 'backend unavailable',
      type: 'server_error',
      code: 'upstream_failure',
      request_id: 'req_123',
    })
  })

  test('does not retry a 400 response', async () => {
    let calls = 0
    await expect(
      retryOpenAIRequest(
        async () => {
          calls++
          return requireSuccess(new Response('bad request', { status: 400 }))
        },
        {
          signal: new AbortController().signal,
          delay: noDelay,
        },
      ),
    ).rejects.toThrow('Responses API request failed (400)')
    expect(calls).toBe(1)
  })

  test('does not retry auth, permission, model, or other permanent 4xx', async () => {
    // 401 is the official credential-refresh exception; other 4xx stop.
    for (const status of [400, 401, 402, 403, 404, 413, 422]) {
      let calls = 0
      await expect(
        retryOpenAIRequest(
          async () => {
            calls++
            return requireSuccess(new Response('permanent', { status }))
          },
          {
            signal: new AbortController().signal,
            delay: noDelay,
          },
        ),
      ).rejects.toThrow(`request failed (${status})`)
      expect(calls).toBe(status === 401 ? 11 : 1)
    }
  })

  test('retries statusless API error types and network errno codes', async () => {
    for (const sourceError of [
      Object.assign(new Error('provider failed'), { type: 'server_error' }),
      Object.assign(new Error('provider failed'), { type: 'api_error' }),
      Object.assign(new Error('provider failed'), { code: 'UNAVAILABLE' }),
      Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }),
    ]) {
      let calls = 0
      const result = await retryOpenAIRequest(
        async () => {
          calls++
          if (calls === 1) throw sourceError
          return 'ok'
        },
        {
          signal: new AbortController().signal,
          maxRetries: 1,
          delay: noDelay,
        },
      )
      expect(result).toBe('ok')
      expect(calls).toBe(2)
    }
  })

  test('retries the reported stream_read_error even with legacy replayable=no metadata', async () => {
    let calls = 0
    const reported = new OpenAIRequestError('stream_read_error', {
      retryable: true,
      replayable: false,
      type: 'upstream_error',
      code: 'stream_read_error',
    })

    const result = await retryOpenAIRequest(
      async () => {
        calls++
        if (calls === 1) throw reported
        return 'ok'
      },
      {
        signal: new AbortController().signal,
        maxRetries: 1,
        delay: noDelay,
      },
    )

    expect(result).toBe('ok')
    expect(calls).toBe(2)
  })

  test('keeps deterministic TLS off the ladder despite transient fetch wording', async () => {
    const tls = Object.assign(
      new Error('write EPROTO ssl/tls alert handshake failure'),
      { code: 'EPROTO' },
    )
    const error = new TypeError('fetch failed', { cause: tls })
    let calls = 0
    await expect(
      retryOpenAIRequest(
        async () => {
          calls++
          throw error
        },
        { signal: new AbortController().signal, delay: noDelay },
      ),
    ).rejects.toBe(error)
    expect(calls).toBe(1)
  })

  test('does not retry a provider synthetic non-retryable error', async () => {
    let calls = 0
    await expect(
      retryOpenAIRequest(
        async () => {
          calls++
          throw new OpenAIRequestError('invalid request', { retryable: false })
        },
        { signal: new AbortController().signal, delay: noDelay },
      ),
    ).rejects.toThrow('invalid request')
    expect(calls).toBe(1)
  })

  test('does not call the operation for an already-aborted signal', async () => {
    const controller = new AbortController()
    const reason = new Error('stop')
    controller.abort(reason)
    let calls = 0
    let caught: unknown
    try {
      await retryOpenAIRequest(
        async () => {
          calls++
        },
        { signal: controller.signal, delay: noDelay },
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(reason)
    expect(calls).toBe(0)
  })

  test('does not retry when the first attempt aborts', async () => {
    const controller = new AbortController()
    let calls = 0
    const reason = new DOMException('stopped', 'AbortError')

    await expect(
      retryOpenAIRequest(
        async () => {
          calls++
          controller.abort(reason)
          throw reason
        },
        { signal: controller.signal, delay: noDelay },
      ),
    ).rejects.toBe(reason)
    expect(calls).toBe(1)
  })

  test('throws the final error after retries are exhausted', async () => {
    let calls = 0
    let lastError: Error | undefined
    let caught: unknown
    try {
      await retryOpenAIRequest(
        async () => {
          calls++
          lastError = new TypeError(`fetch failed: network-${calls}`)
          throw lastError
        },
        {
          signal: new AbortController().signal,
          maxRetries: 2,
          delay: noDelay,
        },
      )
    } catch (error) {
      caught = error
    }
    expect(calls).toBe(3)
    expect(caught).toBe(lastError)
  })
})

/**
 * An SSE `response.failed` frame carries no HTTP headers, so a mid-stream rate
 * limit can only state its wait in prose. OpenAI's own client reads it out of
 * the message for that reason (codex-rs/codex-api/src/sse/responses.rs:602-626,
 * `try_parse_retry_after`, gated on `code == "rate_limit_exceeded"`).
 */
describe('parseRetryAfterFromErrorPayload', () => {
  const rateLimited = (message: string) => ({
    code: 'rate_limit_exceeded',
    message,
  })

  test('reads a fractional seconds wait', () => {
    expect(
      parseRetryAfterFromErrorPayload(
        rateLimited(
          'Rate limit reached for gpt-5.5. Please try again in 1.5s. Contact us…',
        ),
      ),
    ).toBe(1500)
  })

  test('reads a milliseconds wait', () => {
    expect(
      parseRetryAfterFromErrorPayload(
        rateLimited('Please try again in 872ms.'),
      ),
    ).toBe(872)
  })

  test('reads the spelled-out unit', () => {
    expect(
      parseRetryAfterFromErrorPayload(
        rateLimited('Please try again in 20 seconds.'),
      ),
    ).toBe(20_000)
  })

  test('is case-insensitive', () => {
    expect(
      parseRetryAfterFromErrorPayload(rateLimited('TRY AGAIN IN 2S')),
    ).toBe(2000)
  })

  test('ignores prose in any other error class', () => {
    // A 400 body is free to mention a wait; that is not a scheduling
    // instruction and must not be able to stall the ladder.
    expect(
      parseRetryAfterFromErrorPayload({
        code: 'invalid_request_error',
        message: 'Please try again in 60s.',
      }),
    ).toBeUndefined()
  })

  test('returns undefined when the message states no wait', () => {
    expect(
      parseRetryAfterFromErrorPayload(
        rateLimited('Rate limit reached for requests.'),
      ),
    ).toBeUndefined()
  })

  test('tolerates a missing or non-string message', () => {
    expect(
      parseRetryAfterFromErrorPayload({ code: 'rate_limit_exceeded' }),
    ).toBeUndefined()
    expect(
      parseRetryAfterFromErrorPayload({
        code: 'rate_limit_exceeded',
        message: 42,
      }),
    ).toBeUndefined()
  })
})
