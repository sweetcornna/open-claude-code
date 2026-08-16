import { beforeEach, describe, expect, test } from 'bun:test'

const fetchMock = {
  lastUrl: '',
  lastOpts: {} as RequestInit,
  response: { ok: true, status: 200, statusText: 'OK' },
  responseData: {} as unknown,
}

Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  writable: true,
  value: async (url: string, opts: RequestInit) => {
    fetchMock.lastUrl = url
    fetchMock.lastOpts = opts
    return {
      ok: fetchMock.response.ok,
      status: fetchMock.response.status,
      statusText: fetchMock.response.statusText,
      json: async () => fetchMock.responseData,
    } as Response
  },
})

const client = await import('../api/client')
const relayClient = await import('../acp/relay-client')

beforeEach(() => {
  fetchMock.lastUrl = ''
  fetchMock.lastOpts = {}
  fetchMock.response = { ok: true, status: 200, statusText: 'OK' }
  fetchMock.responseData = {}
})

describe('account cookie API', () => {
  test('checks the current account with same-origin credentials', async () => {
    fetchMock.responseData = { user: { id: 'user_1', username: 'cornna' } }

    await client.apiFetchMe()

    expect(fetchMock.lastUrl).toBe('/web/auth/me')
    expect(fetchMock.lastOpts).toMatchObject({
      method: 'GET',
      credentials: 'same-origin',
    })
    expect(fetchMock.lastUrl).not.toContain('uuid')
    expect(fetchMock.lastOpts.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    })
  })

  test('posts login credentials as JSON without a bearer token', async () => {
    fetchMock.responseData = { user: { id: 'user_1', username: 'dev' } }

    await client.apiLogin('dev', 'correct horse battery staple')

    expect(fetchMock.lastUrl).toBe('/web/auth/login')
    expect(fetchMock.lastOpts).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({
        username: 'dev',
        password: 'correct horse battery staple',
      }),
    })
    expect(fetchMock.lastOpts.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    })
    expect(fetchMock.lastOpts.headers).not.toHaveProperty('Authorization')
  })

  test('posts registration credentials as JSON', async () => {
    fetchMock.responseData = { user: { id: 'user_2', username: 'new.dev' } }

    await client.apiRegister('new.dev', 'a long registration password')

    expect(fetchMock.lastUrl).toBe('/web/auth/register')
    expect(fetchMock.lastOpts.credentials).toBe('same-origin')
    expect(fetchMock.lastOpts.body).toBe(
      JSON.stringify({
        username: 'new.dev',
        password: 'a long registration password',
      }),
    )
  })

  test('exchanges only the fragment pairing code under the approved field', async () => {
    fetchMock.responseData = {
      user: { id: 'user_1', username: 'dev' },
      session_id: 'session_7',
    }

    await client.apiPair('pair_secret_once')

    expect(fetchMock.lastUrl).toBe('/web/auth/pair')
    expect(fetchMock.lastOpts.credentials).toBe('same-origin')
    expect(fetchMock.lastOpts.body).toBe(
      JSON.stringify({ code: 'pair_secret_once' }),
    )
  })

  test('logs out through the cookie-authenticated endpoint', async () => {
    fetchMock.responseData = { status: 'ok' }

    await client.apiLogout()

    expect(fetchMock.lastUrl).toBe('/web/auth/logout')
    expect(fetchMock.lastOpts).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
    })
    expect(fetchMock.lastOpts.body).toBeUndefined()
    expect(fetchMock.lastOpts.headers).toHaveProperty(
      'Content-Type',
      'application/json',
    )
  })
})

describe('session API', () => {
  test('uses the account cookie without UUID query params or auth headers', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('account API must not read localStorage')
        },
        setItem: () => {
          throw new Error('account API must not write localStorage')
        },
      },
    })
    fetchMock.responseData = []

    await client.apiFetchSessions()

    expect(fetchMock.lastUrl).toBe('/web/sessions')
    expect(fetchMock.lastOpts.credentials).toBe('same-origin')
    expect(fetchMock.lastOpts.headers).not.toHaveProperty('Authorization')
  })

  test('throws a typed API error on a failed response', async () => {
    fetchMock.response = { ok: false, status: 401, statusText: 'Unauthorized' }
    fetchMock.responseData = {
      error: { type: 'unauthorized', message: 'Sign in required' },
    }

    try {
      await client.apiFetchSessions()
      throw new Error('Expected apiFetchSessions to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(client.ApiError)
      expect(error).toMatchObject({
        message: 'Sign in required',
        status: 401,
        type: 'unauthorized',
      })
    }
  })

  test('falls back to status text when an error body is empty', async () => {
    fetchMock.response = {
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    }
    fetchMock.responseData = {}

    await expect(client.apiFetchSessions()).rejects.toThrow(
      'Internal Server Error',
    )
  })
})

describe('ACP relay client', () => {
  test('builds a cookie-authenticated relay URL without identity params', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          protocol: 'https:',
          host: 'rcs.example.test',
        },
      },
    })

    expect(relayClient.buildRelayUrl('agent_123')).toBe(
      'wss://rcs.example.test/acp/relay/agent_123',
    )
  })
})
