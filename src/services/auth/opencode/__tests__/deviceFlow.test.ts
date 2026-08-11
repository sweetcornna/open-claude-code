/**
 * The device flow is pure transport, so these tests stub `fetch` directly
 * rather than mocking a module — nothing here touches the config dir, and the
 * sleep is injected so polling runs at full speed.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  OpencodeAuthError,
  fetchAccount,
  pollForTokens,
  refreshTokens,
  requestDeviceCode,
  resolveVerificationUrl,
  type DeviceCodeGrant,
} from '../deviceFlow.js'

type Handler = (
  url: string,
  body: unknown,
) => { status?: number; json: unknown }

const realFetch = globalThis.fetch
const calls: { url: string; body: unknown }[] = []

function stubFetch(handler: Handler): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })
    const { status = 200, json } = handler(url, body)
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
  calls.length = 0
})

const noSleep = async (): Promise<void> => {}

const SERVER = 'https://console.example.test'

describe('resolveVerificationUrl', () => {
  test('joins the server-relative URI the console actually returns', () => {
    expect(resolveVerificationUrl(SERVER, '/device?user_code=RWTD-JXVR')).toBe(
      `${SERVER}/device?user_code=RWTD-JXVR`,
    )
  })

  test('leaves an absolute URI alone', () => {
    expect(resolveVerificationUrl(SERVER, 'https://other.test/device')).toBe(
      'https://other.test/device',
    )
  })
})

describe('requestDeviceCode', () => {
  test('reads the grant and makes the verification URL absolute', async () => {
    stubFetch(() => ({
      json: {
        device_code: 'dev-1',
        user_code: 'RWTD-JXVR',
        verification_uri: '/device',
        verification_uri_complete: '/device?user_code=RWTD-JXVR',
        expires_in: 900,
        interval: 5,
      },
    }))

    const grant = await requestDeviceCode(SERVER)

    expect(grant.deviceCode).toBe('dev-1')
    expect(grant.userCode).toBe('RWTD-JXVR')
    expect(grant.verificationUrl).toBe(`${SERVER}/device?user_code=RWTD-JXVR`)
    expect(grant.intervalMs).toBe(5000)
    expect(calls[0]?.body).toEqual({ client_id: 'opencode-cli' })
  })

  test('throws when the console rejects the request', async () => {
    stubFetch(() => ({ status: 400, json: { error: 'invalid_client' } }))
    await expect(requestDeviceCode(SERVER)).rejects.toThrow(OpencodeAuthError)
  })
})

const grant: DeviceCodeGrant = {
  deviceCode: 'dev-1',
  userCode: 'RWTD-JXVR',
  verificationUrl: `${SERVER}/device`,
  expiresAt: Date.now() + 900_000,
  intervalMs: 1,
}

describe('pollForTokens', () => {
  test('keeps polling through authorization_pending', async () => {
    let attempts = 0
    stubFetch(() => {
      attempts += 1
      if (attempts < 3) return { json: { error: 'authorization_pending' } }
      return {
        json: {
          access_token: 'acc',
          refresh_token: 'ref',
          expires_in: 3600,
        },
      }
    })

    const tokens = await pollForTokens(grant, {
      server: SERVER,
      sleep: noSleep,
    })

    expect(attempts).toBe(3)
    expect(tokens.accessToken).toBe('acc')
    expect(tokens.refreshToken).toBe('ref')
    expect(tokens.expiresAt).toBeGreaterThan(Date.now())
  })

  test('widens the interval on slow_down instead of failing', async () => {
    const waits: number[] = []
    let attempts = 0
    stubFetch(() => {
      attempts += 1
      if (attempts === 1) return { json: { error: 'slow_down' } }
      return { json: { access_token: 'a', refresh_token: 'r' } }
    })

    await pollForTokens(grant, {
      server: SERVER,
      sleep: async ms => {
        waits.push(ms)
      },
    })

    expect(waits[0]).toBe(1)
    expect(waits[1]).toBe(1 + 5000)
  })

  test('surfaces a terminal error rather than spinning', async () => {
    stubFetch(() => ({ json: { error: 'access_denied' } }))

    await expect(
      pollForTokens(grant, { server: SERVER, sleep: noSleep }),
    ).rejects.toThrow(/access_denied/)
  })

  test('stops at the deadline', async () => {
    stubFetch(() => ({ json: { error: 'authorization_pending' } }))

    await expect(
      pollForTokens(grant, {
        server: SERVER,
        sleep: noSleep,
        deadline: Date.now() - 1,
      }),
    ).rejects.toThrow(/timed out/)
  })
})

describe('refreshTokens', () => {
  test('sends the refresh grant and returns the new pair', async () => {
    stubFetch(() => ({
      json: { access_token: 'a2', refresh_token: 'r2', expires_in: 60 },
    }))

    const tokens = await refreshTokens('r1', SERVER)

    expect(tokens.accessToken).toBe('a2')
    expect(calls[0]?.body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'r1',
      client_id: 'opencode-cli',
    })
  })

  test('throws when the console will not renew', async () => {
    stubFetch(() => ({ status: 400, json: { error: 'invalid_grant' } }))
    await expect(refreshTokens('r1', SERVER)).rejects.toThrow(OpencodeAuthError)
  })
})

describe('fetchAccount', () => {
  test('picks the first org by name and keeps the email', async () => {
    stubFetch(url => {
      if (url.endsWith('/api/user'))
        return { json: { id: 'u', email: 'a@b.c' } }
      return {
        json: [
          { id: 'o2', name: 'Zulu' },
          { id: 'o1', name: 'Alpha' },
        ],
      }
    })

    expect(await fetchAccount('tok', SERVER)).toEqual({
      email: 'a@b.c',
      orgId: 'o1',
      orgName: 'Alpha',
    })
  })

  test('a console that will not describe the token is not fatal', async () => {
    stubFetch(() => ({ status: 500, json: {} }))
    expect(await fetchAccount('tok', SERVER)).toEqual({})
  })
})
