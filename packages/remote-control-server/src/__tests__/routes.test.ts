import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { Hono } from 'hono'
import { setupRcsConfigMock } from '../../../../tests/mocks/rcsConfig.js'

const configMock = setupRcsConfigMock()
const routeConfig = {
  allowRegistration: true,
  legacyApiKeyAuth: false,
  tokenPepper: 'test-token-pepper-at-least-32-characters',
  workerJwtSecret: 'test-worker-secret-at-least-32-characters',
  baseUrl: 'https://rcs.example',
  loginRateLimit: 2,
  loginRateWindowSeconds: 60,
  registrationRateLimit: 3,
  registrationRateWindowSeconds: 60,
  pollTimeout: 1,
}
beforeAll(() => configMock.set(routeConfig))
afterAll(() => configMock.reset())

import { digestToken } from '../auth/credentials'
import { BROWSER_SESSION_COOKIE } from '../auth/middleware'
import { generateWorkerJwt } from '../auth/jwt'
import { getDatabase, setDatabasePathForTests } from '../db/database'
import v1Auth from '../routes/v1/auth'
import v1Environments from '../routes/v1/environments'
import v1EnvironmentWork from '../routes/v1/environments.work'
import v1SessionIngress from '../routes/v1/session-ingress'
import v1Sessions from '../routes/v1/sessions'
import v2CodeSessions from '../routes/v2/code-sessions'
import v2WorkerEventsStream from '../routes/v2/worker-events-stream'
import v2WorkerEvents from '../routes/v2/worker-events'
import v2Worker from '../routes/v2/worker'
import webAuth from '../routes/web/auth'
import webControl from '../routes/web/control'
import webEnvironments from '../routes/web/environments'
import webSessions from '../routes/web/sessions'
import { createWorkItem } from '../services/work-dispatch'
import {
  storeCreateAccount,
  storeCreateAuthToken,
  storeCreateEnvironment,
  storeCreateSession,
  storeGetWorkItem,
  storeReset,
} from '../store'

interface AuthFixture {
  accountId: string
  access: string
  browser: string
}

function createApp() {
  const app = new Hono()
  app.route('/v1/auth', v1Auth)
  app.route('/v1/environments', v1Environments)
  app.route('/v1/environments', v1EnvironmentWork)
  app.route('/v1/sessions', v1Sessions)
  app.route('/v1/session_ingress', v1SessionIngress)
  app.route('/v1/code/sessions', v2CodeSessions)
  app.route('/v1/code/sessions', v2Worker)
  app.route('/v1/code/sessions', v2WorkerEventsStream)
  app.route('/v1/code/sessions', v2WorkerEvents)
  app.route('/web', webAuth)
  app.route('/web', webSessions)
  app.route('/web', webControl)
  app.route('/web', webEnvironments)
  return app
}

function token(accountId: string, kind: 'access' | 'browser', raw: string) {
  const now = Date.now()
  storeCreateAuthToken({
    digest: digestToken(raw),
    accountId,
    kind,
    sessionId: null,
    expiresAt: new Date(now + 86_400_000),
    createdAt: new Date(now),
    revokedAt: null,
    replacedByDigest: null,
  })
}

function account(username: string): AuthFixture {
  const record = storeCreateAccount(username, '$argon2id$test-hash')
  const access = `access-${username}`
  const browser = `browser-${username}`
  token(record.id, 'access', access)
  token(record.id, 'browser', browser)
  return { accountId: record.id, access, browser }
}

function bearer(raw: string) {
  return { Authorization: `Bearer ${raw}` }
}

function cookie(raw: string) {
  return { Cookie: `${BROWSER_SESSION_COOKIE}=${raw}` }
}

function webMutationHeaders(raw?: string) {
  return {
    ...(raw ? cookie(raw) : {}),
    Origin: 'https://rcs.example',
    'Content-Type': 'application/json',
  }
}

function body(res: Response) {
  return res.json() as Promise<Record<string, unknown>>
}

beforeAll(() => setDatabasePathForTests(':memory:'))
beforeEach(() => {
  configMock.set(routeConfig)
  storeReset()
})

