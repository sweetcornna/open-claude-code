import { digestToken, generateOpaqueToken } from '../auth/credentials'
import { config } from '../config'
import {
  storeConsumePairToken,
  storeConsumeRateLimit,
  storeCreateAccount,
  storeCreateAuthToken,
  storeGetAccountById,
  storeGetAccountByUsername,
  storeGetActiveAuthToken,
  storeGetAuthTokenRow,
  storeRevokeAccountTokens,
  storeRevokeAuthToken,
  storeReplacePairToken,
  storeRotateRefreshToken,
  type AccountRecord,
  type AuthTokenKind,
  type AuthTokenRecord,
} from '../store'

export const ACCESS_TOKEN_TTL_SECONDS = 900
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
export const BROWSER_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
export const PAIR_TOKEN_TTL_SECONDS = 120

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,31}$/
const DUMMY_PASSWORD = 'not-a-real-password-for-timing'
let dummyHashPromise: Promise<string> | undefined

export class AccountError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 409 | 429,
    readonly type: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
  }
}

interface UserResponse {
  id: string
  username: string
}

interface TokenPairResponse {
  user: UserResponse
  access_token: string
  expires_in: number
  refresh_token: string
  refresh_expires_in: number
}

function toUser(account: AccountRecord): UserResponse {
  return { id: account.id, username: account.username }
}

export function normalizeUsername(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return USERNAME_PATTERN.test(normalized) ? normalized : undefined
}

export function validatePassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, {
    algorithm: 'argon2id',
    memoryCost: 65536,
    timeCost: 3,
  })
}

function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(DUMMY_PASSWORD)
  return dummyHashPromise
}

function authTokenRecord(
  rawToken: string,
  accountId: string,
  kind: AuthTokenKind,
  ttlSeconds: number,
  sessionId: string | null = null,
  now = Date.now(),
): AuthTokenRecord {
  return {
    digest: digestToken(rawToken),
    accountId,
    kind,
    sessionId,
    expiresAt: new Date(now + ttlSeconds * 1000),
    createdAt: new Date(now),
    revokedAt: null,
    replacedByDigest: null,
  }
}

function issueTokenPair(account: AccountRecord): TokenPairResponse {
  const accessToken = generateOpaqueToken('access')
  const refreshToken = generateOpaqueToken('refresh')
  const now = Date.now()
  storeCreateAuthToken(
    authTokenRecord(
      accessToken,
      account.id,
      'access',
      ACCESS_TOKEN_TTL_SECONDS,
      null,
      now,
    ),
  )
  storeCreateAuthToken(
    authTokenRecord(
      refreshToken,
      account.id,
      'refresh',
      REFRESH_TOKEN_TTL_SECONDS,
      null,
      now,
    ),
  )
  return {
    user: toUser(account),
    access_token: accessToken,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS,
  }
}

export function enforceAuthRateLimit(
  action: 'register' | 'login',
  ip: string,
  username: string,
) {
  const limit =
    action === 'register' ? config.registrationRateLimit : config.loginRateLimit
  const windowSeconds =
    action === 'register'
      ? config.registrationRateWindowSeconds
      : config.loginRateWindowSeconds
  const ipResult = storeConsumeRateLimit(
    `${action}:ip:${ip}`,
    limit,
    windowSeconds,
  )
  const usernameResult = storeConsumeRateLimit(
    `${action}:username:${username}`,
    limit,
    windowSeconds,
  )
  if (!ipResult.allowed || !usernameResult.allowed) {
    throw new AccountError(
      'Too many attempts',
      429,
      'rate_limited',
      Math.max(ipResult.retryAfterSeconds, usernameResult.retryAfterSeconds),
    )
  }
}

export async function createAccount(
  usernameValue: unknown,
  passwordValue: unknown,
): Promise<AccountRecord> {
  const username = normalizeUsername(usernameValue)
  if (!username) {
    throw new AccountError(
      'Username must match [a-z0-9][a-z0-9_.-]{2,31}',
      400,
      'invalid_request',
    )
  }
  if (!validatePassword(passwordValue)) {
    throw new AccountError(
      'Password must be 12-128 characters',
      400,
      'invalid_request',
    )
  }
  if (storeGetAccountByUsername(username)) {
    throw new AccountError('Username is unavailable', 409, 'conflict')
  }
  const passwordHash = await hashPassword(passwordValue)
  try {
    return storeCreateAccount(username, passwordHash)
  } catch (error) {
    if (storeGetAccountByUsername(username)) {
      throw new AccountError('Username is unavailable', 409, 'conflict')
    }
    throw error
  }
}

