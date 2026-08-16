import { Hono } from 'hono'
import { config } from '../../config'
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AccountError,
  PAIR_TOKEN_TTL_SECONDS,
  enforceAuthRateLimit,
  loginWithTokens,
  logoutAccount,
  normalizeUsername,
  refreshTokens,
  registerWithTokens,
  userResponse,
} from '../../services/account'
import { storeGetAccountById } from '../../store'
import {
  accountAuth,
  extractBearerToken,
  getClientIp,
} from '../../auth/middleware'

const app = new Hono()

// Credential responses must never be cached by browsers, proxies, or gateways.
app.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
})

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

app.get('/capabilities', c =>
  c.json({
    auth_mode: 'accounts',
    registration_enabled: config.allowRegistration,
    access_token_ttl_seconds: ACCESS_TOKEN_TTL_SECONDS,
    pairing_ttl_seconds: PAIR_TOKEN_TTL_SECONDS,
  }),
)

app.post('/register', async c => {
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
    return c.json(await registerWithTokens(body?.username, body?.password), 201)
  } catch (error) {
    return errorResponse(c, error)
  }
})

app.post('/login', async c => {
  const body = await jsonBody(c)
  const rateUsername = normalizeUsername(body?.username) ?? 'invalid'
  try {
    enforceAuthRateLimit('login', getClientIp(c), rateUsername)
    return c.json(await loginWithTokens(body?.username, body?.password), 200)
  } catch (error) {
    return errorResponse(c, error)
  }
})

app.post('/refresh', async c => {
  const body = await jsonBody(c)
  try {
    return c.json(refreshTokens(body?.refresh_token), 200)
  } catch (error) {
    return errorResponse(c, error)
  }
})

app.post('/logout', accountAuth, async c => {
  const accountId = c.get('accountId') as string
  const accessToken = extractBearerToken(c) as string
  const body = await jsonBody(c)
  logoutAccount(accountId, accessToken, body?.refresh_token)
  return c.json({ status: 'ok' }, 200)
})

app.get('/me', accountAuth, c => {
  const account = storeGetAccountById(c.get('accountId') as string)
  if (!account) {
    return c.json(
      { error: { type: 'unauthorized', message: 'Invalid auth token' } },
      401,
    )
  }
  return c.json({ user: userResponse(account) }, 200)
})

export default app