describe('account auth API', () => {
  test('returns exact account capabilities', async () => {
    const response = await createApp().request('/v1/auth/capabilities')
    const expected = {
      auth_mode: 'accounts',
      registration_enabled: true,
      access_token_ttl_seconds: 900,
      pairing_ttl_seconds: 120,
    }
    expect(await body(response)).toEqual(expected)
    expect(
      await body(await createApp().request('/web/auth/capabilities')),
    ).toEqual(expected)
  })

  test('marks credential responses as non-cacheable', async () => {
    const app = createApp()
    const credentials = {
      username: 'cachetest',
      password: 'correct horse battery staple',
    }
    const registration = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    })
    expect(registration.status).toBe(201)
    const registered = (await body(registration)) as {
      user: { id: string }
      access_token: string
    }
    const login = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    })
    expect(login.status).toBe(200)
    expect(login.headers.get('Cache-Control')).toBe('no-store')

    const session = storeCreateSession({ accountId: registered.user.id })
    const pairing = await app.request(`/v1/sessions/${session.id}/pairing`, {
      method: 'POST',
      headers: bearer(registered.access_token),
    })
    expect(pairing.status).toBe(200)
    expect(pairing.headers.get('Cache-Control')).toBe('no-store')
  })

  test('registers, logs in, reads me, rotates refresh, and logs out', async () => {
    const app = createApp()
    const credentials = {
      username: 'Alice',
      password: 'correct horse battery staple',
    }
    const registration = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    })
    expect(registration.status).toBe(201)
    const registered = (await body(registration)) as {
      user: { id: string; username: string }
      access_token: string
      refresh_token: string
      expires_in: number
      refresh_expires_in: number
    }
    expect(registered.user.username).toBe('alice')
    expect(registered.expires_in).toBe(900)

    const login = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...credentials, username: 'alice' }),
    })
    expect(login.status).toBe(200)

    const me = await app.request('/v1/auth/me', {
      headers: bearer(registered.access_token),
    })
    expect(await body(me)).toEqual({ user: registered.user })

    const refreshed = await app.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: registered.refresh_token }),
    })
    expect(refreshed.status).toBe(200)
    const rotated = (await body(refreshed)) as {
      access_token: string
      refresh_token: string
    }
    expect(rotated.refresh_token).not.toBe(registered.refresh_token)

    const logout = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: {
        ...bearer(rotated.access_token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: rotated.refresh_token }),
    })
    expect(logout.status).toBe(200)
    expect(
      (
        await app.request('/v1/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: rotated.refresh_token }),
        })
      ).status,
    ).toBe(401)

    // Replaying a used refresh token revokes the whole family.
    expect(
      (
        await app.request('/v1/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: registered.refresh_token }),
        })
      ).status,
    ).toBe(401)
  })

  test('returns Retry-After from persistent per-IP and username limits', async () => {
    const app = createApp()
    const request = () =>
      app.request('/v1/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.8',
        },
        body: JSON.stringify({
          username: 'missing',
          password: 'bad password!',
        }),
      })
    expect((await request()).status).toBe(401)
    expect((await request()).status).toBe(401)
    const limited = await request()
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
  })
})

