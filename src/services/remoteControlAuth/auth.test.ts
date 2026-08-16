import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { tryKeychain } from '../localVault/keychain.js'
import { _setKeychainBackendForTesting } from '../localVault/store.js'
import {
  loginRemoteControlAccount,
  refreshRemoteControlAccount,
} from './client.js'
import {
  clearRemoteControlCredential,
  readRemoteControlCredential,
  saveRemoteControlCredential,
} from './credentials.js'
import {
  authenticateRemoteControl,
  logoutRemoteControl,
  prepareRemoteControlAuthentication,
  refreshRemoteControlAccessToken,
} from './index.js'
import {
  clearRemoteControlAuthState,
  getRemoteControlAccessToken,
  getRemoteControlAccessTokenForRequest,
  getRemoteControlAuthMode,
  normalizeRemoteControlBaseUrl,
  setRemoteControlAccessState,
} from './state.js'
import { RemoteControlAuthError } from './types.js'

const secrets = new Map<string, string>()
const fakeKeychain: typeof tryKeychain = {
  async set(account, value) {
    secrets.set(account, value)
  },
  async get(account) {
    return secrets.get(account) ?? null
  },
  async delete(account) {
    return secrets.delete(account)
  },
  async list() {
    return [...secrets.keys()]
  },
  async _addToIndex() {},
  async _removeFromIndex() {},
}

const BASE_A = 'https://relay-a.example.test'
const BASE_B = 'https://relay-b.example.test'

beforeEach(() => {
  secrets.clear()
  clearRemoteControlAuthState(BASE_A)
  clearRemoteControlAuthState(BASE_B)
  delete process.env.CLAUDE_BRIDGE_OAUTH_TOKEN
  _setKeychainBackendForTesting(fakeKeychain)
})

afterAll(() => {
  _setKeychainBackendForTesting(undefined)
})

describe('Remote Control account credentials', () => {
  test('scopes stored refresh credentials by normalized base URL', async () => {
    await saveRemoteControlCredential(BASE_A, 'alice', 'refresh-a')
    await saveRemoteControlCredential(BASE_B, 'alice', 'refresh-b')

    expect(await readRemoteControlCredential(`${BASE_A}/`)).toEqual({
      version: 1,
      baseUrl: BASE_A,
      username: 'alice',
      refreshToken: 'refresh-a',
    })
    expect(await readRemoteControlCredential(BASE_B)).toEqual({
      version: 1,
      baseUrl: BASE_B,
      username: 'alice',
      refreshToken: 'refresh-b',
    })
    expect(secrets.size).toBe(2)
    expect([...secrets.values()].join('\n')).not.toContain('password')
    expect([...secrets.values()].join('\n')).not.toContain('access_token')

    expect(await clearRemoteControlCredential(`${BASE_A}/`)).toBe(true)
    expect(await readRemoteControlCredential(BASE_A)).toBeNull()
    expect(await readRemoteControlCredential(BASE_B)).not.toBeNull()
  })

  test('does not return an access token inside the minimum-validity window', () => {
    setRemoteControlAccessState(BASE_A, 'short-lived-access', 1, {
      id: 'account-1',
      username: 'alice',
    })

    expect(getRemoteControlAccessToken(BASE_A)).toBe('short-lived-access')
    expect(getRemoteControlAccessToken(BASE_A, 1_001)).toBeUndefined()

    setRemoteControlAccessState(BASE_A, 'expired-access', -1, {
      id: 'account-1',
      username: 'alice',
    })
    expect(getRemoteControlAccessToken(BASE_A)).toBeUndefined()
    expect(getRemoteControlAccessTokenForRequest(BASE_A)).toBe('expired-access')
    expect(normalizeRemoteControlBaseUrl(`${BASE_A}///`)).toBe(BASE_A)
  })
})

