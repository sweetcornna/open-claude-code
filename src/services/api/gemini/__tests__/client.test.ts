import { describe, expect, test } from 'bun:test'
import { streamGeminiGenerateContent } from '../client.js'

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
})
