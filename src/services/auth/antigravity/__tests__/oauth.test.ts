import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { debugMock } from '../../../../../tests/mocks/debug.js'
import { setupAntigravityStoreMock } from '../../../../../tests/mocks/antigravityStore.js'
import type { AntigravityTokens } from '../store.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)

// The installed-app client is user-supplied (see constants.ts), so the suite
// injects its own. Set before any describe body builds a URL.
process.env.OCC_ANTIGRAVITY_CLIENT_ID =
  'test-client-not-real.apps.googleusercontent.com'
process.env.OCC_ANTIGRAVITY_CLIENT_SECRET = 'test-client-secret-not-real'

// ---------------------------------------------------------------------------
// The credential store goes through the shared complete-surface mock so no test
// here touches occConfigDir() — it is memoized on first call, so a temp-dir
// override installed later would silently write to the developer's real config.
// Overrides are dropped in afterAll(); mock.module is process-global.
// ---------------------------------------------------------------------------
let saved: AntigravityTokens[] = []
let stored: AntigravityTokens | null = null
const storeMock = setupAntigravityStoreMock({
  readAntigravityTokens: async () => stored,
  saveAntigravityTokens: async (tokens: AntigravityTokens) => {
    saved.push(tokens)
    stored = tokens
  },
  removeAntigravityTokens: async () => {
    stored = null
  },
})
afterAll(() => {
  storeMock.reset()
})

import {
  _resetAntigravityRefreshStateForTesting,
  buildAntigravityAuthUrl,
  discoverAntigravityProject,
  exchangeAntigravityCode,
  getAntigravityAccessToken,
  getValidAntigravityAuth,
  refreshAntigravityTokens,
  removeAntigravityAuth,
} from '../oauth.js'

const HOUR_MS = 60 * 60 * 1000

function tokens(overrides: Partial<AntigravityTokens> = {}): AntigravityTokens {
  return {
    accessToken: 'access-old',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() + HOUR_MS,
    projectId: 'proj-1',
    ...overrides,
  }
}

type Call = { url: string; init: RequestInit }

/**
 * A fetch stub over a scripted queue of responses. Every test in this file uses
 * it — no test is allowed to reach the network.
 */
function stubFetch(
  responses: Array<{ status?: number; json?: unknown; text?: string }>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const queue = [...responses]
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    const next = queue.shift()
    if (!next) throw new Error(`unexpected fetch call to ${String(url)}`)
    const status = next.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => next.json,
      text: async () => next.text ?? JSON.stringify(next.json ?? ''),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function formOf(call: Call): URLSearchParams {
  return new URLSearchParams(String(call.init.body))
}

function deferredTokenFetch(): {
  fetchImpl: typeof fetch
  started: Promise<void>
  respond: (json: unknown) => void
  calls: Call[]
} {
  const calls: Call[] = []
  let markStarted: (() => void) | undefined
  let resolveResponse: ((response: Response) => void) | undefined
  const started = new Promise<void>(resolve => {
    markStarted = resolve
  })
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    markStarted?.()
    return await new Promise<Response>((resolve, reject) => {
      resolveResponse = resolve
      init.signal?.addEventListener(
        'abort',
        () => reject(new Error('refresh aborted')),
        { once: true },
      )
    })
  }) as unknown as typeof fetch
  return {
    fetchImpl,
    started,
    calls,
    respond: json => {
      resolveResponse?.({
        ok: true,
        status: 200,
        json: async () => json,
        text: async () => JSON.stringify(json),
      } as unknown as Response)
    },
  }
}

beforeEach(() => {
  saved = []
  stored = null
  _resetAntigravityRefreshStateForTesting()
})

afterEach(() => {
  _resetAntigravityRefreshStateForTesting()
})

