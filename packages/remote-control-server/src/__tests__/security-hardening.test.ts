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
const hardeningConfig = {
  apiKeys: [] as string[],
  legacyApiKeyAuth: false,
  tokenPepper: 'test-token-pepper-at-least-32-characters',
  workerJwtSecret: 'test-worker-secret-at-least-32-characters',
  baseUrl: 'http://localhost:3000',
  webCorsOrigins: ['https://dashboard.example'],
  maxEnvironmentsPerAccount: 2,
  port: 3000,
}
beforeAll(() => configMock.set(hardeningConfig))
afterAll(() => configMock.reset())

import { digestToken } from '../auth/credentials'
import { generateWorkerJwt } from '../auth/jwt'
import { getAllowedWebCorsOrigins } from '../auth/cors'
import {
  BROWSER_SESSION_COOKIE,
  bridgeCredentialAuth,
  isAllowedWebSocketOrigin,
  validateConnectionAccess,
  type ConnectionCredential,
} from '../auth/middleware'
import { assertProductionSecrets, resolveDatabasePath } from '../configRules'
import { getDatabase, setDatabasePathForTests } from '../db/database'
import acpRoutes from '../routes/acp'
import v1EnvironmentWork from '../routes/v1/environments.work'
import v1SessionIngress from '../routes/v1/session-ingress'
import { incrementEpoch } from '../services/session'
import { createWorkItem, pollWork } from '../services/work-dispatch'
import {
  storeCreateAccount,
  storeCreateAuthToken,
  storeCreateEnvironment,
  storeCreateSession,
  storeGetEnvironment,
  storeGetEnvironmentByCredential,
  storeGetWorkItem,
  storeReset,
  storeRevokeAuthToken,
  storeSetAccountDisabled,
  storeWorkCredentialMatches,
} from '../store'
import {
  clearLiveConnections,
  registerLiveConnection,
} from '../transport/connection-registry'
import { getEventBus, removeEventBus } from '../transport/event-bus'
import { createSSEStream } from '../transport/sse-writer'
import { websocket } from '../transport/ws-shared'
import { handleSizedWsPayload } from '../transport/ws-payload'

beforeAll(() => setDatabasePathForTests(':memory:'))
beforeEach(() => {
  configMock.set(hardeningConfig)
  clearLiveConnections()
  storeReset()
})

function issueToken(
  accountId: string,
  kind: 'access' | 'browser',
  raw: string,
  ttlMs = 60_000,
) {
  const now = Date.now()
  storeCreateAuthToken({
    digest: digestToken(raw),
    accountId,
    kind,
    sessionId: null,
    expiresAt: new Date(now + ttlMs),
    createdAt: new Date(now),
    revokedAt: null,
    replacedByDigest: null,
  })
}

function expireToken(raw: string) {
  getDatabase()
    .query('UPDATE auth_tokens SET expires_at = ? WHERE digest = ?')
    .run(Date.now() - 1000, digestToken(raw))
}

/** Unwrap the base64url work secret handed to a bridge on poll. */
function decodeWorkSecret(secret: string | undefined): string {
  if (!secret) return ''
  const payload: unknown = JSON.parse(
    Buffer.from(secret, 'base64url').toString('utf8'),
  )
  return payload && typeof payload === 'object'
    ? String((payload as Record<string, unknown>).session_ingress_token ?? '')
    : ''
}

