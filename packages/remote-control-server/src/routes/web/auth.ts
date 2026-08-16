import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import {
  BROWSER_SESSION_COOKIE,
  browserAuth,
  getClientIp,
  requireSameOriginJson,
} from '../../auth/middleware'
import { config } from '../../config'
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AccountError,
  BROWSER_TOKEN_TTL_SECONDS,
  PAIR_TOKEN_TTL_SECONDS,
  authenticateAccount,
  consumePairToken,
  createAccount,
  enforceAuthRateLimit,
  issueBrowserToken,
  normalizeUsername,
  revokeBrowserToken,
  userResponse,
} from '../../services/account'
import { storeGetAccountById } from '../../store'

const app = new Hono()

app.get('/auth/capabilities', c =>
  c.json({
    auth_mode: 'accounts',
    registration_enabled: config.allowRegistration,
    access_token_ttl_seconds: ACCESS_TOKEN_TTL_SECONDS,
    pairing_ttl_seconds: PAIR_TOKEN_TTL_SECONDS,
  }),
)

function setBrowserCookie(c: Parameters<typeof getClientIp>[0], token: string) {
  setCookie(c, BROWSER_SESSION_COOKIE, token, {
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: BROWSER_TOKEN_TTL_SECONDS,
  })
}

async function jsonBody(c: Parameters<typeof getClientIp>[0]) {
  try {
    const body: unknown = await c.req.json()
    return body && typeof body === 'object'
      ? (body as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function errorResponse(c: Parameters<typeof getClientIp>[0], error: unknown) {
  if (error instanceof AccountError) {
    if (error.retryAfterSeconds) {
      c.header('Retry-After', String(error.retryAfterSeconds))
    }
    return c.json(
      { error: { type: error.type, message: error.message } },
      error.status,
    )
  }
  throw error
}

app.post('/auth/register', requireSameOriginJson, async c => {
  if (!config.allowRegistration) {
    return c.json(
      {
        error: {
          type: 'registration_disabled',
          message: 'Registration is disabled',
        },
      },
      403,
    )
  }
  const body = await jsonBody(c)
  const rateUsername = normalizeUsername(body?.username) ?? 'invalid'
  try {
    enforceAuthRateLimit('register', getClientIp(c), rateUsername)
    const account = await createAccount(body?.username, body?.password)
    setBrowserCookie(c, issueBrowserToken(account.id))
    return c.json({ user: userResponse(account) }, 201)
  } catch (error) {
    return errorResponse(c, error)
  }
})

app.post('/auth/login', requireSameOriginJson, async c => {
  const body = await jsonBody(c)
  const rateUsername = normalizeUsername(body?.username) ?? 'invalid'
  try {
    enforceAuthRateLimit('login', getClientIp(c), rateUsername)
    const account = await authenticateAccount(body?.username, body?.password)
    setBrowserCookie(c, issueBrowserToken(account.id))
    return c.json({ user: userResponse(account) }, 200)
  } catch (error) {
    return errorResponse(c, error)
  }
})

app.get('/auth/me', browserAuth, c => {
  const account = storeGetAccountById(c.get('accountId') as string)
  if (!account) {
    return c.json(
      { error: { type: 'unauthorized', message: 'Invalid session' } },
      401,
    )
  }
  return c.json({ user: userResponse(account) }, 200)
})

app.post('/auth/logout', requireSameOriginJson, browserAuth, async c => {
  const rawToken = getCookie(c, BROWSER_SESSION_COOKIE)
  if (rawToken) {
    revokeBrowserToken(c.get('accountId') as string, rawToken)
  }
  deleteCookie(c, BROWSER_SESSION_COOKIE, {
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
  })
  return c.json({ status: 'ok' }, 200)
})

app.post('/auth/pair', requireSameOriginJson, async c => {
  const body = await jsonBody(c)
  const pairing = consumePairToken(body?.code)
  if (!pairing) {
    return c.json(
      { error: { type: 'invalid_pairing', message: 'Invalid pairing code' } },
      401,
    )
  }
  setBrowserCookie(c, issueBrowserToken(pairing.account.id))
  return c.json(
    {
      user: userResponse(pairing.account),
      session_id: pairing.sessionId,
    },
    200,
  )
})

export default app
