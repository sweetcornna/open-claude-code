import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { setupRcsConfigMock } from '../../../../tests/mocks/rcsConfig.js'

const configMock = setupRcsConfigMock()
beforeAll(() =>
  configMock.set({
    allowRegistration: true,
    legacyApiKeyAuth: false,
    tokenPepper: 'test-token-pepper-at-least-32-characters',
    workerJwtSecret: 'test-worker-secret-at-least-32-characters',
  }),
)
afterAll(() => configMock.reset())

import { digestToken } from '../auth/credentials'
import { config } from '../config'
import { generateWorkerJwt, verifyWorkerJwt } from '../auth/jwt'
import { getDatabase, setDatabasePathForTests } from '../db/database'
import {
  AccountError,
  authenticateAccount,
  enforceAuthRateLimit,
  hashPassword,
  loginWithTokens,
  logoutAccount,
  normalizeUsername,
  refreshTokens,
  registerWithTokens,
} from '../services/account'
import {
  storeCreateAccount,
  storeCreateSession,
  storeGetActiveAuthToken,
  storeReset,
} from '../store'

beforeAll(() => setDatabasePathForTests(':memory:'))
beforeEach(() => storeReset())

describe('account credentials', () => {
  test('normalizes and validates usernames', () => {
    expect(normalizeUsername('  Alice.Example  ')).toBe('alice.example')
    expect(normalizeUsername('ab')).toBeUndefined()
    expect(normalizeUsername('-invalid')).toBeUndefined()
    expect(normalizeUsername('space user')).toBeUndefined()
  })

  test('hashes passwords with Argon2id and never stores plaintext', async () => {
    const password = 'correct horse battery staple'
    const hash = await hashPassword(password)
    expect(hash).toStartWith('$argon2id$')
    expect(hash).not.toContain(password)
    expect(await Bun.password.verify(password, hash)).toBe(true)
  })

  test('registers and logs in with exact opaque token response shape', async () => {
    const registered = await registerWithTokens(
      'Alice',
      'correct horse battery staple',
    )
    expect(registered.user.username).toBe('alice')
    expect(registered.expires_in).toBe(900)
    expect(registered.refresh_expires_in).toBe(30 * 24 * 60 * 60)
    expect(registered.access_token).toMatch(/^rca_/)
    expect(registered.refresh_token).toMatch(/^rcr_/)
    const passwordRow = getDatabase()
      .query('SELECT password_hash FROM accounts WHERE id = ?')
      .get(registered.user.id) as { password_hash: string }
    expect(passwordRow.password_hash).toStartWith('$argon2id$')
    expect(passwordRow.password_hash).not.toContain(
      'correct horse battery staple',
    )

    const loggedIn = await loginWithTokens(
      'alice',
      'correct horse battery staple',
    )
    expect(loggedIn.user).toEqual(registered.user)
    expect(loggedIn.access_token).not.toBe(registered.access_token)
  })

  test('uses generic login failures for unknown users and bad passwords', async () => {
    const hash = await hashPassword('correct horse battery staple')
    storeCreateAccount('alice', hash)

    for (const attempt of [
      () => authenticateAccount('unknown', 'correct horse battery staple'),
      () => authenticateAccount('alice', 'incorrect password value'),
    ]) {
      await expect(attempt()).rejects.toMatchObject({
        message: 'Invalid username or password',
        status: 401,
        type: 'invalid_credentials',
      } as Partial<AccountError>)
    }
  })

  test('rotates refresh tokens atomically and rejects replay', async () => {
    const initial = await registerWithTokens(
      'alice',
      'correct horse battery staple',
    )
    const rotated = refreshTokens(initial.refresh_token)
    expect(rotated.refresh_token).not.toBe(initial.refresh_token)
    expect(
      storeGetActiveAuthToken(digestToken(initial.refresh_token), 'refresh'),
    ).toBeUndefined()
    // Replaying a used refresh token means the family may be compromised:
    // every active credential for the account is revoked, including the
    // already-rotated descendant.
    expect(() => refreshTokens(initial.refresh_token)).toThrow(
      'Refresh token reuse detected; please log in again',
    )
    expect(
      storeGetActiveAuthToken(digestToken(rotated.refresh_token), 'refresh'),
    ).toBeUndefined()
    expect(
      storeGetActiveAuthToken(digestToken(rotated.access_token), 'access'),
    ).toBeUndefined()
  })

  test('logout revokes the presented pair or all account API tokens', async () => {
    const tokens = await registerWithTokens(
      'alice',
      'correct horse battery staple',
    )
    logoutAccount(tokens.user.id, tokens.access_token, tokens.refresh_token)
    expect(() => refreshTokens(tokens.refresh_token)).toThrow()

    const second = await loginWithTokens(
      'alice',
      'correct horse battery staple',
    )
    logoutAccount(second.user.id, second.access_token)
    expect(() => refreshTokens(second.refresh_token)).toThrow()
  })

  test('rejects expired access and refresh tokens', async () => {
    const tokens = await registerWithTokens(
      'alice',
      'correct horse battery staple',
    )
    getDatabase()
      .query('UPDATE auth_tokens SET expires_at = 0 WHERE account_id = ?')
      .run(tokens.user.id)
    expect(
      storeGetActiveAuthToken(digestToken(tokens.access_token), 'access'),
    ).toBeUndefined()
    expect(() => refreshTokens(tokens.refresh_token)).toThrow()
  })

  test('rate limits independently by IP and normalized username', () => {
    for (let i = 0; i < config.loginRateLimit; i++) {
      enforceAuthRateLimit('login', '203.0.113.10', `user-${i}`)
    }
    expect(() =>
      enforceAuthRateLimit('login', '203.0.113.10', 'another-user'),
    ).toThrow('Too many attempts')

    storeReset()
    for (let i = 0; i < config.loginRateLimit; i++) {
      enforceAuthRateLimit('login', `203.0.113.${i + 20}`, 'alice')
    }
    expect(() =>
      enforceAuthRateLimit('login', '203.0.113.250', 'alice'),
    ).toThrow('Too many attempts')
  })

  test('stores only HMAC digests for account tokens', async () => {
    const tokens = await registerWithTokens(
      'alice',
      'correct horse battery staple',
    )
    const rows = getDatabase()
      .query('SELECT digest FROM auth_tokens WHERE account_id = ?')
      .all(tokens.user.id) as Array<{ digest: string }>
    expect(rows).toHaveLength(2)
    expect(rows.every(row => /^[0-9a-f]{64}$/.test(row.digest))).toBe(true)
    expect(JSON.stringify(rows)).not.toContain(tokens.access_token)
    expect(JSON.stringify(rows)).not.toContain(tokens.refresh_token)
  })
})

describe('worker JWT', () => {
  test('includes and verifies worker role, account, session, and expiry', () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    const session = storeCreateSession({ accountId: account.id })
    const token = generateWorkerJwt(account.id, session.id, 900)
    const payload = verifyWorkerJwt(token)
    expect(payload).toMatchObject({
      role: 'worker',
      account_id: account.id,
      session_id: session.id,
    })
    expect(payload?.jti.length).toBeGreaterThan(32)
    expect(payload?.exp).toBeGreaterThan(payload?.iat ?? 0)
  })

  test('rejects expired and tampered JWTs', () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    const session = storeCreateSession({ accountId: account.id })
    expect(
      verifyWorkerJwt(generateWorkerJwt(account.id, session.id, -1)),
    ).toBeNull()
    const token = generateWorkerJwt(account.id, session.id, 900)
    expect(verifyWorkerJwt(`${token.slice(0, -2)}xx`)).toBeNull()
  })
})
