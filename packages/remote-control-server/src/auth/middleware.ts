import type { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import { config, getBaseUrl } from '../config'
import {
  storeEnsureLegacyAccount,
  storeGetAccountById,
  storeGetAuthTokenStatus,
  storeGetEnvironmentByCredential,
  storeGetSession,
} from '../store'
import { resolveAccountToken } from '../services/account'
import { digestToken } from './credentials'
import { validateApiKey } from './api-key'
import {
  isExpiredWorkerJwt,
  verifyWorkerJwt,
  type WorkerJwtPayload,
} from './jwt'

export const BROWSER_SESSION_COOKIE = '__Host-rcs_session'
const WS_AUTH_PROTOCOL_PREFIX = 'rcs.auth.'

function unauthorized(c: Context, message = 'Invalid or missing auth token') {
  return c.json({ error: { type: 'unauthorized', message } }, 401)
}

function setAccountContext(
  c: Context,
  account: { id: string; username: string },
  rawToken: string,
  legacy = false,
  credential?: ConnectionCredential,
) {
  c.set('accountId', account.id)
  c.set('username', account.username)
  c.set('rawAuthToken', rawToken)
  c.set('legacyAuth', legacy)
  if (credential) c.set('connectionCredential', credential)
}

/**
 * The credential this request authenticated with, for handlers that open a
 * long-lived stream and must keep re-checking it.
 */
export function getConnectionCredential(
  c: Context,
): ConnectionCredential | undefined {
  return c.get('connectionCredential') as ConnectionCredential | undefined
}

export function encodeWebSocketAuthProtocol(token: string): string {
  return `${WS_AUTH_PROTOCOL_PREFIX}${Buffer.from(token, 'utf8').toString('base64url')}`
}

function decodeWebSocketAuthProtocol(
  protocolHeader: string | undefined,
): string | undefined {
  if (!protocolHeader) return undefined
  for (const protocol of protocolHeader.split(',')) {
    const trimmed = protocol.trim()
    if (!trimmed.startsWith(WS_AUTH_PROTOCOL_PREFIX)) continue
    const encoded = trimmed.slice(WS_AUTH_PROTOCOL_PREFIX.length)
    if (!encoded) return undefined
    try {
      const token = Buffer.from(encoded, 'base64url').toString('utf8')
      return token || undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

export function extractBearerToken(c: Context): string | undefined {
  const authHeader = c.req.header('Authorization')
  return authHeader?.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : undefined
}

export function extractWebSocketAuthToken(c: Context): string | undefined {
  return (
    extractBearerToken(c) ??
    decodeWebSocketAuthProtocol(c.req.header('Sec-WebSocket-Protocol'))
  )
}

/**
 * The credential a long-lived transport authenticated with, retained on the
 * connection so every frame can re-run the real check. A WebSocket upgrade
 * authenticates exactly once; without this the socket outlives logout, refresh
 * replay, epoch rotation and token expiry.
 */
export type ConnectionCredential =
  | { type: 'account'; token: string; kind: 'access' | 'browser' }
  | { type: 'legacy'; token: string }
  | { type: 'worker'; token: string; sessionId: string }
  | { type: 'environment'; token: string; environmentId: string }

interface ResolvedAccount {
  id: string
  username: string
  legacy: boolean
  credential: ConnectionCredential
}

export function resolveBearerAccount(
  rawToken: string | undefined,
): ResolvedAccount | undefined {
  const account = resolveAccountToken(rawToken, 'access')
  if (account && rawToken) {
    return {
      id: account.id,
      username: account.username,
      legacy: false,
      credential: { type: 'account', token: rawToken, kind: 'access' },
    }
  }
  if (rawToken && config.legacyApiKeyAuth && validateApiKey(rawToken)) {
    const legacy = storeEnsureLegacyAccount()
    return {
      id: legacy.id,
      username: legacy.username,
      legacy: true,
      credential: { type: 'legacy', token: rawToken },
    }
  }
  return undefined
}

function resolveBrowserAccount(c: Context): ResolvedAccount | undefined {
  const token = getCookie(c, BROWSER_SESSION_COOKIE)
  if (!token) return undefined
  const account = resolveAccountToken(token, 'browser')
  return account
    ? {
        id: account.id,
        username: account.username,
        legacy: false,
        credential: { type: 'account', token, kind: 'browser' },
      }
    : undefined
}

/**
 * WebSocket account resolution. Browser relays authenticate with the
 * HttpOnly session cookie sent on the same-origin upgrade; CLI clients
 * (acp-link) authenticate with the Bearer/subprotocol token.
 *
 * `source` matters: a cookie-authenticated upgrade is reachable cross-origin
 * (WebSocket ignores CORS and the browser attaches the cookie anyway), so
 * callers must additionally require `isAllowedWebSocketOrigin`.
 */
export function resolveWebSocketAccount(
  c: Context,
): (ResolvedAccount & { source: 'cookie' | 'bearer' }) | undefined {
  const browser = resolveBrowserAccount(c)
  if (browser) return { ...browser, source: 'cookie' }
  const bearer = resolveBearerAccount(extractWebSocketAuthToken(c))
  return bearer ? { ...bearer, source: 'bearer' } : undefined
}

/**
 * WebSocket upgrades are exempt from the same-origin policy: the browser sends
 * the request (and the `__Host-rcs_session` cookie) to any origin a page asks
 * for, and there is no CORS preflight to block it. Cookie-authenticated
 * upgrades therefore need the Origin check that `requireSameOriginJson` gives
 * the REST surface. Bearer/JWT upgrades come from CLI clients that send no
 * Origin header and are unaffected.
 */
export function isAllowedWebSocketOrigin(c: Context): boolean {
  const origin = c.req.header('Origin')
  if (!origin) return false
  if (origin === new URL(c.req.url).origin) return true
  try {
    if (origin === new URL(getBaseUrl()).origin) return true
  } catch {
    // Unparseable RCS_BASE_URL: fall through to the explicit allowlist.
  }
  return config.webCorsOrigins.includes(origin)
}

export async function accountAuth(c: Context, next: Next) {
  const token = extractBearerToken(c)
  const account = resolveBearerAccount(token)
  if (!token || !account) return unauthorized(c)
  setAccountContext(c, account, token, account.legacy, account.credential)
  await next()
}

export async function browserAuth(c: Context, next: Next) {
  const token = getCookie(c, BROWSER_SESSION_COOKIE)
  const account = resolveAccountToken(token, 'browser')
  if (!token || !account) return unauthorized(c)
  setAccountContext(c, account, token, false, {
    type: 'account',
    token,
    kind: 'browser',
  })
  await next()
}

export async function bridgeCredentialAuth(c: Context, next: Next) {
  const token = extractBearerToken(c)
  if (!token) return unauthorized(c)

  const account = resolveBearerAccount(token)
  if (account) {
    setAccountContext(c, account, token, account.legacy, account.credential)
    await next()
    return
  }

  const environmentId = c.req.param('id')
  if (environmentId) {
    const environment = storeGetEnvironmentByCredential(token, environmentId)
    if (environment) {
      setAccountContext(
        c,
        { id: environment.accountId, username: environment.username ?? '' },
        token,
        false,
        { type: 'environment', token, environmentId },
      )
      c.set('environmentCredential', true)
      await next()
      return
    }
  }

  // authenticateWorkerToken, not verifyWorkerJwt: the bare verify skips the
  // worker_epoch comparison, so a JWT minted before the session's last bridge
  // registration kept working on the /work/{ack,heartbeat} routes.
  const payload = authenticateWorkerToken(token)
  if (payload) {
    const workerAccount = resolveWorkerAccount(payload)
    if (workerAccount) {
      setAccountContext(c, workerAccount, token, false, {
        type: 'worker',
        token,
        sessionId: payload.session_id,
      })
      c.set('jwtPayload', payload)
      await next()
      return
    }
  }

  return unauthorized(c)
}

function resolveWorkerAccount(
  payload: WorkerJwtPayload,
): { id: string; username: string } | undefined {
  const session = storeGetSession(payload.session_id, payload.account_id)
  return session
    ? { id: session.accountId, username: session.username ?? '' }
    : undefined
}

export type RuntimeAccessReason =
  | 'account_revoked'
  | 'session_revoked'
  | 'token_revoked'
  | 'token_expired'

export type RuntimeAccessVerdict =
  | { ok: true }
  | { ok: false; reason: RuntimeAccessReason }

/**
 * Account- and session-level revalidation. This is only half the check: it
 * says nothing about the credential the connection presented, so on its own it
 * lets a socket outlive the very token that opened it. Prefer
 * `validateConnectionAccess`, which layers the credential check on top.
 */
function validateRuntimeAccess(
  accountId: string | undefined,
  sessionId?: string,
): RuntimeAccessVerdict {
  if (accountId) {
    const account = storeGetAccountById(accountId)
    if (!account || account.disabledAt) {
      return { ok: false, reason: 'account_revoked' }
    }
  }
  if (sessionId) {
    const session = storeGetSession(sessionId, accountId)
    if (!session) return { ok: false, reason: 'session_revoked' }
    if (session.status === 'archived') {
      return { ok: false, reason: 'session_revoked' }
    }
  }
  return { ok: true }
}

/**
 * Re-run the credential check that authorized the upgrade. Cheap on purpose:
 * three prepared SQLite reads at worst (token row, account row, session row),
 * all in-process, so running it per frame and per keepalive tick costs
 * microseconds and never leaves the box.
 */
function validateConnectionCredential(
  credential: ConnectionCredential,
  accountId: string,
): RuntimeAccessVerdict {
  switch (credential.type) {
    case 'account': {
      const account = resolveAccountToken(credential.token, credential.kind)
      if (account?.id === accountId) return { ok: true }
      const status = storeGetAuthTokenStatus(
        digestToken(credential.token),
        credential.kind,
      )
      return {
        ok: false,
        reason: status === 'expired' ? 'token_expired' : 'token_revoked',
      }
    }
    case 'legacy': {
      return config.legacyApiKeyAuth && validateApiKey(credential.token)
        ? { ok: true }
        : { ok: false, reason: 'token_revoked' }
    }
    case 'worker': {
      const payload = authenticateWorkerToken(
        credential.token,
        credential.sessionId,
      )
      if (payload && payload.account_id === accountId) return { ok: true }
      return {
        ok: false,
        reason: isExpiredWorkerJwt(credential.token)
          ? 'token_expired'
          : 'token_revoked',
      }
    }
    case 'environment': {
      const environment = storeGetEnvironmentByCredential(
        credential.token,
        credential.environmentId,
      )
      return environment?.accountId === accountId
        ? { ok: true }
        : { ok: false, reason: 'token_revoked' }
    }
  }
}

/**
 * Full runtime revalidation for a long-lived transport: the credential itself,
 * then the account, then the session. Call it on every inbound frame and on
 * every keepalive tick.
 */
export function validateConnectionAccess(
  credential: ConnectionCredential | undefined,
  accountId: string | undefined,
  sessionId?: string,
): RuntimeAccessVerdict {
  const base = validateRuntimeAccess(accountId, sessionId)
  if (!base.ok) return base
  if (!credential || !accountId) return base
  return validateConnectionCredential(credential, accountId)
}

export function authenticateWorkerToken(
  token: string | undefined,
  expectedSessionId?: string,
): WorkerJwtPayload | undefined {
  if (!token) return undefined
  const payload = verifyWorkerJwt(token)
  if (!payload || payload.role !== 'worker') return undefined
  if (expectedSessionId && payload.session_id !== expectedSessionId) {
    return undefined
  }
  const session = storeGetSession(payload.session_id, payload.account_id)
  if (!session) return undefined
  if (
    payload.worker_epoch !== undefined &&
    payload.worker_epoch !== session.workerEpoch
  ) {
    return undefined
  }
  return validateRuntimeAccess(session.accountId).ok ? payload : undefined
}

export async function sessionIngressAuth(c: Context, next: Next) {
  const token = extractWebSocketAuthToken(c)
  if (!token) return unauthorized(c, 'Missing auth token')
  const routeSessionId = c.req.param('id') || c.req.param('sessionId')
  const payload = authenticateWorkerToken(token, routeSessionId)
  if (!payload) return unauthorized(c, 'Invalid worker token')
  const account = resolveWorkerAccount(payload)
  if (!account) return unauthorized(c, 'Invalid worker token')
  setAccountContext(c, account, token, false, {
    type: 'worker',
    token,
    sessionId: payload.session_id,
  })
  c.set('jwtPayload', payload)
  await next()
}

export async function requireSameOriginJson(c: Context, next: Next) {
  const contentType = c.req.header('Content-Type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('application/json')) {
    return c.json(
      {
        error: {
          type: 'invalid_request',
          message: 'Content-Type must be application/json',
        },
      },
      415,
    )
  }

  const origin = c.req.header('Origin')
  const requestOrigin = new URL(c.req.url).origin
  let configuredOrigin: string | undefined
  try {
    configuredOrigin = new URL(getBaseUrl()).origin
  } catch {
    configuredOrigin = undefined
  }
  if (!origin || (origin !== requestOrigin && origin !== configuredOrigin)) {
    return c.json(
      { error: { type: 'forbidden', message: 'Same-origin request required' } },
      403,
    )
  }
  await next()
}

export function getClientIp(c: Context): string {
  if (config.trustProxy) {
    const forwarded = c.req.header('X-Forwarded-For')
    const first = forwarded?.split(',')[0]?.trim()
    if (first) return first
  }

  type RequestIpProvider = {
    requestIP?: (request: Request) => { address?: string } | null
  }
  const environment = c.env as
    | (RequestIpProvider & { server?: RequestIpProvider })
    | undefined
  const provider = environment?.server ?? environment
  const address = provider?.requestIP?.(c.req.raw)?.address
  return address || 'direct'
}
