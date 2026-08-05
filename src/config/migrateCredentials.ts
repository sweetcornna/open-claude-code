/**
 * The credential half of `occ migrate --with-credentials`.
 *
 * Split out of migrateFromClaude.ts on purpose: that module is imported by the
 * first-run wizard and by the pre-bootstrap `occ migrate` fast path, and must
 * stay cheap to load. Everything here shells out to `security`, reads occ's
 * secure storage and clears auth caches, so it is dynamically imported and only
 * ever evaluated when the user actually asked for their login to come across.
 *
 * NO-CLOBBER, same as the rest of the migration: if occ already holds an OAuth
 * token, the legacy one is left alone and the fact is reported. A migration
 * that overwrote a working login would be the exact failure mode the whole
 * ~/.claude ↔ ~/.occ isolation exists to prevent.
 *
 * The three side effects are injectable rather than mocked. `mock.module` is
 * process-global in Bun, and substituting the keychain reader or occ's secure
 * storage for one suite would substitute it for every suite that ran
 * afterwards; parameters keep the seam local. Production always uses the
 * defaults.
 */

import type { LegacyClaudeCredentials } from '../utils/secureStorage/legacyClaudeKeychain.js'

export type CredentialMigrationOutcome = {
  /**
   * True when the OAuth blob was actually written into occ's storage.
   *
   * Scoped to the OAuth write on purpose: whether the legacy API key lands is
   * decided by the caller's ~/.occ.json merge (occ's own `primaryApiKey` wins),
   * so claiming it here would report a copy the no-clobber rule then refused —
   * and a `.migrated` marker built on that claim would short-circuit a top-up
   * that still had work to do.
   */
  migrated: boolean
  /**
   * True when occ holds an OAuth login now — whether this run wrote it or it
   * was already there. Drives "no /login needed", which is true either way.
   */
  oauthAvailable: boolean
  /**
   * The official CLI's legacy API key, if it had one. Returned rather than
   * written here so the caller can fold it into the single ~/.occ.json write
   * it already performs.
   */
  apiKey: string | null
  /** Human-readable lines for the migration report. */
  notes: string[]
  errors: string[]
}

/** The slice of occ's SecureStorage this module needs. */
export type CredentialStore = {
  read: () => Record<string, unknown> | null
  update: (data: Record<string, unknown>) => {
    success: boolean
    warning?: string
  }
}

export type MigrateCredentialsDeps = {
  /** Defaults to reading the official CLI's keychain / credentials file. */
  readCredentials?: () => LegacyClaudeCredentials
  /** Defaults to occ's own secure storage (keychain, plaintext fallback). */
  storage?: CredentialStore
  /** Defaults to dropping the memoized auth reads. */
  clearCaches?: () => Promise<void>
}

/**
 * Copy the official CLI's login into occ's own storage.
 *
 * Returns rather than throws: a credential migration that fails is a reason to
 * run `/login`, not a reason to lose the settings and plugins the same run just
 * copied.
 */
export async function migrateLegacyCredentials(
  deps: MigrateCredentialsDeps = {},
): Promise<CredentialMigrationOutcome> {
  const outcome: CredentialMigrationOutcome = {
    migrated: false,
    oauthAvailable: false,
    apiKey: null,
    notes: [],
    errors: [],
  }

  let legacy: LegacyClaudeCredentials
  try {
    const read =
      deps.readCredentials ??
      (await import('../utils/secureStorage/legacyClaudeKeychain.js'))
        .readLegacyClaudeCredentials
    legacy = read()
  } catch (error) {
    outcome.errors.push(`credentials: ${(error as Error).message}`)
    return outcome
  }

  outcome.apiKey = legacy.apiKey

  if (legacy.keychainLocked) {
    if (!legacy.oauth && !legacy.apiKey) {
      // Nothing found AND we could not look: those are different facts, and
      // reporting the first while the second is true sends the user off to
      // re-run /login for a login they already have.
      outcome.errors.push(
        'credentials: the macOS login keychain is locked, so your existing Claude Code login could not be read. ' +
          'Unlock it (`security unlock-keychain`) and re-run `occ migrate --with-credentials`, or sign in with /login.',
      )
      return outcome
    }
    // Locked, but the plaintext `~/.claude/.credentials.json` fallback had what
    // we needed. Say so and carry on — bailing here would throw away a
    // credential we are holding.
    outcome.notes.push(
      'The macOS login keychain was locked; read the login from ~/.claude/.credentials.json instead.',
    )
  }

  if (!legacy.oauth && !legacy.apiKey) {
    outcome.notes.push(
      'No stored Claude Code login was found — sign in with /login.',
    )
    return outcome
  }

  if (legacy.oauth) {
    try {
      const storage =
        deps.storage ??
        ((
          await import('../utils/secureStorage/index.js')
        ).getSecureStorage() as CredentialStore)

      const existing = storage.read() ?? null
      const existingOauth = existing?.claudeAiOauth as
        | { accessToken?: unknown }
        | undefined

      if (typeof existingOauth?.accessToken === 'string') {
        outcome.oauthAvailable = true
        outcome.notes.push(
          'open-claude-code already has a stored login — kept it and left the Claude Code one alone.',
        )
      } else {
        // Merge, don't replace: occ's blob can hold entries the official one
        // never had, and the whole point of the no-clobber rule is that a
        // migration only ever fills gaps.
        const status = storage.update({ ...(existing ?? {}), ...legacy.oauth })
        if (status.success) {
          outcome.migrated = true
          outcome.oauthAvailable = true
          outcome.notes.push(
            `OAuth login copied from the official Claude Code (${legacy.oauthSource}) into open-claude-code's own storage.`,
          )
          if (status.warning) outcome.notes.push(status.warning)
          await (deps.clearCaches ?? clearAuthCaches)()
        } else {
          outcome.errors.push(
            'credentials: could not write the OAuth token to open-claude-code storage — sign in with /login.',
          )
        }
      }
    } catch (error) {
      outcome.errors.push(`credentials: ${(error as Error).message}`)
    }
  }

  // The legacy API key is NOT reported as migrated here. It is handed back for
  // the caller's ~/.occ.json merge, which applies the same no-clobber rule and
  // is the only place that knows whether it actually landed. Deliberately not
  // written to occ's own keychain entry either: one storage location is enough,
  // and a config key is trivially reversible by a user who changes their mind.

  if (outcome.migrated) {
    outcome.notes.push(
      'Heads up: the refresh token is rotated by the server, and both CLIs now hold the same one. ' +
        'Whichever refreshes first invalidates the other, so expect to /login again on the CLI you use less.',
    )
  }

  return outcome
}

/**
 * Drop the memoized auth reads so the running process sees the token we just
 * wrote. Matters for the first-run wizard, where the migration step runs inside
 * a process that has already answered "not logged in" at least once.
 */
async function clearAuthCaches(): Promise<void> {
  try {
    const auth = await import('../utils/auth/auth.js')
    auth.clearOAuthTokenCache()
    auth.getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
  } catch {
    // Best-effort. A stale cache costs one restart; failing the migration over
    // it would cost the user their credentials.
  }
  try {
    const { clearLegacyApiKeyPrefetch } = await import(
      '../utils/secureStorage/keychainPrefetch.js'
    )
    clearLegacyApiKeyPrefetch()
  } catch {
    // Same.
  }
}