describe('buildAntigravityAuthUrl', () => {
  const url = buildAntigravityAuthUrl({
    state: 'st-1',
    redirectUri: 'http://localhost:51121/oauth-callback',
  })
  const parsed = new URL(url)

  test('targets Google consent with the Antigravity installed-app client', () => {
    expect(parsed.origin + parsed.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    )
    expect(parsed.searchParams.get('client_id')).toContain(
      '.apps.googleusercontent.com',
    )
    expect(parsed.searchParams.get('response_type')).toBe('code')
  })

  test('requests offline access with forced consent so a refresh token is issued', () => {
    // Without both, Google withholds refresh_token on repeat authorizations and
    // every login silently becomes a one-hour session.
    expect(parsed.searchParams.get('access_type')).toBe('offline')
    expect(parsed.searchParams.get('prompt')).toBe('consent')
  })

  test('carries the state and loopback redirect verbatim', () => {
    expect(parsed.searchParams.get('state')).toBe('st-1')
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'http://localhost:51121/oauth-callback',
    )
  })

  test('asks for the cloud-platform scope the Cloud Code backend requires', () => {
    const scopes = (parsed.searchParams.get('scope') ?? '').split(' ')
    expect(scopes).toContain('https://www.googleapis.com/auth/cloud-platform')
    expect(scopes).toContain('https://www.googleapis.com/auth/userinfo.email')
  })
})

describe('exchangeAntigravityCode', () => {
  test('posts an authorization_code grant with the client secret', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        json: {
          access_token: 'a-1',
          refresh_token: 'r-1',
          expires_in: 3600,
        },
      },
    ])
    const result = await exchangeAntigravityCode({
      code: 'code-1',
      redirectUri: 'http://localhost:51121/oauth-callback',
      fetchImpl,
    })
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token')
    const form = formOf(calls[0]!)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('code-1')
    expect(form.get('client_secret')).toBeTruthy()
    expect(result.accessToken).toBe('a-1')
    expect(result.refreshToken).toBe('r-1')
  })

  test('converts expires_in into an absolute expiry', async () => {
    const { fetchImpl } = stubFetch([
      { json: { access_token: 'a', refresh_token: 'r', expires_in: 120 } },
    ])
    const before = Date.now()
    const result = await exchangeAntigravityCode({
      code: 'c',
      redirectUri: 'http://localhost/cb',
      fetchImpl,
    })
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 120_000)
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 120_000)
  })

  test('surfaces the HTTP status and body on failure', async () => {
    const { fetchImpl } = stubFetch([{ status: 400, text: 'invalid_grant' }])
    await expect(
      exchangeAntigravityCode({
        code: 'bad',
        redirectUri: 'http://localhost/cb',
        fetchImpl,
      }),
    ).rejects.toThrow(/400.*invalid_grant/)
  })
})

describe('refreshAntigravityTokens', () => {
  test('sends a refresh_token grant', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { access_token: 'a-2', expires_in: 3600 } },
    ])
    await refreshAntigravityTokens(tokens(), fetchImpl)
    const form = formOf(calls[0]!)
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('refresh-1')
  })

  test('keeps the existing refresh token when Google omits it', async () => {
    // Google only returns refresh_token on the initial exchange; dropping it
    // here would make the very next refresh fail with "missing refresh token".
    const { fetchImpl } = stubFetch([
      { json: { access_token: 'a-2', expires_in: 3600 } },
    ])
    const result = await refreshAntigravityTokens(tokens(), fetchImpl)
    expect(result.refreshToken).toBe('refresh-1')
    expect(result.accessToken).toBe('a-2')
  })

  test('adopts a rotated refresh token when one is returned', async () => {
    const { fetchImpl } = stubFetch([
      { json: { access_token: 'a-2', refresh_token: 'r-2', expires_in: 60 } },
    ])
    const result = await refreshAntigravityTokens(tokens(), fetchImpl)
    expect(result.refreshToken).toBe('r-2')
  })

  test('carries the project id across a refresh', async () => {
    const { fetchImpl } = stubFetch([
      { json: { access_token: 'a-2', expires_in: 60 } },
    ])
    const result = await refreshAntigravityTokens(tokens(), fetchImpl)
    expect(result.projectId).toBe('proj-1')
  })
})

