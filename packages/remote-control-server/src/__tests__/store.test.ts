import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  closeDatabase,
  getDatabase,
  setDatabasePathForTests,
} from '../db/database'
import {
  storeAppendEvent,
  storeConsumeRateLimit,
  storeCreateAccount,
  storeCreateEnvironment,
  storeCreateSession,
  storeCreateWorkItem,
  storeGetAccountByUsername,
  storeGetEnvironment,
  storeGetSession,
  storeGetWorkItem,
  storeListEvents,
  storePruneExpiredSecurityState,
  storeReset,
} from '../store'

beforeAll(() => setDatabasePathForTests(':memory:'))
beforeEach(() => storeReset())
afterAll(() => closeDatabase())

describe('SQLite store', () => {
  test('runs numbered migrations and enables safety pragmas', () => {
    const versions = getDatabase()
      .query('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>
    expect(versions.map(row => row.version)).toEqual([1, 2])
    expect(
      (
        getDatabase().query('PRAGMA foreign_keys').get() as {
          foreign_keys: number
        }
      ).foreign_keys,
    ).toBe(1)
    expect(
      (
        getDatabase().query('PRAGMA busy_timeout').get() as {
          timeout: number
        }
      ).timeout,
    ).toBe(5000)
  })

  test('persists account-owned resources across restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rcs-db-'))
    const path = join(directory, 'rcs.sqlite')
    try {
      setDatabasePathForTests(path)
      const account = storeCreateAccount('alice', '$argon2id$stored-hash')
      const environment = storeCreateEnvironment({
        accountId: account.id,
        secret: 'rce_plain-environment-token',
        machineName: 'workstation',
      })
      const session = storeCreateSession({
        accountId: account.id,
        environmentId: environment.id,
        title: 'Persistent session',
      })
      const work = storeCreateWorkItem({
        accountId: account.id,
        environmentId: environment.id,
        sessionId: session.id,
      })
      storeAppendEvent({
        id: 'event-1',
        sessionId: session.id,
        type: 'user',
        payload: { content: 'persisted' },
        direction: 'outbound',
      })

      closeDatabase()

      expect(storeGetAccountByUsername('alice')?.id).toBe(account.id)
      expect(storeGetEnvironment(environment.id, account.id)?.machineName).toBe(
        'workstation',
      )
      expect(storeGetSession(session.id, account.id)?.title).toBe(
        'Persistent session',
      )
      expect(storeGetWorkItem(work.id, account.id)?.state).toBe('pending')
      expect(storeListEvents(session.id, 0, account.id)).toHaveLength(1)
    } finally {
      closeDatabase()
      rmSync(directory, { recursive: true, force: true })
      setDatabasePathForTests(':memory:')
    }
  })

  test('never stores plaintext credentials or password input', () => {
    const password = 'NeverStoreThisPassword123!'
    const environmentToken = 'rce_never-store-this-token'
    const account = storeCreateAccount('alice', '$argon2id$opaque-hash')
    storeCreateEnvironment({
      accountId: account.id,
      secret: environmentToken,
    })

    const accountRow = getDatabase()
      .query('SELECT password_hash FROM accounts WHERE id = ?')
      .get(account.id) as { password_hash: string }
    const environmentRow = getDatabase()
      .query('SELECT credential_digest FROM environments WHERE account_id = ?')
      .get(account.id) as { credential_digest: string }
    const databaseText = `${accountRow.password_hash}:${environmentRow.credential_digest}`

    expect(databaseText).not.toContain(password)
    expect(databaseText).not.toContain(environmentToken)
    expect(environmentRow.credential_digest).toMatch(/^[0-9a-f]{64}$/)
  })

  test('retains only the newest 5000 events with monotonic sequence numbers', () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    const session = storeCreateSession({ accountId: account.id })
    for (let index = 1; index <= 5001; index++) {
      storeAppendEvent({
        id: `event-${index}`,
        sessionId: session.id,
        type: 'message',
        payload: { index },
        direction: 'inbound',
      })
    }
    const events = storeListEvents(session.id, 0, account.id)
    expect(events).toHaveLength(5000)
    expect(events[0]?.seqNum).toBe(2)
    expect(events.at(-1)?.seqNum).toBe(5001)
  })

  test('prunes expired tokens and stale rate-limit buckets', () => {
    const account = storeCreateAccount('alice', '$argon2id$hash')
    const db = getDatabase()
    db.query(
      `INSERT INTO auth_tokens
       (digest, account_id, kind, expires_at, created_at)
       VALUES (?, ?, 'access', ?, ?)`,
    ).run('a'.repeat(64), account.id, 9_000, 1_000)
    db.query(
      `INSERT INTO auth_tokens
       (digest, account_id, kind, expires_at, created_at)
       VALUES (?, ?, 'access', ?, ?)`,
    ).run('b'.repeat(64), account.id, 11_000, 1_000)
    storeConsumeRateLimit('stale', 2, 60, 1_000)
    storeConsumeRateLimit('current', 2, 60, 9_500)

    expect(storePruneExpiredSecurityState(2_000, 10_000)).toEqual({
      tokens: 1,
      rateLimits: 1,
    })
    expect(
      (
        db.query('SELECT COUNT(*) AS count FROM auth_tokens').get() as {
          count: number
        }
      ).count,
    ).toBe(1)
  })

  test('persists fixed-window rate-limit buckets', () => {
    expect(storeConsumeRateLimit('login:ip:alice', 2, 60, 1000).allowed).toBe(
      true,
    )
    expect(storeConsumeRateLimit('login:ip:alice', 2, 60, 1001).allowed).toBe(
      true,
    )
    const limited = storeConsumeRateLimit('login:ip:alice', 2, 60, 1002)
    expect(limited.allowed).toBe(false)
    expect(limited.retryAfterSeconds).toBe(60)
  })
})