describe('Remote Control account HTTP client', () => {
  test('uses the refresh contract without exposing the token in the URL', async () => {
    let requestUrl = ''
    let requestBody: unknown
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        requestUrl = request.url
        requestBody = await request.json()
        return Response.json({
          user: { id: 'account-1', username: 'alice' },
          access_token: 'access-2',
          expires_in: 900,
          refresh_token: 'refresh-2',
          refresh_expires_in: 2_592_000,
        })
      },
    })

    try {
      const result = await refreshRemoteControlAccount(
        `http://127.0.0.1:${server.port}/`,
        'refresh-1',
      )
      expect(result.access_token).toBe('access-2')
      expect(new URL(requestUrl).pathname).toBe('/v1/auth/refresh')
      expect(new URL(requestUrl).search).toBe('')
      expect(requestBody).toEqual({ refresh_token: 'refresh-1' })
    } finally {
      await server.stop(true)
    }
  })

  test('rejects malformed successful authentication responses', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return Response.json({ access_token: 'incomplete' })
      },
    })

    try {
      const error = await loginRemoteControlAccount(
        `http://127.0.0.1:${server.port}`,
        'alice',
        'correct horse battery staple',
      ).catch(value => value)
      expect(error).toBeInstanceOf(RemoteControlAuthError)
      expect(error.status).toBe(502)
      expect(error.type).toBe('invalid_response')
    } finally {
      await server.stop(true)
    }
  })

  test('surfaces sanitized rate-limit metadata', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return Response.json(
          {
            error: {
              type: 'rate_limited',
              message: 'Too many login attempts.',
            },
          },
          { status: 429, headers: { 'Retry-After': '17' } },
        )
      },
    })

    try {
      const error = await loginRemoteControlAccount(
        `http://127.0.0.1:${server.port}`,
        'alice',
        'correct horse battery staple',
      ).catch(value => value)
      expect(error).toBeInstanceOf(RemoteControlAuthError)
      expect(error.status).toBe(429)
      expect(error.type).toBe('rate_limited')
      expect(error.retryAfterSeconds).toBe(17)
      expect(error.message).toBe('Too many login attempts.')
      expect(error.message).not.toContain('correct horse battery staple')
    } finally {
      await server.stop(true)
    }
  })
})

type Deferred = { promise: Promise<void>; resolve: () => void }

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}

/** Waits for `predicate` without busy-looping the event loop flat out. */
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error('condition was never met')
}

describe('Remote Control account refresh orchestration', () => {
  test('rotates the stored refresh token and coalesces concurrent refreshes', async () => {
    let refreshCount = 0
    let logoutAuthorization = ''
    let logoutBody: unknown
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/v1/auth/capabilities') {
          return Response.json({
            auth_mode: 'accounts',
            registration_enabled: true,
            access_token_ttl_seconds: 900,
            pairing_ttl_seconds: 120,
          })
        }
        if (path === '/v1/auth/refresh') {
          refreshCount++
          const body = (await request.json()) as { refresh_token?: string }
          await Bun.sleep(10)
          return Response.json({
            user: { id: 'account-1', username: 'alice' },
            access_token: `access-${refreshCount}`,
            expires_in: 900,
            refresh_token: `${body.refresh_token}-rotated`,
            refresh_expires_in: 2_592_000,
          })
        }
        if (path === '/v1/auth/logout') {
          logoutAuthorization = request.headers.get('Authorization') ?? ''
          logoutBody = await request.json()
          return Response.json({ status: 'ok' })
        }
        return new Response(null, { status: 404 })
      },
    })
    const baseUrl = `http://127.0.0.1:${server.port}`

    try {
      await saveRemoteControlCredential(baseUrl, 'alice', 'refresh-0')
      const prepared = await prepareRemoteControlAuthentication(baseUrl)
      expect(prepared).toEqual({
        status: 'authenticated',
        user: { id: 'account-1', username: 'alice' },
        registrationEnabled: true,
      })
      expect(getRemoteControlAuthMode(baseUrl)).toBe('accounts')
      expect(getRemoteControlAccessToken(baseUrl)).toBe('access-1')
      expect((await readRemoteControlCredential(baseUrl))?.refreshToken).toBe(
        'refresh-0-rotated',
      )

      const stale = getRemoteControlAccessToken(baseUrl)
      const results = await Promise.all([
        refreshRemoteControlAccessToken(baseUrl, stale),
        refreshRemoteControlAccessToken(baseUrl, stale),
      ])
      expect(results).toEqual([true, true])
      expect(refreshCount).toBe(2)
      expect((await readRemoteControlCredential(baseUrl))?.refreshToken).toBe(
        'refresh-0-rotated-rotated',
      )

      setRemoteControlAccessState(baseUrl, 'expired-access', -1, {
        id: 'account-1',
        username: 'alice',
      })
      await logoutRemoteControl(baseUrl)
      expect(refreshCount).toBe(3)
      expect(logoutAuthorization).toBe('Bearer access-3')
      expect(logoutBody).toEqual({
        refresh_token: 'refresh-0-rotated-rotated-rotated',
      })
      expect(await readRemoteControlCredential(baseUrl)).toBeNull()
      expect(getRemoteControlAccessToken(baseUrl)).toBeUndefined()
    } finally {
      clearRemoteControlAuthState(baseUrl)
      await server.stop(true)
    }
  })
})