describe('discoverAntigravityProject', () => {
  test('returns the project loadCodeAssist already knows about', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { cloudaicompanionProject: 'proj-existing' } },
    ])
    const projectId = await discoverAntigravityProject({
      accessToken: 'a',
      fetchImpl,
    })
    expect(projectId).toBe('proj-existing')
    expect(calls[0]!.url).toBe(
      'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    )
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      metadata: { ideType: 'ANTIGRAVITY' },
    })
    // One call only: no onboarding needed for an established account.
    expect(calls).toHaveLength(1)
  })

  test('onboards a brand-new account and polls until the operation completes', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { allowedTiers: [{ id: 'paid-tier', isDefault: true }] } },
      { json: { done: false } },
      {
        json: { done: true, response: { cloudaicompanionProject: 'proj-new' } },
      },
    ])
    const projectId = await discoverAntigravityProject({
      accessToken: 'a',
      fetchImpl,
    })
    expect(projectId).toBe('proj-new')
    expect(calls[1]!.url).toBe(
      'https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser',
    )
    expect(JSON.parse(String(calls[1]!.init.body)).tier_id).toBe('paid-tier')
  }, 10_000)

  test('falls back to free-tier when no default tier is advertised', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: {} },
      { json: { done: true, response: { cloudaicompanionProject: 'p' } } },
    ])
    await discoverAntigravityProject({ accessToken: 'a', fetchImpl })
    expect(JSON.parse(String(calls[1]!.init.body)).tier_id).toBe('free-tier')
  })

  test('sends the long control-plane UA and api-client header on onboardUser', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: {} },
      { json: { done: true, response: { cloudaicompanionProject: 'p' } } },
    ])
    await discoverAntigravityProject({ accessToken: 'a', fetchImpl })
    const headers = calls[1]!.init.headers as Record<string, string>
    expect(headers['User-Agent']).toContain('google-api-nodejs-client/')
    expect(headers['X-Goog-Api-Client']).toBe('gl-node/22.21.1')
  })

  test('raises an actionable error when onboarding yields no project', async () => {
    const { fetchImpl } = stubFetch([
      { json: {} },
      { json: { done: true, response: {} } },
    ])
    await expect(
      discoverAntigravityProject({ accessToken: 'a', fetchImpl }),
    ).rejects.toThrow(/Open Antigravity once with this Google account/)
  })

  test('surfaces a failing loadCodeAssist rather than silently onboarding', async () => {
    const { fetchImpl } = stubFetch([{ status: 403, text: 'forbidden' }])
    await expect(
      discoverAntigravityProject({ accessToken: 'a', fetchImpl }),
    ).rejects.toThrow(/loadCodeAssist failed \(403\)/)
  })
})

