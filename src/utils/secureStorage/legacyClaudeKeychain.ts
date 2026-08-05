/**
 * READ-ONLY access to the OFFICIAL Claude Code's credential storage.
 *
 * Used by one caller only: `occ migrate --with-credentials` (and the matching
 * first-run wizard option), which copies the user's existing login into occ's
 * OWN storage so they do not have to `/login` twice. Nothing here writes,
 * updates or deletes an official entry — `~/.claude` and the official keychain
 * items stay exactly as the official CLI left them.
 *
 * WHY A SEPARATE MODULE
 *
 * `macOsKeychainHelpers.ts` deliberately owns occ's own service names and must
 * stay import-light, because keychainPrefetch.ts pulls it at the very top of
 * startup (see that file's header). This module is the mirror image: it names
 * the OFFICIAL entries, and it is only ever loaded from the migration path, so
 * it is free to shell out. It must therefore NEVER be imported from
 * keychainPrefetch.ts or from anything that file reaches.
 *
 * SERVICE NAMES
 *
 * The official CLI builds `Claude Code<oauthSuffix><serviceSuffix>` and appends
 * `-<sha256(configDir)[0..8]>` ONLY when CLAUDE_CONFIG_DIR is set. So a default
 * install stores OAuth under exactly `Claude Code-credentials`.
 *
 * The hashed variant is therefore only probed when CLAUDE_CONFIG_DIR is set in
 * THIS process, and the hash is taken over that variable's value — the same
 * input the official CLI used. An earlier version hashed
 * `legacyClaudeConfigDir()`, which is hardcoded to `~/.claude` and is exactly
 * the case where the official CLI appends no hash at all: the second candidate
 * could never match anything, so it was a dead probe advertised as coverage.
 *
 * The oauth suffix is hardcoded to production (''): the staging and local
 * variants only exist inside Anthropic, and nobody migrates from them.
 *
 * `security find-generic-password` on an entry written by the official CLI does
 * NOT prompt: both binaries run unsigned/ad-hoc from the same user account, so
 * the item's ACL already allows access. A locked login keychain (SSH sessions)
 * is the one case that fails, and it is reported rather than swallowed —
 * silently telling a user "no credentials found" when the truth is "your
 * keychain is locked" sends them off to re-run /login for no reason.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { legacyClaudeConfigDir } from 'src/config/paths.js'
import { getUsername } from './macOsKeychainHelpers.js'

/** The official CLI's keychain service-name prefix. Never occ's. */
export const LEGACY_KEYCHAIN_SERVICE_PREFIX = 'Claude Code'

/** Suffix the official CLI uses for the OAuth blob (its API key entry has none). */
export const LEGACY_CREDENTIALS_SERVICE_SUFFIX = '-credentials'

/** Bound on every `security` spawn so a stuck keychain cannot hang a migration. */
const SECURITY_TIMEOUT_MS = 10_000

/** Exit code `security` returns when the login keychain is locked. */
const KEYCHAIN_LOCKED_EXIT_CODE = 36

/**
 * Candidate service names for an official entry, most likely first.
 *
 * `serviceSuffix` is `LEGACY_CREDENTIALS_SERVICE_SUFFIX` for the OAuth blob and
 * `''` for the legacy API key.
 *
 * One candidate on a default install. The hashed second candidate exists only
 * when CLAUDE_CONFIG_DIR is set, because that is the only case in which the
 * official CLI appends a hash — and it hashes that variable, not `~/.claude`.
 */
export function getLegacyClaudeKeychainServiceNames(
  serviceSuffix: string = '',
): string[] {
  const base = `${LEGACY_KEYCHAIN_SERVICE_PREFIX}${serviceSuffix}`
  const configured = process.env.CLAUDE_CONFIG_DIR
  if (!configured) return [base]
  const dirHash = createHash('sha256')
    .update(resolve(configured))
    .digest('hex')
    .substring(0, 8)
  return [base, `${base}-${dirHash}`]
}

export type LegacyCredentialSource = 'keychain' | 'file'

export type LegacyClaudeCredentials = {
  /**
   * The official CLI's whole secure-storage blob, normally
   * `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, … } }`.
   * Copied wholesale rather than field-by-field so fields added on the
   * official side ride along instead of being silently dropped.
   */
  oauth: Record<string, unknown> | null
  oauthSource: LegacyCredentialSource | null
  /** The pre-OAuth API key entry, still present for long-lived installs. */
  apiKey: string | null
  /**
   * True when the login keychain is locked, which makes a null `oauth` mean
   * "could not look" rather than "not there".
   */
  keychainLocked: boolean
}

/** Whether the login keychain is locked (SSH sessions, mostly). */
export function isLoginKeychainLocked(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    execFileSync('security', ['show-keychain-info'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SECURITY_TIMEOUT_MS,
    })
    return false
  } catch (error) {
    return (error as { status?: number }).status === KEYCHAIN_LOCKED_EXIT_CODE
  }
}

function readKeychainSecret(service: string): string | null {
  try {
    const stdout = execFileSync(
      'security',
      ['find-generic-password', '-a', getUsername(), '-w', '-s', service],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: SECURITY_TIMEOUT_MS,
      },
    )
    const trimmed = stdout.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    // Not found, locked, or `security` missing — all indistinguishable here and
    // all mean "no value". Lock state is probed separately.
    return null
  }
}

/** A blob only counts as OAuth if it actually carries an access token. */
function asOAuthBlob(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const oauth = parsed.claudeAiOauth as { accessToken?: unknown } | undefined
    if (!oauth || typeof oauth !== 'object') return null
    if (
      typeof oauth.accessToken !== 'string' ||
      oauth.accessToken.length === 0
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * Read whatever login the official CLI has, without touching it.
 *
 * Order: keychain (unhashed name, then the CLAUDE_CONFIG_DIR-hashed one), then
 * the plaintext `~/.claude/.credentials.json` that non-macOS installs — and
 * macOS installs whose keychain write failed — fall back to.
 */
export function readLegacyClaudeCredentials(): LegacyClaudeCredentials {
  const result: LegacyClaudeCredentials = {
    oauth: null,
    oauthSource: null,
    apiKey: null,
    keychainLocked: false,
  }

  if (process.platform === 'darwin') {
    for (const service of getLegacyClaudeKeychainServiceNames(
      LEGACY_CREDENTIALS_SERVICE_SUFFIX,
    )) {
      const raw = readKeychainSecret(service)
      const blob = raw ? asOAuthBlob(raw) : null
      if (blob) {
        result.oauth = blob
        result.oauthSource = 'keychain'
        break
      }
    }

    for (const service of getLegacyClaudeKeychainServiceNames()) {
      const raw = readKeychainSecret(service)
      // The API key entry is a bare string, not JSON. Anything that parses as
      // the OAuth blob is the wrong entry and must not be treated as a key.
      if (raw && !asOAuthBlob(raw)) {
        result.apiKey = raw
        break
      }
    }

    if (!result.oauth && !result.apiKey) {
      result.keychainLocked = isLoginKeychainLocked()
    }
  }

  if (!result.oauth) {
    try {
      const raw = readFileSync(
        join(legacyClaudeConfigDir(), '.credentials.json'),
        'utf8',
      )
      const blob = asOAuthBlob(raw)
      if (blob) {
        result.oauth = blob
        result.oauthSource = 'file'
      }
    } catch {
      // No file fallback — normal on a keychain-backed install.
    }
  }

  return result
}