/**
 * `/remote-control logout` flips replBridgeEnabled off at the same moment it
 * revokes the account, and the bridge teardown that follows answers 401 by
 * refreshing. Both of these guard the window where that refresh could write a
 * rotated — and therefore still valid — refresh token into a vault the logout
 * has already emptied.
 */
describe('Remote Control logout races the bridge teardown refresh', () => {
  test('waits for an in-flight refresh so its write cannot land after the clear', async () => {
    let refreshCount = 0
    let logoutRequests = 0
    const secondRefreshReleased = deferred()
    let secondRefreshStarted = false

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/v1/auth/capabilities') {
          return Response.json({
            auth_mode: 'accounts',
            registration_enabled: true,
            access_token_ttl_seconds: 900,
            pairing_ttl_seconds: 120,
          })
        }
        if (path === '/v1/auth/refresh') {
          refreshCount++
          const body = (await request.json()) as { refresh_token?: string }
          if (refreshCount > 1) {
            // Stand in for the teardown-triggered refresh that is still on the
            // wire when the user confirms the logout.
            secondRefreshStarted = true
            await secondRefreshReleased.promise
          }
          return Response.json({
            user: { id: 'account-1', username: 'alice' },
            access_token: `access-${refreshCount}`,
            expires_in: 900,
            refresh_token: `${body.refresh_token}-rotated`,
            refresh_expires_in: 2_592_000,
          })
        }
        if (path === '/v1/auth/logout') {
          logoutRequests++
          return Response.json({ status: 'ok' })
        }
        return new Response(null, { status: 404 })
      },
    })
    const baseUrl = `http://127.0.0.1:${server.port}`

    try {
      await saveRemoteControlCredential(baseUrl, 'alice', 'refresh-0')
      // Leaves a long-lived access token behind, so the logout's own
      // preparation resolves without joining the refresh under test.
      await prepareRemoteControlAuthentication(baseUrl)

      const teardownRefresh = refreshRemoteControlAccessToken(baseUrl)
      await until(() => secondRefreshStarted)

      let logoutSettled = false
      const logout = logoutRemoteControl(baseUrl).finally(() => {
        logoutSettled = true
      })
      await until(() => logoutRequests > 0)
      await Bun.sleep(50)

      expect(logoutSettled).toBe(false)

      secondRefreshReleased.resolve()
      expect(await teardownRefresh).toBe(true)
      await logout

      expect(await readRemoteControlCredential(baseUrl)).toBeNull()
      expect(getRemoteControlAccessToken(baseUrl)).toBeUndefined()
      expect(getRemoteControlAuthMode(baseUrl)).toBeUndefined()
      expect(secrets.size).toBe(0)
    } finally {
      secondRefreshReleased.resolve()
      clearRemoteControlAuthState(baseUrl)
      await server.stop(true)
    }
  })

  test('refuses to start a refresh while the credential is being cleared', async () => {
    let refreshCount = 0
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/v1/auth/capabilities') {
          return Response.json({
            auth_mode: 'accounts',
            registration_enabled: true,
            access_token_ttl_seconds: 900,
            pairing_ttl_seconds: 120,
          })
        }
        if (path === '/v1/auth/refresh') {
          refreshCount++
          const body = (await request.json()) as { refresh_token?: string }
          return Response.json({
            user: { id: 'account-1', username: 'alice' },
            access_token: `access-${refreshCount}`,
            expires_in: 900,
            refresh_token: `${body.refresh_token}-rotated`,
            refresh_expires_in: 2_592_000,
          })
        }
        if (path === '/v1/auth/logout') {
          return Response.json({ status: 'ok' })
        }
        return new Response(null, { status: 404 })
      },
    })
    const baseUrl = `http://127.0.0.1:${server.port}`

    let lateRefresh: boolean | undefined
    // Fires from inside the vault delete: the narrowest possible window, after
    // the logout committed to clearing but before the auth mode is gone.
    _setKeychainBackendForTesting({
      ...fakeKeychain,
      async delete(account) {
        if (lateRefresh === undefined) {
          lateRefresh = await refreshRemoteControlAccessToken(baseUrl)
        }
        return fakeKeychain.delete(account)
      },
    })

    try {
      await saveRemoteControlCredential(baseUrl, 'alice', 'refresh-0')
      await prepareRemoteControlAuthentication(baseUrl)
      expect(refreshCount).toBe(1)

      await logoutRemoteControl(baseUrl)

      expect(lateRefresh).toBe(false)
      // No second round trip: a session being revoked is not handed a token.
      expect(refreshCount).toBe(1)
      expect(await readRemoteControlCredential(baseUrl)).toBeNull()
      expect(secrets.size).toBe(0)
    } finally {
      _setKeychainBackendForTesting(fakeKeychain)
      clearRemoteControlAuthState(baseUrl)
      await server.stop(true)
    }
  })

  test('a fresh login after logout stores a credential again', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/v1/auth/capabilities') {
          return Response.json({
            auth_mode: 'accounts',
            registration_enabled: false,
            access_token_ttl_seconds: 900,
            pairing_ttl_seconds: 120,
          })
        }
        if (path === '/v1/auth/login') {
          return Response.json({
            user: { id: 'account-1', username: 'alice' },
            access_token: 'access-new',
            expires_in: 900,
            refresh_token: 'refresh-new',
            refresh_expires_in: 2_592_000,
          })
        }
        if (path === '/v1/auth/logout') {
          return Response.json({ status: 'ok' })
        }
        return new Response(null, { status: 404 })
      },
    })
    const baseUrl = `http://127.0.0.1:${server.port}`

    try {
      await saveRemoteControlCredential(baseUrl, 'alice', 'refresh-0')
      await logoutRemoteControl(baseUrl)
      expect(await readRemoteControlCredential(baseUrl)).toBeNull()

      // The logout barrier must not outlive the logout itself.
      const user = await authenticateRemoteControl(
        baseUrl,
        'login',
        'alice',
        'correct horse battery staple',
      )
      expect(user.username).toBe('alice')
      expect((await readRemoteControlCredential(baseUrl))?.refreshToken).toBe(
        'refresh-new',
      )
      expect(getRemoteControlAccessToken(baseUrl)).toBe('access-new')
    } finally {
      clearRemoteControlAuthState(baseUrl)
      await server.stop(true)
    }
  })
})

