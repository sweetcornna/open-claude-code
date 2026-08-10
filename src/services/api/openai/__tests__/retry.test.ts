import { afterEach, describe, expect, test } from 'bun:test'
import {
  createOpenAIResponseError,
  OpenAIRequestError,
  resolveOpenAIMaxRetries,
  retryOpenAIRequest,
} from '../retry.js'

const savedMaxRetries = process.env.OPENAI_REQUEST_MAX_RETRIES

afterEach(() => {
  if (savedMaxRetries === undefined) {
    delete process.env.OPENAI_REQUEST_MAX_RETRIES
  } else {
    process.env.OPENAI_REQUEST_MAX_RETRIES = savedMaxRetries
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
    delete process.env.OPENAI_REQUEST_MAX_RETRIES
    expect(resolveOpenAIMaxRetries()).toBe(10)
  })

  test('fails after ten transient retries (eleven total attempts)', async () => {
    delete process.env.OPENAI_REQUEST_MAX_RETRIES
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
    delete process.env.OPENAI_REQUEST_MAX_RETRIES
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

  test('clamps env retry counts above ten', async () => {
    process.env.OPENAI_REQUEST_MAX_RETRIES = '999'
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
    expect(resolveOpenAIMaxRetries()).toBe(10)
    expect(calls).toBe(11)
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

  test('retries 425 Too Early', async () => {
    let calls = 0
    await retryOpenAIRequest(
      async () => {
        calls++
        return requireSuccess(
          new Response(calls === 1 ? 'too early' : 'ok', {
            status: calls === 1 ? 425 : 200,
          }),
        )
      },
      { signal: new AbortController().signal, delay: noDelay },
    )
    expect(calls).toBe(2)
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

  test('gives up on a Retry-After longer than the ladder can wait', async () => {
    // The regression: this used to clamp a 2-hour Retry-After down to 60s and
    // retry anyway, so the request came back too early to succeed, ten times
    // over — ten minutes of blocking before the same failure. Callers cannot
    // always cancel out of that: findRelevantMemories and autoMode pass no
    // AbortSignal.
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

  test('gives up on a long retry-after-ms too', async () => {
    let calls = 0
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
        { signal: new AbortController().signal, delay: noDelay },
      ),
    ).rejects.toThrow('rate limited')

    expect(calls).toBe(1)
  })

  test('caps the exponential backoff so late retries stay bounded', async () => {
    // Uncapped, 200 * 2^n spends its last three waits at ~26s, ~51s and ~102s —
    // nearly three minutes inside a single sleep on a ten-retry ladder whose
    // whole purpose is to outlast a blip.
    delete process.env.OPENAI_REQUEST_MAX_RETRIES
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
    // 32s ceiling, +10% jitter at random() === 1.
    expect(Math.max(...delays)).toBe(35_200)
    // The early rungs are untouched: 200ms, 400ms, 800ms...
    expect(delays.slice(0, 3)).toEqual([220, 440, 880])
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

  test('does not retry auth, permission, model, or other permanent 4xx errors', async () => {
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
      expect(calls).toBe(1)
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

  test('does not retry deterministic TLS behind transient fetch wording', async () => {
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

  test('does not retry a permanent synthetic API error', async () => {
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
