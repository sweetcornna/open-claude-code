import { describe, expect, test } from 'bun:test'
import {
  type CredentialStore,
  migrateLegacyCredentials,
} from '../migrateCredentials.js'
import type { LegacyClaudeCredentials } from '../../utils/secureStorage/legacyClaudeKeychain.js'

// The keychain and occ's secure storage are injected rather than mocked:
// `mock.module` is process-global in Bun, so substituting either one here would
// substitute it for every test file that happens to run afterwards.

const OAUTH_BLOB = {
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-legacy',
    refreshToken: 'sk-ant-ort01-legacy',
    expiresAt: 1_800_000_000_000,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  },
}

function legacy(
  overrides: Partial<LegacyClaudeCredentials> = {},
): LegacyClaudeCredentials {
  return {
    oauth: null,
    oauthSource: null,
    apiKey: null,
    keychainLocked: false,
    ...overrides,
  }
}

/** In-memory stand-in for occ's SecureStorage. */
function makeStore(initial: Record<string, unknown> | null = null): {
  store: CredentialStore
  snapshot: () => Record<string, unknown> | null
  writes: () => number
} {
  let data = initial
  let writes = 0
  return {
    store: {
      read: () => data,
      update: next => {
        data = next
        writes++
        return { success: true }
      },
    },
    snapshot: () => data,
    writes: () => writes,
  }
}

const noopCaches = async (): Promise<void> => {}