describe('browser account auth and pairing', () => {
  test('sets hardened cookies for login and supports me/logout', async () => {
    const app = createApp()
    const credentials = {
      username: 'alice',
      password: 'correct horse battery staple',
    }
    await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    })
    const login = await app.request('https://rcs.example/web/auth/login', {
      method: 'POST',
      headers: webMutationHeaders(),
      body: JSON.stringify(credentials),
    })
    expect(login.status).toBe(200)
    const setCookie = login.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain('__Host-rcs_session=')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/')
    const cookiePair = setCookie.split(';')[0] as string

    expect(
      (
        await app.request('https://rcs.example/web/auth/me', {
          headers: { Cookie: cookiePair },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request('https://rcs.example/web/auth/logout', {
          method: 'POST',
          headers: {
            Cookie: cookiePair,
            Origin: 'https://rcs.example',
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request('https://rcs.example/web/auth/me', {
          headers: { Cookie: cookiePair },
        })
      ).status,
    ).toBe(401)
  })

  test('session creation returns stable pairing data and replacement endpoint', async () => {
    const alice = account('alice')
    const app = createApp()
    const created = await app.request('/v1/sessions', {
      method: 'POST',
      headers: {
        ...bearer(alice.access),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Pair me' }),
    })
    const session = (await body(created)) as {
      id: string
      pairing_code: string
      pairing_url: string
      pairing_expires_at: number
      web_url: string
    }
    expect(session.pairing_code).toMatch(/^rcp_/)
    expect(session.pairing_url).toBe(session.web_url)
    expect(session.pairing_url).toContain(`#pair=${session.pairing_code}`)
    expect(session.pairing_expires_at).toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    )

    const replacement = await app.request(
      `/v1/sessions/${session.id}/pairing`,
      { method: 'POST', headers: bearer(alice.access) },
    )
    expect(replacement.status).toBe(200)
    expect(
      ((await body(replacement)) as { pairing_code: string }).pairing_code,
    ).not.toBe(session.pairing_code)
    const superseded = await app.request('https://rcs.example/web/auth/pair', {
      method: 'POST',
      headers: webMutationHeaders(),
      body: JSON.stringify({ code: session.pairing_code }),
    })
    expect(superseded.status).toBe(401)
  })

  test('pairing is single-use, sets the browser cookie, and expires', async () => {
    const alice = account('alice')
    const session = storeCreateSession({ accountId: alice.accountId })
    const app = createApp()
    const pairingResponse = await app.request(
      `/v1/sessions/${session.id}/pairing`,
      { method: 'POST', headers: bearer(alice.access) },
    )
    const pairing = (await body(pairingResponse)) as { pairing_code: string }
    const pairRequest = () =>
      app.request('https://rcs.example/web/auth/pair', {
        method: 'POST',
        headers: webMutationHeaders(),
        body: JSON.stringify({ code: pairing.pairing_code }),
      })
    const paired = await pairRequest()
    expect(paired.status).toBe(200)
    expect(paired.headers.get('Set-Cookie')).toContain('__Host-rcs_session=')
    expect((await pairRequest()).status).toBe(401)

    const fresh = await app.request(`/v1/sessions/${session.id}/pairing`, {
      method: 'POST',
      headers: bearer(alice.access),
    })
    const expiredPair = (await body(fresh)) as { pairing_code: string }
    getDatabase()
      .query('UPDATE auth_tokens SET expires_at = 0 WHERE digest = ?')
      .run(digestToken(expiredPair.pairing_code))
    const expired = await app.request('https://rcs.example/web/auth/pair', {
      method: 'POST',
      headers: webMutationHeaders(),
      body: JSON.stringify({ code: expiredPair.pairing_code }),
    })
    expect(expired.status).toBe(401)
  })
})

describe('scoped work credentials', () => {
  test('polls with an environment token and restricts work lifecycle credentials', async () => {
    const alice = account('alice')
    const environment = storeCreateEnvironment({
      accountId: alice.accountId,
      secret: 'alice-environment-token',
    })
    const session = storeCreateSession({
      accountId: alice.accountId,
      environmentId: environment.id,
    })
    const workId = await createWorkItem(
      environment.id,
      session.id,
      alice.accountId,
    )
    const app = createApp()
    const polled = await app.request(
      `/v1/environments/${environment.id}/work/poll`,
      { headers: bearer('alice-environment-token') },
    )
    expect(polled.status).toBe(200)
    const work = (await body(polled)) as { secret: string }
    const workerToken = (
      JSON.parse(Buffer.from(work.secret, 'base64url').toString()) as {
        session_ingress_token: string
      }
    ).session_ingress_token

    expect(
      (
        await app.request(
          `/v1/environments/${environment.id}/work/${workId}/ack`,
          { method: 'POST', headers: bearer(alice.access) },
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request(
          `/v1/environments/${environment.id}/work/${workId}/ack`,
          { method: 'POST', headers: bearer(workerToken) },
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request(
          `/v1/environments/${environment.id}/work/${workId}/heartbeat`,
          { method: 'POST', headers: bearer(workerToken) },
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request(
          `/v1/environments/${environment.id}/work/${workId}/stop`,
          { method: 'POST', headers: bearer(alice.access) },
        )
      ).status,
    ).toBe(200)
  })
})

describe('two-account route isolation', () => {
  test('denies cross-account environment, session, work, worker, and ingress routes', async () => {
    const alice = account('alice')
    const bob = account('bob')
    const environment = storeCreateEnvironment({
      accountId: alice.accountId,
      secret: 'alice-environment-token',
    })
    const session = storeCreateSession({
      accountId: alice.accountId,
      environmentId: environment.id,
    })
    const workId = await createWorkItem(
      environment.id,
      session.id,
      alice.accountId,
    )
    const app = createApp()

    const accountRequests: Array<[string, RequestInit]> = [
      [`/v1/environments/bridge/${environment.id}`, { method: 'DELETE' }],
      [
        `/v1/environments/${environment.id}/bridge/reconnect`,
        { method: 'POST' },
      ],
      [`/v1/environments/${environment.id}/work/poll`, {}],
      [
        `/v1/environments/${environment.id}/work/${workId}/ack`,
        { method: 'POST' },
      ],
      [
        `/v1/environments/${environment.id}/work/${workId}/stop`,
        { method: 'POST' },
      ],
      [
        `/v1/environments/${environment.id}/work/${workId}/heartbeat`,
        { method: 'POST' },
      ],
      [`/v1/sessions/${session.id}`, {}],
      [
        `/v1/sessions/${session.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'stolen' }),
        },
      ],
      [`/v1/sessions/${session.id}/archive`, { method: 'POST' }],
      [
        `/v1/sessions/${session.id}/events`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'user', content: 'stolen' }),
        },
      ],
      [`/v1/sessions/${session.id}/pairing`, { method: 'POST' }],
      [`/v1/code/sessions/${session.id}/bridge`, { method: 'POST' }],
      [`/v1/code/sessions/${session.id}/worker/register`, { method: 'POST' }],
    ]
    for (const [url, init] of accountRequests) {
      const response = await app.request(url, {
        ...init,
        headers: { ...init.headers, ...bearer(bob.access) },
      })
      expect(response.status).toBe(404)
    }

    const aliceWorker = generateWorkerJwt(alice.accountId, session.id, 900)
    const bobSession = storeCreateSession({ accountId: bob.accountId })
    const bobWorker = generateWorkerJwt(bob.accountId, bobSession.id, 900)
    expect(
      (
        await app.request(
          `/v1/session_ingress/session/${bobSession.id}/events`,
          {
            method: 'POST',
            headers: {
              ...bearer(aliceWorker),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ type: 'message' }),
          },
        )
      ).status,
    ).toBe(401)

    const workerRequests: Array<[string, RequestInit]> = [
      [`/v1/code/sessions/${session.id}/worker`, {}],
      [
        `/v1/code/sessions/${session.id}/worker`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      ],
      [`/v1/code/sessions/${session.id}/worker/heartbeat`, { method: 'POST' }],
      [
        `/v1/code/sessions/${session.id}/worker/events`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      ],
      [
        `/v1/code/sessions/${session.id}/worker/state`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      ],
      [`/v1/code/sessions/${session.id}/worker/events/stream`, {}],
    ]
    for (const [url, init] of workerRequests) {
      const response = await app.request(url, {
        ...init,
        headers: { ...init.headers, ...bearer(bobWorker) },
      })
      expect(response.status).toBe(401)
    }

    expect(storeGetWorkItem(workId, alice.accountId)?.state).toBe('pending')
  })

  test('denies every cross-account Web environment/history/SSE/control route', async () => {
    const alice = account('alice')
    const bob = account('bob')
    const aliceEnvironment = storeCreateEnvironment({
      accountId: alice.accountId,
      secret: 'alice-environment-token',
    })
    storeCreateEnvironment({
      accountId: bob.accountId,
      secret: 'bob-environment-token',
    })
    const aliceSession = storeCreateSession({
      accountId: alice.accountId,
      environmentId: aliceEnvironment.id,
    })
    const app = createApp()

    const environments = await app.request('/web/environments', {
      headers: cookie(bob.browser),
    })
    expect((await environments.json()) as unknown[]).toHaveLength(1)

    const readUrls = [
      `/web/sessions/${aliceSession.id}`,
      `/web/sessions/${aliceSession.id}/history`,
      `/web/sessions/${aliceSession.id}/events`,
    ]
    for (const url of readUrls) {
      expect(
        (await app.request(url, { headers: cookie(bob.browser) })).status,
      ).toBe(404)
    }

    for (const suffix of ['events', 'control', 'interrupt']) {
      const response = await app.request(
        `https://rcs.example/web/sessions/${aliceSession.id}/${suffix}`,
        {
          method: 'POST',
          headers: webMutationHeaders(bob.browser),
          body: JSON.stringify({ type: 'user', content: 'stolen' }),
        },
      )
      expect(response.status).toBe(404)
    }

    const crossEnvironmentCreate = await app.request(
      'https://rcs.example/web/sessions',
      {
        method: 'POST',
        headers: webMutationHeaders(bob.browser),
        body: JSON.stringify({ environment_id: aliceEnvironment.id }),
      },
    )
    expect(crossEnvironmentCreate.status).toBe(400)

    expect(
      (await app.request(`/web/sessions/${aliceSession.id}/events`)).status,
    ).toBe(401)
  })
})