describe('getAntigravityAccessToken', () => {
  test('returns null when nothing is stored — a probe, not an error', async () => {
    stored = null
    const { fetchImpl } = stubFetch([])
    expect(await getAntigravityAccessToken(fetchImpl)).toBeNull()
  })

  test('returns the stored token without a network call while it is fresh', async () => {
    stored = tokens({ expiresAt: Date.now() + HOUR_MS })
    const { fetchImpl, calls } = stubFetch([])
    expect(await getAntigravityAccessToken(fetchImpl)).toBe('access-old')
    expect(calls).toHaveLength(0)
  })

  test('refreshes ahead of expiry and persists the new token', async () => {
    // Inside the 5-minute skew: still technically valid, refreshed anyway so a
    // long request cannot expire mid-flight.
    stored = tokens({ expiresAt: Date.now() + 60_000 })
    const { fetchImpl, calls } = stubFetch([
      { json: { access_token: 'access-new', expires_in: 3600 } },
    ])
    expect(await getAntigravityAccessToken(fetchImpl)).toBe('access-new')
    expect(calls).toHaveLength(1)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.accessToken).toBe('access-new')
  })

  test('returns null instead of throwing when the refresh token is revoked', async () => {
    stored = tokens({ expiresAt: Date.now() - 1 })
    const { fetchImpl } = stubFetch([{ status: 400, text: 'invalid_grant' }])
    expect(await getAntigravityAccessToken(fetchImpl)).toBeNull()
  })

  test('deduplicates concurrent refreshes into a single token request', async () => {
    // Google invalidates the previous access token on refresh, so a racing pair
    // would leave one caller holding a dead token.
    stored = tokens({ expiresAt: Date.now() - 1 })
    const { fetchImpl, calls } = stubFetch([
      { json: { access_token: 'access-new', expires_in: 3600 } },
    ])
    const results = await Promise.all([
      getAntigravityAccessToken(fetchImpl),
      getAntigravityAccessToken(fetchImpl),
    ])
    expect(results).toEqual(['access-new', 'access-new'])
    expect(calls).toHaveLength(1)
  })

  test('does not share or persist a refresh across an account switch', async () => {
    stored = tokens({ expiresAt: Date.now() - 1 })
    const oldRefresh = deferredTokenFetch()
    const oldResult = getAntigravityAccessToken(oldRefresh.fetchImpl)
    await oldRefresh.started

    stored = tokens({
      accessToken: 'account-b-old',
      refreshToken: 'refresh-2',
      expiresAt: Date.now() - 1,
      projectId: 'proj-2',
    })
    const newRefresh = stubFetch([
      { json: { access_token: 'account-b-new', expires_in: 3600 } },
    ])
    const newResult = getAntigravityAccessToken(newRefresh.fetchImpl)
    await Promise.resolve()
    await Promise.resolve()
    const newAccountCallCount = newRefresh.calls.length

    oldRefresh.respond({ access_token: 'account-a-new', expires_in: 3600 })
    expect(await Promise.all([oldResult, newResult])).toEqual([
      null,
      'account-b-new',
    ])
    expect(newAccountCallCount).toBe(1)
    expect(saved.map(token => token.accessToken)).toEqual(['account-b-new'])
    expect(stored?.refreshToken).toBe('refresh-2')
  })

  test('logout invalidates an in-flight refresh before removing credentials', async () => {
    stored = tokens({ expiresAt: Date.now() - 1 })
    const pendingRefresh = deferredTokenFetch()
    const accessResult = getAntigravityAccessToken(pendingRefresh.fetchImpl)
    await pendingRefresh.started

    await removeAntigravityAuth()
    pendingRefresh.respond({
      access_token: 'must-not-persist',
      expires_in: 3600,
    })

    expect(await accessResult).toBeNull()
    expect(saved).toHaveLength(0)
    expect(stored).toBeNull()
  })

  test('a new code exchange invalidates refresh work from the previous login', async () => {
    stored = tokens({ expiresAt: Date.now() - 1 })
    const pendingRefresh = deferredTokenFetch()
    const accessResult = getAntigravityAccessToken(pendingRefresh.fetchImpl)
    await pendingRefresh.started

    const exchangeFetch = stubFetch([
      {
        json: {
          access_token: 'account-b-access',
          refresh_token: 'refresh-2',
          expires_in: 3600,
        },
      },
    ])
    const exchanged = await exchangeAntigravityCode({
      code: 'account-b-code',
      redirectUri: 'http://localhost/cb',
      fetchImpl: exchangeFetch.fetchImpl,
    })
    pendingRefresh.respond({
      access_token: 'must-not-persist',
      expires_in: 3600,
    })

    expect(exchanged.refreshToken).toBe('refresh-2')
    expect(await accessResult).toBeNull()
    expect(saved).toHaveLength(0)
  })
})

describe('getValidAntigravityAuth', () => {
  test('tells the user how to log in when there are no credentials', async () => {
    stored = null
    const { fetchImpl } = stubFetch([])
    await expect(getValidAntigravityAuth(fetchImpl)).rejects.toThrow(
      /Run \/login and select Antigravity/,
    )
  })

  test('returns the token and project for a healthy session', async () => {
    stored = tokens()
    const { fetchImpl } = stubFetch([])
    expect(await getValidAntigravityAuth(fetchImpl)).toEqual({
      accessToken: 'access-old',
      projectId: 'proj-1',
    })
  })

  test('recovers a missing project id and writes it back', async () => {
    // Credential files written before project persistence, or minted while
    // onboarding was still running, carry no project.
    stored = tokens({ projectId: undefined })
    const { fetchImpl } = stubFetch([
      { json: { cloudaicompanionProject: 'proj-recovered' } },
    ])
    const auth = await getValidAntigravityAuth(fetchImpl)
    expect(auth.projectId).toBe('proj-recovered')
    expect(saved[0]!.projectId).toBe('proj-recovered')
  })
})