describe('S6/S9 config rules', () => {
  test('production rejects a pepper that reuses the JWT secret', () => {
    const shared = 'x'.repeat(40)
    expect(() =>
      assertProductionSecrets(
        { RCS_TOKEN_PEPPER: shared, RCS_WORKER_JWT_SECRET: shared },
        true,
      ),
    ).toThrow('must be different values')
  })

  test('production still rejects missing or short secrets', () => {
    expect(() =>
      assertProductionSecrets({ RCS_WORKER_JWT_SECRET: 'y'.repeat(40) }, true),
    ).toThrow('RCS_TOKEN_PEPPER must be at least 32 characters')
    expect(() =>
      assertProductionSecrets(
        { RCS_TOKEN_PEPPER: 'x'.repeat(40), RCS_WORKER_JWT_SECRET: 'short' },
        true,
      ),
    ).toThrow('RCS_WORKER_JWT_SECRET must be at least 32 characters')
  })

  test('distinct long secrets pass, and development is never gated', () => {
    expect(() =>
      assertProductionSecrets(
        {
          RCS_TOKEN_PEPPER: 'x'.repeat(40),
          RCS_WORKER_JWT_SECRET: 'y'.repeat(40),
        },
        true,
      ),
    ).not.toThrow()
    const shared = 'x'.repeat(40)
    expect(() =>
      assertProductionSecrets(
        { RCS_TOKEN_PEPPER: shared, RCS_WORKER_JWT_SECRET: shared },
        false,
      ),
    ).not.toThrow()
  })

  test('database path only defaults to /app/data in production', () => {
    expect(resolveDatabasePath(undefined, true, '/repo/data/rcs.sqlite')).toBe(
      '/app/data/rcs.sqlite',
    )
    expect(resolveDatabasePath(undefined, false, '/repo/data/rcs.sqlite')).toBe(
      '/repo/data/rcs.sqlite',
    )
    expect(resolveDatabasePath(':memory:', true, '/repo/data/rcs.sqlite')).toBe(
      ':memory:',
    )
  })
})

describe('S8 loopback CORS origins', () => {
  const previousNodeEnv = process.env.NODE_ENV

  afterAll(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
  })

  test('development keeps loopback origins for local dev servers', () => {
    process.env.NODE_ENV = 'test'
    expect(getAllowedWebCorsOrigins()).toContain('http://localhost:3000')
    expect(getAllowedWebCorsOrigins()).toContain('http://127.0.0.1:3000')
  })

  test('production drops loopback unless it is the deployment origin', () => {
    process.env.NODE_ENV = 'production'
    configMock.set({ ...hardeningConfig, baseUrl: 'https://rcs.example' })
    const origins = getAllowedWebCorsOrigins()
    expect(origins).not.toContain('http://localhost:3000')
    expect(origins).not.toContain('http://127.0.0.1:3000')
    expect(origins).toContain('https://rcs.example')
    expect(origins).toContain('https://dashboard.example')

    configMock.set({ ...hardeningConfig, baseUrl: 'http://localhost:3000' })
    expect(getAllowedWebCorsOrigins()).toContain('http://localhost:3000')
  })
})

describe('S7 WebSocket upgrade origin', () => {
  async function originVerdict(headers: Record<string, string>) {
    const app = new Hono()
    let allowed: boolean | undefined
    app.get('/ws', c => {
      allowed = isAllowedWebSocketOrigin(c)
      return c.text('ok')
    })
    await app.request('http://localhost:3000/ws', { headers })
    return allowed
  }

  test('accepts the request origin, the base URL and the CORS allowlist', async () => {
    expect(await originVerdict({ Origin: 'http://localhost:3000' })).toBe(true)
    expect(await originVerdict({ Origin: 'https://dashboard.example' })).toBe(
      true,
    )
  })

  test('rejects a missing or foreign Origin', async () => {
    expect(await originVerdict({})).toBe(false)
    expect(await originVerdict({ Origin: 'https://attacker.example' })).toBe(
      false,
    )
  })
})

