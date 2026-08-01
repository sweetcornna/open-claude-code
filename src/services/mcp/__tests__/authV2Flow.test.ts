/**
 * Runtime proof that `ClaudeAuthProvider` drives the v2 SDK's OAuth flow.
 *
 * The migration to `@modelcontextprotocol/client@2` left the provider merely
 * *structurally* compatible with v2's `OAuthClientProvider`: tsc is satisfied,
 * but nothing had ever run v2's `auth()` against it. Type compatibility is the
 * weakest of the guarantees that matter here — v2 added a whole SEP-2352
 * issuer-binding protocol on top of the same method names, and a provider that
 * ignores it type-checks perfectly while quietly handing credentials to the
 * wrong authorization server.
 *
 * So this drives a real `StreamableHTTPClientTransport` against a real HTTP
 * fixture that 401s a stale token and only accepts the one minted by a refresh.
 * Everything in between — RFC 9728 discovery, the issuer hooks, the refresh
 * grant, the retry — is the SDK's own code path, unmocked.
 */
import {
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http'
import type { AddressInfo } from 'net'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'
import { secureStorageMock } from '../../../../tests/mocks/secureStorage'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/secureStorage/index.ts', secureStorageMock.mock)

// `mcpClientIdentity()` reads `MACRO.VERSION` when a client is constructed.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as unknown as { MACRO: unknown }).MACRO = {
    VERSION: '0.0.0-test',
    BUILD_TIME: '0',
  }
}

// Dynamic so the mocks above land first, and at module scope so `auth.ts`'s
// import graph is not charged to the first test's timeout.
const { ClaudeAuthProvider, getServerKey } = await import('../auth.js')
const { issuerScopedKey } = await import('../oauthCredentialKey.js')
const { createMcpClient } = await import('../clientFactory.js')

const SERVER_NAME = 'fixture-mcp'
const STALE_TOKEN = 'stale-access-token'
const FRESH_TOKEN = 'fresh-access-token'
const GOOD_REFRESH_TOKEN = 'valid-refresh-token'
const ROTATED_REFRESH_TOKEN = 'rotated-refresh-token'

type FixtureLog = {
  unauthorized: number
  refreshes: Array<Record<string, string>>
  registrations: Array<Record<string, unknown>>
  authorizedCalls: string[]
}

let server: Server
let origin: string
let log: FixtureLog

/** Only this token is accepted; the seeded one is deliberately not it. */
const acceptedToken = () => FRESH_TOKEN

function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname

      // RFC 9728: protected-resource metadata, both the path-aware and root
      // probes the SDK tries.
      if (path.startsWith('/.well-known/oauth-protected-resource')) {
        json(res, 200, {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ['mcp:read'],
        })
        return
      }

      // RFC 8414. `issuer` must echo the URL discovery was aimed at or the v2
      // SDK rejects the document (§3.3).
      if (path === '/.well-known/oauth-authorization-server') {
        json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          authorization_response_iss_parameter_supported: true,
          scopes_supported: ['mcp:read'],
        })
        return
      }

      if (path === '/register' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        log.registrations.push(body)
        json(res, 201, {
          client_id: 'registered-client-id',
          redirect_uris: body.redirect_uris,
        })
        return
      }

      if (path === '/token' && req.method === 'POST') {
        const params = Object.fromEntries(
          new URLSearchParams(await readBody(req)),
        )
        log.refreshes.push(params)
        if (
          params.grant_type === 'refresh_token' &&
          params.refresh_token === GOOD_REFRESH_TOKEN
        ) {
          json(res, 200, {
            access_token: FRESH_TOKEN,
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: ROTATED_REFRESH_TOKEN,
            scope: 'mcp:read',
          })
          return
        }
        json(res, 400, { error: 'invalid_grant' })
        return
      }

      if (path === '/mcp') {
        if (req.method !== 'POST') {
          // The SDK treats 405 on GET/DELETE as "no server-initiated stream".
          res.writeHead(405).end()
          return
        }

        const authorization = req.headers.authorization
        if (authorization !== `Bearer ${acceptedToken()}`) {
          log.unauthorized++
          res.writeHead(401, {
            'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          })
          res.end()
          return
        }

        const message = JSON.parse((await readBody(req)) || '{}')
        log.authorizedCalls.push(message.method)

        if (message.method === 'initialize') {
          json(res, 200, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1.0.0' },
            },
          })
          return
        }
        if (message.method === 'tools/list') {
          json(res, 200, {
            jsonrpc: '2.0',
            id: message.id,
            result: { tools: [] },
          })
          return
        }
        // Notifications carry no id and want no body.
        res.writeHead(202).end()
        return
      }

      res.writeHead(404).end()
    })()
  })

  await new Promise<void>(resolve =>
    server.listen(0, '127.0.0.1', () => resolve()),
  )
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

