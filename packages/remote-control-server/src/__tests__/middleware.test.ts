import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { setupRcsConfigMock } from '../../../../tests/mocks/rcsConfig.js'

const configMock = setupRcsConfigMock()
const authConfig = {
  apiKeys: ['legacy-test-key'],
  legacyApiKeyAuth: false,
  tokenPepper: 'test-token-pepper-at-least-32-characters',
  workerJwtSecret: 'test-worker-secret-at-least-32-characters',
  baseUrl: 'http://localhost:3000',
  webCorsOrigins: ['https://dashboard.example'],
}
beforeAll(() => configMock.set(authConfig))
afterAll(() => configMock.reset())

import { digestToken } from '../auth/credentials'
import { generateWorkerJwt } from '../auth/jwt'
import {
  BROWSER_SESSION_COOKIE,
  accountAuth,
  bridgeCredentialAuth,
  browserAuth,
  encodeWebSocketAuthProtocol,
  extractWebSocketAuthToken,
  requireSameOriginJson,
  sessionIngressAuth,
} from '../auth/middleware'
import {
  getAllowedWebCorsOrigins,
  resolveWebCorsOrigin,
  webCorsOptions,
} from '../auth/cors'
import { setDatabasePathForTests } from '../db/database'
import { incrementEpoch } from '../services/session'
import {
  storeCreateAccount,
  storeCreateAuthToken,
  storeCreateEnvironment,
  storeCreateSession,
  storeReset,
  storeSetAccountDisabled,
} from '../store'

function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>
}

function createToken(
  accountId: string,
  kind: 'access' | 'browser',
  raw: string,
) {
  const now = Date.now()
  storeCreateAuthToken({
    digest: digestToken(raw),
    accountId,
    kind,
    sessionId: null,
    expiresAt: new Date(now + 60_000),
    createdAt: new Date(now),
    revokedAt: null,
    replacedByDigest: null,
  })
}

beforeAll(() => setDatabasePathForTests(':memory:'))
beforeEach(() => {
  configMock.set(authConfig)
  storeReset()
})