export async function authenticateAccount(
  usernameValue: unknown,
  passwordValue: unknown,
): Promise<AccountRecord> {
  const username = normalizeUsername(usernameValue)
  const password = typeof passwordValue === 'string' ? passwordValue : ''
  const account = username ? storeGetAccountByUsername(username) : undefined
  const hash = account?.passwordHash ?? (await getDummyHash())
  let verified = false
  try {
    verified = await Bun.password.verify(password, hash)
  } catch {
    verified = false
  }
  if (!account || account.disabledAt || !verified) {
    throw new AccountError(
      'Invalid username or password',
      401,
      'invalid_credentials',
    )
  }
  return account
}

export async function registerWithTokens(
  username: unknown,
  password: unknown,
): Promise<TokenPairResponse> {
  return issueTokenPair(await createAccount(username, password))
}

export async function loginWithTokens(
  username: unknown,
  password: unknown,
): Promise<TokenPairResponse> {
  return issueTokenPair(await authenticateAccount(username, password))
}

export function refreshTokens(refreshToken: unknown): TokenPairResponse {
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new AccountError('Invalid refresh token', 401, 'unauthorized')
  }
  const oldDigest = digestToken(refreshToken)
  const usedRow = storeGetAuthTokenRow(oldDigest, 'refresh')
  if (usedRow?.revokedAt) {
    // A used refresh token presented again: the family may be compromised,
    // so revoke every active credential for the account.
    storeRevokeAccountTokens(usedRow.accountId)
    throw new AccountError(
      'Refresh token reuse detected; please log in again',
      401,
      'token_reused',
    )
  }
  const current = storeGetActiveAuthToken(oldDigest, 'refresh')
  if (!current) {
    throw new AccountError('Invalid refresh token', 401, 'unauthorized')
  }
  const accessRaw = generateOpaqueToken('access')
  const refreshRaw = generateOpaqueToken('refresh')
  const now = Date.now()
  const result = storeRotateRefreshToken(
    oldDigest,
    authTokenRecord(
      accessRaw,
      current.accountId,
      'access',
      ACCESS_TOKEN_TTL_SECONDS,
      null,
      now,
    ),
    authTokenRecord(
      refreshRaw,
      current.accountId,
      'refresh',
      REFRESH_TOKEN_TTL_SECONDS,
      null,
      now,
    ),
    now,
  )
  if (!result) {
    throw new AccountError('Invalid refresh token', 401, 'unauthorized')
  }
  if (result.replayed) {
    storeRevokeAccountTokens(result.accountId)
    throw new AccountError(
      'Refresh token reuse detected; please log in again',
      401,
      'token_reused',
    )
  }
  return {
    user: toUser(result.account),
    access_token: accessRaw,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshRaw,
    refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS,
  }
}

export function resolveAccountToken(
  rawToken: string | undefined,
  kind: 'access' | 'browser',
): AccountRecord | undefined {
  if (!rawToken) return undefined
  const token = storeGetActiveAuthToken(digestToken(rawToken), kind)
  return token ? storeGetAccountById(token.accountId) : undefined
}

export function logoutAccount(
  accountId: string,
  accessToken: string,
  refreshToken?: unknown,
) {
  storeRevokeAuthToken(digestToken(accessToken), accountId)
  if (typeof refreshToken === 'string' && refreshToken.length > 0) {
    storeRevokeAuthToken(digestToken(refreshToken), accountId)
  } else {
    storeRevokeAccountTokens(accountId, ['access', 'refresh'])
  }
}

export function issueBrowserToken(accountId: string): string {
  const raw = generateOpaqueToken('browser')
  storeCreateAuthToken(
    authTokenRecord(raw, accountId, 'browser', BROWSER_TOKEN_TTL_SECONDS),
  )
  return raw
}

export function revokeBrowserToken(accountId: string, rawToken: string) {
  storeRevokeAuthToken(digestToken(rawToken), accountId)
}

export function issuePairToken(accountId: string, sessionId: string): string {
  const raw = generateOpaqueToken('pair')
  storeReplacePairToken(
    authTokenRecord(raw, accountId, 'pair', PAIR_TOKEN_TTL_SECONDS, sessionId),
  )
  return raw
}

export function consumePairToken(
  rawToken: unknown,
): { account: AccountRecord; sessionId: string } | undefined {
  if (typeof rawToken !== 'string' || rawToken.length === 0) return undefined
  const consumed = storeConsumePairToken(digestToken(rawToken))
  if (!consumed) return undefined
  const account = storeGetAccountById(consumed.accountId)
  return account ? { account, sessionId: consumed.sessionId } : undefined
}

export function userResponse(account: AccountRecord): UserResponse {
  return toUser(account)
}