describe('S2 credential revalidation verdicts', () => {
  test('an account token stops validating once revoked or expired', () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    issueToken(account.id, 'access', 'live-token')
    const credential: ConnectionCredential = {
      type: 'account',
      token: 'live-token',
      kind: 'access',
    }
    expect(validateConnectionAccess(credential, account.id).ok).toBe(true)

    storeRevokeAuthToken(digestToken('live-token'), account.id)
    expect(validateConnectionAccess(credential, account.id)).toEqual({
      ok: false,
      reason: 'token_revoked',
    })

    issueToken(account.id, 'access', 'expiring-token')
    const expiring: ConnectionCredential = {
      type: 'account',
      token: 'expiring-token',
      kind: 'access',
    }
    expect(validateConnectionAccess(expiring, account.id).ok).toBe(true)
    expireToken('expiring-token')
    expect(validateConnectionAccess(expiring, account.id)).toEqual({
      ok: false,
      reason: 'token_expired',
    })
  })

  test('a worker JWT stops validating after an epoch rotation', () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    const session = storeCreateSession({ accountId: account.id })
    const token = generateWorkerJwt(account.id, session.id, 900)
    const credential: ConnectionCredential = {
      type: 'worker',
      token,
      sessionId: session.id,
    }
    expect(
      validateConnectionAccess(credential, account.id, session.id).ok,
    ).toBe(true)

    incrementEpoch(session.id, account.id)
    expect(
      validateConnectionAccess(credential, account.id, session.id),
    ).toEqual({ ok: false, reason: 'token_revoked' })
  })

  test('an expired worker JWT is reported as expired, not revoked', () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    const session = storeCreateSession({ accountId: account.id })
    const token = generateWorkerJwt(account.id, session.id, -1)
    expect(
      validateConnectionAccess(
        { type: 'worker', token, sessionId: session.id },
        account.id,
        session.id,
      ),
    ).toEqual({ ok: false, reason: 'token_expired' })
  })

  test('an environment credential stops validating once the account is disabled', () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    const environment = storeCreateEnvironment({
      accountId: account.id,
      secret: 'environment-token',
    })
    const credential: ConnectionCredential = {
      type: 'environment',
      token: 'environment-token',
      environmentId: environment.id,
    }
    expect(validateConnectionAccess(credential, account.id).ok).toBe(true)
    storeSetAccountDisabled(account.id, true)
    expect(validateConnectionAccess(credential, account.id).ok).toBe(false)
  })
})

describe('S2 proactive eviction on revocation', () => {
  test('logout closes live connections of that account only', () => {
    const alice = storeCreateAccount('alice', '$argon2id$hash')
    const bob = storeCreateAccount('bob', '$argon2id$hash')
    issueToken(alice.id, 'access', 'alice-token')
    issueToken(bob.id, 'access', 'bob-token')

    const closed: string[] = []
    registerLiveConnection({
      accountId: alice.id,
      revalidate: () =>
        validateConnectionAccess(
          { type: 'account', token: 'alice-token', kind: 'access' },
          alice.id,
        ),
      close: reason => closed.push(`alice:${reason}`),
    })
    registerLiveConnection({
      accountId: bob.id,
      revalidate: () =>
        validateConnectionAccess(
          { type: 'account', token: 'bob-token', kind: 'access' },
          bob.id,
        ),
      close: reason => closed.push(`bob:${reason}`),
    })

    storeRevokeAuthToken(digestToken('alice-token'), alice.id)
    expect(closed).toEqual(['alice:token_revoked'])
  })

  test('epoch rotation closes only the rotated session', () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    const rotated = storeCreateSession({ accountId: account.id })
    const untouched = storeCreateSession({ accountId: account.id })
    const rotatedJwt = generateWorkerJwt(account.id, rotated.id, 900)
    const untouchedJwt = generateWorkerJwt(account.id, untouched.id, 900)

    const closed: string[] = []
    for (const [session, token] of [
      [rotated.id, rotatedJwt],
      [untouched.id, untouchedJwt],
    ] as const) {
      registerLiveConnection({
        accountId: account.id,
        sessionId: session,
        revalidate: () =>
          validateConnectionAccess(
            { type: 'worker', token, sessionId: session },
            account.id,
            session,
          ),
        close: reason => closed.push(`${session}:${reason}`),
      })
    }

    incrementEpoch(rotated.id, account.id)
    expect(closed).toEqual([`${rotated.id}:token_revoked`])
  })

  test('disabling an account closes its connections', () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    issueToken(account.id, 'browser', 'browser-token')
    const closed: string[] = []
    registerLiveConnection({
      accountId: account.id,
      revalidate: () =>
        validateConnectionAccess(
          { type: 'account', token: 'browser-token', kind: 'browser' },
          account.id,
        ),
      close: reason => closed.push(reason),
    })
    storeSetAccountDisabled(account.id, true)
    expect(closed).toEqual(['account_revoked'])
  })
})