describe('authentication middleware', () => {
  test('accepts account access tokens and ignores identity headers', async () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    createToken(account.id, 'access', 'account-token')
    const app = new Hono()
    app.get('/resource', accountAuth, c =>
      c.json({
        accountId: c.get('accountId'),
        username: c.get('username'),
      }),
    )

    const accepted = await app.request('/resource', {
      headers: {
        Authorization: 'Bearer account-token',
        'X-Username': 'mallory',
        'X-Account-Id': 'acct_attacker',
      },
    })
    expect(accepted.status).toBe(200)
    expect(await json(accepted)).toMatchObject({
      accountId: account.id,
      username: 'alice',
    })

    const headerOnly = await app.request('/resource', {
      headers: { 'X-Username': 'alice' },
    })
    expect(headerOnly.status).toBe(401)
  })

  test('keeps legacy API keys off by default and never reads X-Username', async () => {
    const app = new Hono()
    app.get('/resource', accountAuth, c =>
      c.json({ username: c.get('username') }),
    )
    const disabled = await app.request('/resource', {
      headers: {
        Authorization: 'Bearer legacy-test-key',
        'X-Username': 'alice',
      },
    })
    expect(disabled.status).toBe(401)

    configMock.set({ ...authConfig, legacyApiKeyAuth: true })
    const enabled = await app.request('/resource', {
      headers: {
        Authorization: 'Bearer legacy-test-key',
        'X-Username': 'alice',
      },
    })
    expect(enabled.status).toBe(200)
    expect(await json(enabled)).toMatchObject({ username: 'legacy-system' })

    const web = new Hono()
    web.get('/web/me', browserAuth, c => c.json({ ok: true }))
    expect(
      (
        await web.request('/web/me', {
          headers: {
            Cookie: `${BROWSER_SESSION_COOKIE}=legacy-test-key`,
          },
        })
      ).status,
    ).toBe(401)
  })

  test('scopes environment credentials to their target environment', async () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    const environment = storeCreateEnvironment({
      accountId: account.id,
      secret: 'environment-token',
    })
    const other = storeCreateEnvironment({
      accountId: account.id,
      secret: 'other-environment-token',
    })
    const app = new Hono()
    app.get('/environments/:id', bridgeCredentialAuth, c =>
      c.json({ accountId: c.get('accountId') }),
    )

    expect(
      (
        await app.request(`/environments/${environment.id}`, {
          headers: { Authorization: 'Bearer environment-token' },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request(`/environments/${other.id}`, {
          headers: { Authorization: 'Bearer environment-token' },
        })
      ).status,
    ).toBe(401)
  })

  test('enforces worker session and account claims', async () => {
    const alice = storeCreateAccount('alice', '$argon2id$hash')
    const bob = storeCreateAccount('bob', '$argon2id$hash')
    const aliceSession = storeCreateSession({ accountId: alice.id })
    const bobSession = storeCreateSession({ accountId: bob.id })
    const app = new Hono()
    app.get('/ingress/:id', sessionIngressAuth, c =>
      c.json({ accountId: c.get('accountId') }),
    )

    const valid = generateWorkerJwt(alice.id, aliceSession.id, 900)
    expect(
      (
        await app.request(`/ingress/${aliceSession.id}`, {
          headers: { Authorization: `Bearer ${valid}` },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request(`/ingress/${bobSession.id}`, {
          headers: { Authorization: `Bearer ${valid}` },
        })
      ).status,
    ).toBe(401)

    const wrongAccount = generateWorkerJwt(bob.id, aliceSession.id, 900)
    expect(
      (
        await app.request(`/ingress/${aliceSession.id}`, {
          headers: { Authorization: `Bearer ${wrongAccount}` },
        })
      ).status,
    ).toBe(401)
  })

  test('rejects worker tokens minted before an epoch rotation', async () => {
    const alice = storeCreateAccount('alice', '$argon2id$hash')
    const session = storeCreateSession({ accountId: alice.id })
    const beforeRotation = generateWorkerJwt(alice.id, session.id, 900)

    incrementEpoch(session.id, alice.id)

    const app = new Hono()
    app.get('/ingress/:id', sessionIngressAuth, c =>
      c.json({ accountId: c.get('accountId') }),
    )
    expect(
      (
        await app.request(`/ingress/${session.id}`, {
          headers: { Authorization: `Bearer ${beforeRotation}` },
        })
      ).status,
    ).toBe(401)

    const afterRotation = generateWorkerJwt(alice.id, session.id, 900)
    expect(
      (
        await app.request(`/ingress/${session.id}`, {
          headers: { Authorization: `Bearer ${afterRotation}` },
        })
      ).status,
    ).toBe(200)
  })

  test('rejects worker JWTs after the account is disabled', async () => {
    const alice = storeCreateAccount('alice', '$argon2id$hash')
    const session = storeCreateSession({ accountId: alice.id })
    const token = generateWorkerJwt(alice.id, session.id, 900)

    const app = new Hono()
    app.get('/ingress/:id', sessionIngressAuth, c =>
      c.json({ accountId: c.get('accountId') }),
    )
    expect(
      (
        await app.request(`/ingress/${session.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200)

    storeSetAccountDisabled(alice.id, true)

    expect(
      (
        await app.request(`/ingress/${session.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401)
  })

  test('authenticates browser routes only from the secure session cookie', async () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    createToken(account.id, 'browser', 'browser-token')
    const app = new Hono()
    app.get('/web/me', browserAuth, c =>
      c.json({ accountId: c.get('accountId') }),
    )
    expect(
      (
        await app.request('/web/me', {
          headers: {
            Cookie: `${BROWSER_SESSION_COOKIE}=browser-token`,
          },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request('/web/me', {
          headers: { Authorization: 'Bearer browser-token' },
        })
      ).status,
    ).toBe(401)
  })

  test('requires same-origin JSON for cookie-authenticated mutations', async () => {
    const app = new Hono()
    app.post('/web/change', requireSameOriginJson, c => c.json({ ok: true }))
    const accepted = await app.request('http://localhost/web/change', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost',
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(accepted.status).toBe(200)
    expect(
      (
        await app.request('http://localhost/web/change', {
          method: 'POST',
          headers: {
            Origin: 'https://attacker.example',
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request('http://localhost/web/change', {
          method: 'POST',
          headers: { Origin: 'http://localhost' },
          body: '{}',
        })
      ).status,
    ).toBe(415)
  })

  test('extracts WebSocket auth only from bearer or subprotocol', async () => {
    const app = new Hono()
    app.get('/token', c =>
      c.json({ token: extractWebSocketAuthToken(c) ?? null }),
    )
    const response = await app.request('/token?token=query-secret', {
      headers: {
        'Sec-WebSocket-Protocol': encodeWebSocketAuthProtocol('ws-secret'),
      },
    })
    expect(await json(response)).toMatchObject({ token: 'ws-secret' })
  })
})

describe('Web CORS', () => {
  test('allows configured origins with credentials but rejects unknown origins', async () => {
    expect(getAllowedWebCorsOrigins()).toContain('https://dashboard.example')
    expect(resolveWebCorsOrigin('https://attacker.example')).toBeUndefined()
    const app = new Hono()
    app.use('/web/*', cors(webCorsOptions))
    app.get('/web/ping', c => c.text('ok'))
    const response = await app.request('/web/ping', {
      headers: { Origin: 'https://dashboard.example' },
    })
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://dashboard.example',
    )
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe(
      'true',
    )
  })
})