// The mock's store is process-global; every test states its own starting
// point rather than inheriting one.
beforeEach(() => {
  secureStorageMock.reset()
})

function serverConfig() {
  return { type: 'http', url: `${origin}/mcp` } as const
}

function slots() {
  const base = getServerKey(SERVER_NAME, serverConfig())
  return { base, scoped: issuerScopedKey(base, origin) }
}

function resetLog() {
  log = {
    unauthorized: 0,
    refreshes: [],
    registrations: [],
    authorizedCalls: [],
  }
}

describe('ClaudeAuthProvider against the v2 transport', () => {
  test('recovers from a 401 by refreshing, and the connection completes', async () => {
    resetLog()
    // Deliberately seeded under the pre-issuer base key with no issuer stamp —
    // the state every existing install upgrades from.
    secureStorageMock.seed({
      mcpOAuth: {
        [slots().base]: {
          serverName: SERVER_NAME,
          serverUrl: `${origin}/mcp`,
          accessToken: STALE_TOKEN,
          refreshToken: GOOD_REFRESH_TOKEN,
          // Far from expiry, so nothing refreshes proactively: the refresh has
          // to be driven by the server's 401 through v2's `auth()`.
          expiresAt: Date.now() + 3_600_000,
          clientId: 'seeded-client-id',
        },
      },
    })

    const provider = new ClaudeAuthProvider(SERVER_NAME, serverConfig())
    const transport = new StreamableHTTPClientTransport(
      new URL(`${origin}/mcp`),
      { authProvider: provider },
    )
    const client = createMcpClient()

    await client.connect(transport)
    try {
      expect(await client.listTools()).toEqual({ tools: [] })
    } finally {
      await client.close()
    }

    expect(log.unauthorized).toBe(1)
    expect(log.refreshes).toHaveLength(1)
    expect(log.refreshes[0]).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: GOOD_REFRESH_TOKEN,
      client_id: 'seeded-client-id',
    })
    // The retry and everything after it carried the refreshed token.
    expect(log.authorizedCalls).toContain('initialize')
    expect(log.authorizedCalls).toContain('tools/list')

    // Discovery named the issuer, so the credentials moved off the legacy key
    // and the rotated refresh token landed with them.
    const stored = (secureStorageMock.snapshot()?.mcpOAuth ?? {}) as Record<
      string,
      Record<string, unknown>
    >
    expect(stored[slots().base]).toBeUndefined()
    expect(stored[slots().scoped]).toMatchObject({
      accessToken: FRESH_TOKEN,
      refreshToken: ROTATED_REFRESH_TOKEN,
      issuer: origin,
    })
  }, 30_000)

  test('registers as a native client (RFC 8252) when it has to fall back to DCR', async () => {
    resetLog()
    // No stored credentials at all: `auth()` must register, then ask for user
    // consent. `handleRedirection` is off, so the redirect is a no-op and the
    // transport surfaces the flow as unauthorized — which is the point at
    // which the registration body is all we care about.
    const provider = new ClaudeAuthProvider(SERVER_NAME, serverConfig())
    const transport = new StreamableHTTPClientTransport(
      new URL(`${origin}/mcp`),
      { authProvider: provider },
    )
    const client = createMcpClient()

    await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError)

    expect(log.registrations).toHaveLength(1)
    expect(log.registrations[0]).toMatchObject({
      application_type: 'native',
      token_endpoint_auth_method: 'none',
      redirect_uris: [provider.redirectUrl],
    })
  }, 30_000)
})