describe('S3 SSE stream revalidation', () => {
  beforeEach(() => {
    removeEventBus('sse_session')
  })

  async function openGuardedStream(accountId: string, token: string) {
    const app = new Hono()
    app.get('/events', c =>
      createSSEStream(c, 'sse_session', 0, {
        accountId,
        revalidate: () =>
          validateConnectionAccess(
            { type: 'account', token, kind: 'browser' },
            accountId,
          ),
      }),
    )
    const response = await app.request('/events')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const first = await reader.read()
    expect(decoder.decode(first.value)).toContain(': keepalive')
    return { reader, decoder }
  }

  test('revoking the cookie terminates an open stream', async () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    issueToken(account.id, 'browser', 'browser-token')
    const { reader, decoder } = await openGuardedStream(
      account.id,
      'browser-token',
    )

    storeRevokeAuthToken(digestToken('browser-token'), account.id)

    const closing = await reader.read()
    const text = decoder.decode(closing.value)
    expect(text).toContain('event: closed')
    expect(text).toContain('token_revoked')
    expect((await reader.read()).done).toBe(true)
  })

  test('an expired credential is caught on the next delivered event', async () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    issueToken(account.id, 'browser', 'browser-token')
    const { reader, decoder } = await openGuardedStream(
      account.id,
      'browser-token',
    )

    // Expiry raises no revocation event, so nothing is swept: the stream must
    // notice it the next time it is about to deliver something.
    expireToken('browser-token')
    getEventBus('sse_session').publish({
      id: 'e1',
      sessionId: 'sse_session',
      type: 'assistant',
      payload: { content: 'must not be delivered' },
      direction: 'inbound',
    })

    const closing = await reader.read()
    const text = decoder.decode(closing.value)
    expect(text).toContain('event: closed')
    expect(text).toContain('token_expired')
    expect(text).not.toContain('must not be delivered')
  })
})

describe('S4 disable-user invalidates every credential shape', () => {
  test('environment and work credentials die with the account', async () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    const environment = storeCreateEnvironment({
      accountId: account.id,
      secret: 'environment-token',
    })
    const session = storeCreateSession({
      accountId: account.id,
      environmentId: environment.id,
    })
    const workId = await createWorkItem(environment.id, session.id, account.id)
    const dispatched = await pollWork(environment.id, 1, account.id)
    const workerToken = decodeWorkSecret(dispatched?.secret)
    expect(storeWorkCredentialMatches(workId, account.id, workerToken)).toBe(
      true,
    )
    expect(
      storeGetEnvironmentByCredential('environment-token', environment.id),
    ).toBeTruthy()

    storeSetAccountDisabled(account.id, true)

    expect(
      storeGetEnvironmentByCredential('environment-token', environment.id),
    ).toBeUndefined()
    expect(storeGetEnvironment(environment.id)?.status).toBe('deregistered')
    expect(storeWorkCredentialMatches(workId, account.id, workerToken)).toBe(
      false,
    )
    expect(storeGetWorkItem(workId)?.credentialDigest).toBeNull()
  })

  test('work/poll with a kept environment credential 401s after disable', async () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    const environment = storeCreateEnvironment({
      accountId: account.id,
      secret: 'environment-token',
    })
    const session = storeCreateSession({
      accountId: account.id,
      environmentId: environment.id,
    })
    await createWorkItem(environment.id, session.id, account.id)
    const app = new Hono()
    app.route('/v1/environments', v1EnvironmentWork)
    const request = () =>
      app.request(`/v1/environments/${environment.id}/work/poll`, {
        headers: { Authorization: 'Bearer environment-token' },
      })

    expect((await request()).status).toBe(200)
    storeSetAccountDisabled(account.id, true)
    expect((await request()).status).toBe(401)
  })
})

