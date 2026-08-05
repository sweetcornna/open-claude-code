import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../../tests/mocks/debug.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)

const { completeChatGPTDeviceLogin } = await import('../chatgptAuth.js')

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('ChatGPT device authorization polling', () => {
  test('aborts immediately while sleeping between poll attempts', async () => {
    const controller = new AbortController()
    let fetchCalls = 0

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      fetchCalls += 1
      expect(init?.signal).toBe(controller.signal)
      return new Response(null, { status: 403 })
    }) as unknown as typeof fetch

    const login = completeChatGPTDeviceLogin(
      {
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'TEST-CODE',
        deviceAuthId: 'device-auth-id',
        intervalSeconds: 1,
      },
      controller.signal,
    )

    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fetchCalls).toBe(1)
    const abortStartedAt = Date.now()
    controller.abort()

    let error: unknown
    try {
      await login
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('ChatGPT login cancelled')
    expect(Date.now() - abortStartedAt).toBeLessThan(250)
    expect(fetchCalls).toBe(1)
  }, 2_000)

  test('uses a timeout signal for the token exchange request', async () => {
    let fetchCalls = 0
    let tokenSignal: AbortSignal | null | undefined
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      fetchCalls++
      if (fetchCalls === 1) {
        return Response.json({
          authorization_code: 'authorization-code',
          code_verifier: 'code-verifier',
        })
      }
      tokenSignal = init?.signal
      return new Response('token failure', { status: 500 })
    }) as unknown as typeof fetch

    await expect(
      completeChatGPTDeviceLogin({
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'TEST-CODE',
        deviceAuthId: 'device-auth-id',
        intervalSeconds: 1,
      }),
    ).rejects.toThrow('ChatGPT token request failed (500)')

    expect(fetchCalls).toBe(2)
    expect(tokenSignal).toBeInstanceOf(AbortSignal)
  })
})