describe('migrateLegacyCredentials', () => {
  test('copies the official OAuth blob into occ storage', async () => {
    const { store, snapshot, writes } = makeStore()
    const outcome = await migrateLegacyCredentials({
      readCredentials: () =>
        legacy({ oauth: OAUTH_BLOB, oauthSource: 'keychain' }),
      storage: store,
      clearCaches: noopCaches,
    })

    expect(outcome.migrated).toBe(true)
    expect(outcome.errors).toEqual([])
    expect(writes()).toBe(1)
    expect(snapshot()).toEqual(OAUTH_BLOB)
    expect(outcome.notes.some(n => n.includes('OAuth login copied'))).toBe(true)
    // The shared-refresh-token consequence is stated on every successful run.
    expect(outcome.notes.some(n => n.includes('refreshes first'))).toBe(true)
  })

  test('preserves unrelated entries already in occ storage', async () => {
    const { store, snapshot } = makeStore({ somethingElse: { a: 1 } })
    await migrateLegacyCredentials({
      readCredentials: () => legacy({ oauth: OAUTH_BLOB, oauthSource: 'file' }),
      storage: store,
      clearCaches: noopCaches,
    })
    expect(snapshot()).toEqual({ somethingElse: { a: 1 }, ...OAUTH_BLOB })
  })

  test('never clobbers a login occ already has', async () => {
    const own = {
      claudeAiOauth: { accessToken: 'sk-ant-oat01-occ-own', refreshToken: 'r' },
    }
    const { store, snapshot, writes } = makeStore(own)
    const outcome = await migrateLegacyCredentials({
      readCredentials: () =>
        legacy({ oauth: OAUTH_BLOB, oauthSource: 'keychain' }),
      storage: store,
      clearCaches: noopCaches,
    })

    expect(outcome.migrated).toBe(false)
    expect(writes()).toBe(0)
    expect(snapshot()).toEqual(own)
    expect(
      outcome.notes.some(n => n.includes('already has a stored login')),
    ).toBe(true)
  })

  test('reports a locked keychain instead of claiming there was no login', async () => {
    const { store, writes } = makeStore()
    const outcome = await migrateLegacyCredentials({
      readCredentials: () => legacy({ keychainLocked: true }),
      storage: store,
      clearCaches: noopCaches,
    })

    expect(outcome.migrated).toBe(false)
    expect(writes()).toBe(0)
    expect(outcome.errors).toHaveLength(1)
    expect(outcome.errors[0]).toContain('locked')
    expect(outcome.notes).toEqual([])
  })

  // A locked keychain is why the plaintext fallback exists. Bailing on the lock
  // flag alone threw away a credential we were already holding.
  test('a locked keychain does not discard what the file fallback found', async () => {
    const { store, snapshot } = makeStore()
    const outcome = await migrateLegacyCredentials({
      readCredentials: () =>
        legacy({
          oauth: OAUTH_BLOB,
          oauthSource: 'file',
          keychainLocked: true,
        }),
      storage: store,
      clearCaches: noopCaches,
    })

    expect(outcome.migrated).toBe(true)
    expect(outcome.oauthAvailable).toBe(true)
    expect(outcome.errors).toEqual([])
    expect(snapshot()).toEqual(OAUTH_BLOB)
    expect(outcome.notes.some(n => n.includes('locked'))).toBe(true)
  })

  test('a locked keychain does not discard an API key the fallback found', async () => {
    const outcome = await migrateLegacyCredentials({
      readCredentials: () =>
        legacy({ apiKey: 'sk-ant-api03-legacy', keychainLocked: true }),
      storage: makeStore().store,
      clearCaches: noopCaches,
    })
    expect(outcome.apiKey).toBe('sk-ant-api03-legacy')
    expect(outcome.errors).toEqual([])
  })

  test('says so plainly when there is nothing stored', async () => {
    const outcome = await migrateLegacyCredentials({
      readCredentials: () => legacy(),
      storage: makeStore().store,
      clearCaches: noopCaches,
    })
    expect(outcome.migrated).toBe(false)
    expect(outcome.oauthAvailable).toBe(false)
    expect(outcome.errors).toEqual([])
    expect(outcome.notes[0]).toContain('No stored Claude Code login')
  })

  // The API key lands in ~/.occ.json, where the caller's merge applies the same
  // no-clobber rule. Reporting it as migrated from here claimed a copy that
  // might never happen — and the `.migrated` marker built on that claim would
  // short-circuit a later top-up.
  test('hands the legacy API key back without claiming it was written', async () => {
    const outcome = await migrateLegacyCredentials({
      readCredentials: () => legacy({ apiKey: 'sk-ant-api03-legacy' }),
      storage: makeStore().store,
      clearCaches: noopCaches,
    })
    expect(outcome.apiKey).toBe('sk-ant-api03-legacy')
    expect(outcome.migrated).toBe(false)
    expect(outcome.oauthAvailable).toBe(false)
    // …and the shared-refresh-token warning is about an OAuth token, so it must
    // not fire for an API key either.
    expect(outcome.notes.some(n => n.includes('refreshes first'))).toBe(false)
  })

  test('an existing occ login counts as available even though nothing was written', async () => {
    const { store } = makeStore({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-occ-own' },
    })
    const outcome = await migrateLegacyCredentials({
      readCredentials: () =>
        legacy({ oauth: OAUTH_BLOB, oauthSource: 'keychain' }),
      storage: store,
      clearCaches: noopCaches,
    })
    expect(outcome.migrated).toBe(false)
    // Drives both "the wizard can skip /login" and "stop re-offering the
    // top-up" — neither of which needs US to have done the writing.
    expect(outcome.oauthAvailable).toBe(true)
  })

  test('a failed storage write is an error, not a silent success', async () => {
    const outcome = await migrateLegacyCredentials({
      readCredentials: () =>
        legacy({ oauth: OAUTH_BLOB, oauthSource: 'keychain' }),
      storage: { read: () => null, update: () => ({ success: false }) },
      clearCaches: noopCaches,
    })
    expect(outcome.migrated).toBe(false)
    expect(outcome.errors[0]).toContain('could not write')
  })

  test('a throwing keychain read fails the credential step only', async () => {
    const outcome = await migrateLegacyCredentials({
      readCredentials: () => {
        throw new Error('security: boom')
      },
      storage: makeStore().store,
      clearCaches: noopCaches,
    })
    expect(outcome.errors[0]).toContain('security: boom')
    expect(outcome.migrated).toBe(false)
  })
})
