import { afterEach, describe, expect, test } from 'bun:test'
import { streamGeminiGenerateContent } from '../client.js'

const savedTimeoutEnv = {
  API_TIMEOUT_MS: process.env.API_TIMEOUT_MS,
  CLAUDE_STREAM_IDLE_TIMEOUT_MS: process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS,
}

afterEach(() => {
  for (const [name, value] of Object.entries(savedTimeoutEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function requestFor(body: string) {
  const fetchOverride = (async () =>
    new Response(body, { status: 200 })) as unknown as typeof fetch
  return streamGeminiGenerateContent({
    model: 'gemini-test',
    body: { contents: [] },
    signal: new AbortController().signal,
    accessToken: 'test-token',
    fetchOverride,
  })
}

async function caughtStreamError(body: string): Promise<unknown> {
  try {
    for await (const _chunk of requestFor(body)) {
      // drain
    }
  } catch (error) {
    return error
  }
  throw new Error('Expected the Gemini stream to fail')
}

describe('streamGeminiGenerateContent error envelopes', () => {
  test('throws structured event:error details', async () => {
    const error = await caughtStreamError(
      'event: error\ndata: {"code":503,"status":"UNAVAILABLE","message":"backend unavailable"}\n\n',
    )

    expect(error).toMatchObject({
      name: 'GeminiStreamError',
      code: 503,
      status: 'UNAVAILABLE',
      message: 'backend unavailable',
    })
  })

  test('throws structured top-level data.error details', async () => {
    const error = await caughtStreamError(
      'data: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota busy"}}\n\n',
    )

    expect(error).toMatchObject({
      name: 'GeminiStreamError',
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'quota busy',
    })
  })

  test('does not drop an unterminated error envelope at EOF', async () => {
    const error = await caughtStreamError(
      'data: {"error":{"code":"INTERNAL","message":"stream failed"}}',
    )

    expect(error).toMatchObject({
      name: 'GeminiStreamError',
      code: 'INTERNAL',
      message: 'stream failed',
    })
  })

  test('marks malformed SSE as retryable', async () => {
    const error = await caughtStreamError('data: {not-json}\n\n')

    expect(error).toMatchObject({
      name: 'GeminiStreamError',
      retryable: true,
    })
  })

  test('marks a successful response without a body as retryable', async () => {
    const stream = streamGeminiGenerateContent({
      model: 'gemini-test',
      body: { contents: [] },
      signal: new AbortController().signal,
      accessToken: 'test-token',
      fetchOverride: (async () =>
        new Response(null, { status: 200 })) as unknown as typeof fetch,
    })

    let error: unknown
    try {
      for await (const _chunk of stream) {
        // drain
      }
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({
      name: 'GeminiStreamError',
      retryable: true,
    })
  })

  test('keeps successful stream chunks unchanged', async () => {
    const chunks = []
    for await (const chunk of requestFor(
      'data: {"candidates":[],"usageMetadata":{"promptTokenCount":1}}\n\ndata: [DONE]\n\n',
    )) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      { candidates: [], usageMetadata: { promptTokenCount: 1 } },
    ])
  })

  test('accepts a candidate finish reason as the terminal event', async () => {
    const chunks = []
    for await (const chunk of requestFor(
      'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
    )) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([{ candidates: [{ finishReason: 'STOP' }] }])
  })

  test('rejects clean EOF without a terminal event', async () => {
    const error = await caughtStreamError(
      'data: {"candidates":[],"usageMetadata":{"promptTokenCount":1}}\n\n',
    )

    expect(error).toMatchObject({
      name: 'GeminiStreamError',
      retryable: true,
    })
  })

  test('preserves a permanent HTTP status when reading the body fails', async () => {
    const response = new Response(null, {
      status: 400,
      statusText: 'Bad Request',
    })
    Object.defineProperty(response, 'text', {
      value: async () => {
        throw new Error('body disconnected')
      },
    })
    const stream = streamGeminiGenerateContent({
      model: 'gemini-test',
      body: { contents: [] },
      signal: new AbortController().signal,
      accessToken: 'test-token',
      fetchOverride: (async () => response) as unknown as typeof fetch,
    })

    let error: unknown
    try {
      for await (const _chunk of stream) {
        // drain
      }
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({
      name: 'GeminiRequestError',
      status: 400,
    })
  })

  test('accepts promptFeedback blockReason as a terminal event', async () => {
    const chunks = []
    for await (const chunk of requestFor(
      'data: {"candidates":[],"promptFeedback":{"blockReason":"SAFETY"}}\n\n',
    )) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      { candidates: [], promptFeedback: { blockReason: 'SAFETY' } },
    ])
  })

  test('times out a pending fetch with a retryable connection error', async () => {
    process.env.API_TIMEOUT_MS = '20'
    let requestSignal: AbortSignal | undefined
    const fetchOverride = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        requestSignal = init?.signal as AbortSignal
        requestSignal.addEventListener(
          'abort',
          () => reject(requestSignal?.reason),
          { once: true },
        )
      })) as unknown as typeof fetch
    const stream = streamGeminiGenerateContent({
      model: 'gemini-test',
      body: { contents: [] },
      signal: new AbortController().signal,
      accessToken: 'test-token',
      fetchOverride,
    })

    let error: unknown
    try {
      await stream.next()
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({
      name: 'GeminiStreamError',
      code: 'ETIMEDOUT',
      retryable: true,
    })
    expect((error as Error).message).toContain('API_TIMEOUT_MS')
    expect(requestSignal?.aborted).toBe(true)
  })

  test('times out a silent reader, cancels it, and releases its lock', async () => {
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '20'
    let cancelled = false
    let cancelReason: unknown
    const body = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelled = true
        cancelReason = reason
      },
    })
    const response = new Response(body)
    const stream = streamGeminiGenerateContent({
      model: 'gemini-test',
      body: { contents: [] },
      signal: new AbortController().signal,
      accessToken: 'test-token',
      fetchOverride: (async () => response) as unknown as typeof fetch,
    })

    let error: unknown
    try {
      await stream.next()
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({
      name: 'GeminiStreamError',
      code: 'ETIMEDOUT',
      retryable: true,
    })
    expect((error as Error).message).toContain('CLAUDE_STREAM_IDLE_TIMEOUT_MS')
    expect(cancelled).toBe(true)
    expect(cancelReason).toBe(error)
    expect(body.locked).toBe(false)
  })

  test('preserves caller cancellation instead of classifying it as timeout', async () => {
    process.env.API_TIMEOUT_MS = '1000'
    const caller = new AbortController()
    const reason = new DOMException('cancelled by user', 'AbortError')
    const stream = streamGeminiGenerateContent({
      model: 'gemini-test',
      body: { contents: [] },
      signal: caller.signal,
      accessToken: 'test-token',
      fetchOverride: ((_: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const signal = init?.signal as AbortSignal
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          })
        })) as unknown as typeof fetch,
    })

    const pending = stream.next()
    caller.abort(reason)

    let error: unknown
    try {
      await pending
    } catch (caught) {
      error = caught
    }
    expect(error).toBe(reason)
  })
})
