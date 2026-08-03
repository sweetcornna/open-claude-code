/**
 * Antigravity credential storage.
 *
 * Isolation invariant: tokens live in occ's own config dir via occConfigPath()
 * — never `~/.claude`, never the macOS keychain record the official Claude Code
 * CLI owns. Antigravity credentials are Google account tokens, so a stray write
 * into the shared keychain entry would clobber an unrelated login.
 *
 * File mode is 0600 for the same reason the ChatGPT auth file is: it holds a
 * refresh token that mints Google Cloud access tokens.
 */

import { chmod, mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { occConfigDir, occConfigPath } from 'src/config/paths.js'
import { ANTIGRAVITY_AUTH_FILE } from './constants.js'

export type AntigravityTokens = {
  accessToken: string
  refreshToken: string
  /** Epoch ms at which accessToken stops being accepted. */
  expiresAt: number
  /** Google account email, for display only. */
  email?: string
  /** cloudaicompanionProject discovered via loadCodeAssist/onboardUser. */
  projectId?: string
  /** ISO timestamp of the last successful token write. */
  lastRefresh?: string
}

/** On-disk shape — snake_case to match the Google/Antigravity token wire. */
type StoredAuthFile = {
  auth_mode?: string
  tokens?: {
    access_token?: string
    refresh_token?: string
    expires_at?: number
    email?: string
    project_id?: string
  }
  last_refresh?: string
}

export function antigravityAuthFilePath(): string {
  return occConfigPath(ANTIGRAVITY_AUTH_FILE)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export async function readAntigravityTokens(): Promise<AntigravityTokens | null> {
  try {
    const raw = await readFile(antigravityAuthFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as StoredAuthFile
    const tokens = parsed.tokens
    const accessToken = asString(tokens?.access_token)
    const refreshToken = asString(tokens?.refresh_token)
    // A file without a refresh token is unrecoverable once the access token
    // lapses; treat it as "not logged in" so the caller prompts a fresh login
    // rather than failing every request until expiry.
    if (!accessToken || !refreshToken) return null
    return {
      accessToken,
      refreshToken,
      expiresAt: typeof tokens?.expires_at === 'number' ? tokens.expires_at : 0,
      ...(asString(tokens?.email) ? { email: tokens?.email } : {}),
      ...(asString(tokens?.project_id)
        ? { projectId: tokens?.project_id }
        : {}),
      ...(asString(parsed.last_refresh)
        ? { lastRefresh: parsed.last_refresh }
        : {}),
    }
  } catch {
    return null
  }
}

export async function saveAntigravityTokens(
  tokens: AntigravityTokens,
): Promise<void> {
  const path = antigravityAuthFilePath()
  await mkdir(occConfigDir(), { recursive: true })
  const body: StoredAuthFile = {
    auth_mode: 'antigravity',
    tokens: {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_at: tokens.expiresAt,
      ...(tokens.email ? { email: tokens.email } : {}),
      ...(tokens.projectId ? { project_id: tokens.projectId } : {}),
    },
    last_refresh: new Date().toISOString(),
  }
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600).catch(() => undefined)
}

export async function removeAntigravityTokens(): Promise<void> {
  await unlink(antigravityAuthFilePath()).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  })
}