describe('S5 bridge credential auth enforces the worker epoch', () => {
  test('a JWT minted before rotation is rejected on bridge routes', async () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    const environment = storeCreateEnvironment({
      accountId: account.id,
      secret: 'environment-token',
    })
    const session = storeCreateSession({
      accountId: account.id,
      environmentId: environment.id,
    })
    const staleJwt = generateWorkerJwt(account.id, session.id, 900)

    const app = new Hono()
    app.get('/probe/:id', bridgeCredentialAuth, c =>
      c.json({ accountId: c.get('accountId') }),
    )
    const probe = () =>
      app.request(`/probe/${environment.id}`, {
        headers: { Authorization: `Bearer ${staleJwt}` },
      })

    expect((await probe()).status).toBe(200)
    incrementEpoch(session.id, account.id)
    expect((await probe()).status).toBe(401)
  })

  test('ack with a stale-epoch JWT is rejected before the handler', async () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    const environment = storeCreateEnvironment({
      accountId: account.id,
      secret: 'environment-token',
    })
    const session = storeCreateSession({
      accountId: account.id,
      environmentId: environment.id,
    })
    const workId = await createWorkItem(environment.id, session.id, account.id)
    const staleJwt = generateWorkerJwt(account.id, session.id, 900)
    incrementEpoch(session.id, account.id)

    const app = new Hono()
    app.route('/v1/environments', v1EnvironmentWork)
    for (const route of ['ack', 'heartbeat']) {
      const response = await app.request(
        `/v1/environments/${environment.id}/work/${workId}/${route}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${staleJwt}` },
        },
      )
      expect(response.status).toBe(401)
    }
  })
})

describe('S1 WebSocket handler errors never escape', () => {
  function mockWs() {
    const sent: string[] = []
    let closed: { code?: number; reason?: string } | undefined
    return {
      readyState: 1,
      send: (data: string) => sent.push(data),
      close: (code?: number, reason?: string) => {
        closed = { code, reason }
      },
      sent,
      getClosed: () => closed,
    }
  }

  test('a throwing handler is contained and answered with a generic frame', () => {
    const ws = mockWs()
    const handled = handleSizedWsPayload(
      ws as never,
      '[TEST]',
      'label',
      '{"type":"boom"}',
      () => {
        throw new Error('secret internal detail')
      },
    )
    expect(handled).toBe(false)
    expect(ws.getClosed()).toBeUndefined()
    expect(ws.sent).toHaveLength(1)
    const frame = JSON.parse(ws.sent[0]!) as Record<string, unknown>
    expect(frame).toEqual({ type: 'error', message: 'Internal server error' })
  })

  test('a well-behaved handler still runs normally', () => {
    const ws = mockWs()
    const seen: string[] = []
    expect(
      handleSizedWsPayload(ws as never, '[TEST]', 'label', 'hello', data =>
        seen.push(data),
      ),
    ).toBe(true)
    expect(seen).toEqual(['hello'])
    expect(ws.sent).toHaveLength(0)
  })
})

/**
 * Everything above drives the handlers directly. These run a real Bun server on
 * an ephemeral loopback port, because the S1 failure mode — an exception
 * escaping into Bun's WebSocket dispatcher and taking the process down — only
 * exists on the real dispatch path.
 */