describe('Remote Control capability reporting', () => {
  test('carries registration_enabled through every preparation status', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/v1/auth/capabilities') {
          return Response.json({
            auth_mode: 'accounts',
            registration_enabled: false,
            access_token_ttl_seconds: 900,
            pairing_ttl_seconds: 120,
          })
        }
        return new Response(null, { status: 404 })
      },
    })
    const baseUrl = `http://127.0.0.1:${server.port}`

    try {
      // No stored credential: login_required, registration closed.
      expect(await prepareRemoteControlAuthentication(baseUrl)).toEqual({
        status: 'login_required',
        registrationEnabled: false,
      })

      setRemoteControlAccessState(baseUrl, 'access-1', 900, {
        id: 'account-1',
        username: 'alice',
      })
      // Already authenticated: the answer must still be the server's, not a
      // hardcoded `true` that offers registration where it is disabled.
      expect(await prepareRemoteControlAuthentication(baseUrl)).toEqual({
        status: 'authenticated',
        user: { id: 'account-1', username: 'alice' },
        registrationEnabled: false,
      })
    } finally {
      clearRemoteControlAuthState(baseUrl)
      await server.stop(true)
    }
  })

  test('reports a capabilities-less legacy server as registration-closed', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response(null, { status: 404 })
      },
    })
    const baseUrl = `http://127.0.0.1:${server.port}`

    try {
      expect(await prepareRemoteControlAuthentication(baseUrl)).toEqual({
        status: 'legacy',
        registrationEnabled: false,
      })
      expect(getRemoteControlAuthMode(baseUrl)).toBe('legacy_api_key')
    } finally {
      clearRemoteControlAuthState(baseUrl)
      await server.stop(true)
    }
  })
})
