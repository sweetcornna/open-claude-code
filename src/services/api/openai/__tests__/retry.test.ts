import { describe, expect, test } from 'bun:test'
import { createOpenAIResponseError, retryOpenAIRequest } from '../retry.js'

const noDelay = async (): Promise<void> => {}

async function requireSuccess(response: Response): Promise<Response> {
  if (!response.ok) {
    throw await createOpenAIResponseError(response, 'Responses API')
  }
  return response
}

describe('retryOpenAIRequest', () => {
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

  test('throws the final error after retries are exhausted', async () => {
    let calls = 0
    let lastError: Error | undefined
    let caught: unknown
    try {
      await retryOpenAIRequest(
        async () => {
          calls++
          lastError = new Error(`network-${calls}`)
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