describe('live WebSocket transport', () => {
  let server: ReturnType<typeof Bun.serve> | undefined
  let origin = ''
  const openSockets: WebSocket[] = []

  beforeAll(() => {
    const app = new Hono()
    app.get('/health', c => c.json({ status: 'ok' }))
    app.route('/v1/session_ingress', v1SessionIngress)
    app.route('/acp', acpRoutes)
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: app.fetch,
      websocket,
    })
    origin = `http://127.0.0.1:${server.port}`
  })

  afterAll(() => {
    for (const socket of openSockets) {
      try {
        socket.close()
      } catch {
        // already gone
      }
    }
    server?.stop(true)
  })

  function connect(path: string, headers: Record<string, string>) {
    const socket = new WebSocket(`ws://127.0.0.1:${server?.port}${path}`, {
      headers,
    } as unknown as string[])
    openSockets.push(socket)
    return socket
  }

  function opened(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('open timeout')), 5000)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('socket error'))
      })
    })
  }

  function nextMessage(socket: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('message timeout')), 5000)
      socket.addEventListener(
        'message',
        event => {
          clearTimeout(timer)
          resolve(String(event.data))
        },
        { once: true },
      )
    })
  }

  function closedWith(
    socket: WebSocket,
  ): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('close timeout')), 5000)
      socket.addEventListener(
        'close',
        event => {
          clearTimeout(timer)
          resolve({ code: event.code, reason: event.reason })
        },
        { once: true },
      )
    })
  }

  async function registerAcpAgent(token: string, name: string) {
    const socket = connect('/acp/ws', { Authorization: `Bearer ${token}` })
    await opened(socket)
    const reply = nextMessage(socket)
    socket.send(JSON.stringify({ type: 'register', agent_name: name }))
    return { socket, frame: JSON.parse(await reply) as Record<string, unknown> }
  }

  test('S1: exceeding the environment quota answers with an error frame and the server survives', async () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    issueToken(account.id, 'access', 'acp-token')

    const first = await registerAcpAgent('acp-token', 'agent-1')
    expect(first.frame.type).toBe('registered')
    const second = await registerAcpAgent('acp-token', 'agent-2')
    expect(second.frame.type).toBe('registered')

    // Third registration trips maxEnvironmentsPerAccount=2. Before the fix the
    // throw escaped into Bun's dispatcher and killed the process.
    const third = await registerAcpAgent('acp-token', 'agent-3')
    expect(third.frame).toEqual({
      type: 'error',
      message: 'Environment quota exceeded',
    })
    expect(third.socket.readyState).toBe(WebSocket.OPEN)

    const health = await fetch(`${origin}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'ok' })

    for (const entry of [first, second, third]) entry.socket.close()
  })

  test('S2: revoking the access token closes a live session-ingress socket', async () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    issueToken(account.id, 'access', 'ingress-token')
    const session = storeCreateSession({ accountId: account.id })

    const socket = connect(`/v1/session_ingress/ws/${session.id}`, {
      Authorization: 'Bearer ingress-token',
    })
    await opened(socket)
    const closing = closedWith(socket)

    storeRevokeAuthToken(digestToken('ingress-token'), account.id)

    const { code, reason } = await closing
    expect(code).toBe(4002)
    expect(reason).toBe('token_revoked')
  })

  test('S2: rotating the worker epoch closes a socket holding the old JWT', async () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    const session = storeCreateSession({ accountId: account.id })
    const jwt = generateWorkerJwt(account.id, session.id, 900)

    const socket = connect(`/v1/session_ingress/ws/${session.id}`, {
      Authorization: `Bearer ${jwt}`,
    })
    await opened(socket)
    const closing = closedWith(socket)

    incrementEpoch(session.id, account.id)

    expect((await closing).code).toBe(4002)
  })

  test('S2: an expired token is rejected on the next frame', async () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    issueToken(account.id, 'access', 'expiring-ingress')
    const session = storeCreateSession({ accountId: account.id })

    const socket = connect(`/v1/session_ingress/ws/${session.id}`, {
      Authorization: 'Bearer expiring-ingress',
    })
    await opened(socket)
    const closing = closedWith(socket)

    // Expiry fires no revocation event; only the frame check can catch it.
    expireToken('expiring-ingress')
    socket.send('{"type":"user","message":{"role":"user","content":"hi"}}\n')

    const { code, reason } = await closing
    expect(code).toBe(4002)
    expect(reason).toBe('token_expired')
    expect(getEventBus(session.id).getEventsSince(0)).toHaveLength(0)
  })

  test('S7: a cookie-authenticated upgrade is rejected from a foreign origin', async () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    issueToken(account.id, 'browser', 'cookie-token')
    const cookie = `${BROWSER_SESSION_COOKIE}=cookie-token`

    const foreign = connect('/acp/ws', {
      Cookie: cookie,
      Origin: 'https://attacker.example',
    })
    const rejected = closedWith(foreign)
    await opened(foreign)
    expect((await rejected).code).toBe(4003)

    const sameOrigin = connect('/acp/ws', { Cookie: cookie, Origin: origin })
    await opened(sameOrigin)
    const reply = nextMessage(sameOrigin)
    sameOrigin.send(JSON.stringify({ type: 'register', agent_name: 'web' }))
    expect((JSON.parse(await reply) as Record<string, unknown>).type).toBe(
      'registered',
    )
    sameOrigin.close()
  })
})
