import { describe, expect, mock, test } from 'bun:test'
import type { APIRetryHost } from '../apiRetry.js'

async function loadFacade() {
  return import(`../apiRetry.ts?case=${Math.random()}`)
}

describe('apiRetry facade', () => {
  test('performs one attempt when no host is registered', async () => {
    const facade = await loadFacade()
    const operation = mock(async (attempt: number) => `attempt ${attempt}`)

    await expect(
      facade.retryAPIRequest(operation, {
        signal: new AbortController().signal,
      }),
    ).resolves.toBe('attempt 0')
    expect(operation).toHaveBeenCalledTimes(1)
  })

  test('delegates retry policy to the registered host', async () => {
    const facade = await loadFacade()
    const host = {
      retry: mock(async operation => operation(2)),
    } satisfies APIRetryHost
    const operation = mock(async (attempt: number) => `attempt ${attempt}`)
    const signal = new AbortController().signal

    facade.registerAPIRetryHost(host)

    await expect(
      facade.retryAPIRequest(operation, { signal, maxRetries: 4 }),
    ).resolves.toBe('attempt 2')
    expect(host.retry).toHaveBeenCalledWith(operation, {
      signal,
      maxRetries: 4,
    })
  })
})
