/**
 * OpenCode credential storage.
 *
 * Isolation invariant, same as the Antigravity store: tokens live in occ's own
 * config dir via occConfigPath() — never `~/.claude`, never the macOS keychain
 * record the official Claude Code CLI owns, and never
 * `~/.local/share/opencode/auth.json`, which belongs to the opencode CLI. A
 * user running both must be able to log out of one without touching the other.
 *
 * 0600 because the file holds a refresh token that mints access tokens for a
 * billed account.
 */

import { mkdir, readFile, unlink } from 'fs/promises'
import { occConfigDir, occConfigPath } from 'src/config/paths.js'
import { writePrivateFileAtomic } from 'src/utils/secureStorage/atomicWrite.js'
import { OPENCODE_AUTH_FILE, OPENCODE_CONSOLE_URL } from './constants.js'

/**
 * Where a Console account's requests go, and what they must carry.
 *
 * Read from `GET {console}/api/config` at login rather than assumed: the
 * console names its own inference proxy (`provider.opencode.api`) and the
 * headers that scope a request to the organization
 * (`provider.opencode.options.headers`, carrying `x-org-id`). Neither can be a
 * constant — the org id is per-account, and an enterprise console serves its
 * own endpoint.
 *
 * Stored beside the tokens because it has to outlive them: the access token is
 * refreshed roughly hourly and the refresh answers with tokens only, so the
 * endpoint and headers would be lost on the first renewal if they lived with
 * the token instead of with the account.
 */
export type OpencodeInferencePlane = {
  /** Base URL for the OpenAI-compatible inference proxy. */
  api: string
  /** Headers every request on that plane must carry. */
  headers?: Record<string, string>
}

export type OpencodeTokens = {
  accessToken: string
  refreshToken: string
  /** Epoch ms at which accessToken stops being accepted. */
  expiresAt: number
  /**
   * Console host these tokens belong to.
   *
   * Persisted rather than assumed: opencode's own refresh path reads a `server`
   * out of the credential metadata and falls back to the public console only
   * when absent, which is how self-hosted/enterprise deployments work. Pinning
   * the constant here would send an enterprise refresh token to the public
   * console on the first renewal.
   */
  server: string
  /** Selected organization, sent as `x-org-id`. Display name kept for the UI. */
  orgId?: string
  orgName?: string
  /** Account email, for display only. */
  email?: string
  /** ISO timestamp of the last successful token write. */
  lastRefresh?: string
  /** Console inference plane, as `/api/config` described it at login. */
  inference?: OpencodeInferencePlane
}

/** On-disk shape — snake_case to match the OAuth token wire. */
type StoredAuthFile = {
  auth_mode?: string
  server?: string
  tokens?: {
    access_token?: string
    refresh_token?: string
    expires_at?: number
    org_id?: string
    org_name?: string
    email?: string
  }
  last_refresh?: string
  inference?: {
    api?: string
    headers?: Record<string, unknown>
  }
}

function opencodeAuthFilePath(): string {
  return occConfigPath(OPENCODE_AUTH_FILE)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The stored plane, or nothing.
 *
 * Header values are re-validated on the way out rather than trusted: this file
 * is a JSON document on disk, and a non-string value here would reach `fetch`
 * as a header and throw at request time instead of at read time.
 */
function readInferencePlane(
  stored: StoredAuthFile['inference'],
): OpencodeInferencePlane | undefined {
  const api = asString(stored?.api)
  if (!api) return undefined
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(stored?.headers ?? {})) {
    const text = asString(value)
    if (text) headers[name] = text
  }
  return {
    api,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  }
}

export async function readOpencodeTokens(): Promise<OpencodeTokens | null> {
  try {
    const raw = await readFile(opencodeAuthFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as StoredAuthFile
    const tokens = parsed.tokens
    const accessToken = asString(tokens?.access_token)
    const refreshToken = asString(tokens?.refresh_token)
    // Without a refresh token the session is unrecoverable once the access
    // token lapses. Report "not logged in" so the caller offers a fresh login
    // instead of failing every request until expiry.
    if (!accessToken || !refreshToken) return null
    const inference = readInferencePlane(parsed.inference)
    return {
      accessToken,
      refreshToken,
      expiresAt: typeof tokens?.expires_at === 'number' ? tokens.expires_at : 0,
      server: asString(parsed.server) ?? OPENCODE_CONSOLE_URL,
      ...(asString(tokens?.org_id) ? { orgId: tokens?.org_id } : {}),
      ...(asString(tokens?.org_name) ? { orgName: tokens?.org_name } : {}),
      ...(asString(tokens?.email) ? { email: tokens?.email } : {}),
      ...(asString(parsed.last_refresh)
        ? { lastRefresh: parsed.last_refresh }
        : {}),
      ...(inference ? { inference } : {}),
    }
  } catch {
    return null
  }
}

export async function saveOpencodeTokens(
  tokens: OpencodeTokens,
): Promise<void> {
  const path = opencodeAuthFilePath()
  await mkdir(occConfigDir(), { recursive: true })
  const body: StoredAuthFile = {
    auth_mode: 'opencode',
    server: tokens.server,
    tokens: {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_at: tokens.expiresAt,
      ...(tokens.orgId ? { org_id: tokens.orgId } : {}),
      ...(tokens.orgName ? { org_name: tokens.orgName } : {}),
      ...(tokens.email ? { email: tokens.email } : {}),
    },
    last_refresh: new Date().toISOString(),
    // Carried across every write, refreshes included: `refreshAndPersist`
    // spreads the previous record, so the plane the login read survives a token
    // renewal that answers with tokens and nothing else.
    ...(tokens.inference ? { inference: tokens.inference } : {}),
  }
  await writePrivateFileAtomic(path, `${JSON.stringify(body, null, 2)}\n`)
}

export async function removeOpencodeTokens(): Promise<void> {
  await unlink(opencodeAuthFilePath()).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  })
}
