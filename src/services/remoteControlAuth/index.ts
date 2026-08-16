import type { SettingsJson } from '../../utils/settings/types.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import {
  fetchRemoteControlCapabilities,
  loginRemoteControlAccount,
  logoutRemoteControlAccount,
  refreshRemoteControlAccount,
  registerRemoteControlAccount,
} from './client.js'
import {
  clearRemoteControlCredential,
  readRemoteControlCredential,
  saveRemoteControlCredential,
} from './credentials.js'
import {
  clearRemoteControlAccessState,
  clearRemoteControlAuthState,
  getRemoteControlAccessExpiry,
  getRemoteControlAccessToken,
  getRemoteControlAuthMode,
  getRemoteControlUser,
  normalizeRemoteControlBaseUrl,
  setRemoteControlAccessState,
  setRemoteControlAuthMode,
} from './state.js'
import {
  RemoteControlAuthError,
  type RemoteControlAuthMode,
  type RemoteControlTokenResponse,
  type RemoteControlUser,
} from './types.js'

/**
 * `registrationEnabled` is reported for every status, not just the one that
 * opens the dialog: a caller that forces the account prompt (`/remote-control
 * register`) needs the server's real answer even when preparation succeeded,
 * and hardcoding `true` there offers registration on servers that disabled it.
 * The legacy 404 path has no capabilities document, so it reports `false`.
 */
type RemoteControlAuthPreparation = { registrationEnabled: boolean } & (
  | { status: 'authenticated'; user: RemoteControlUser }
  | { status: 'login_required' }
  | { status: 'legacy' }
)

const refreshes = new Map<string, Promise<boolean>>()

/**
 * Bumped when a logout reaches the point of no return for a base URL. A token
 * refresh captures the value it started under and refuses to write if it has
 * moved: bridge teardown runs concurrently with `/remote-control logout` and
 * its archive/deregister calls answer 401 by refreshing, so without this a
 * rotated — and therefore *valid* — refresh token can land in the vault
 * microseconds after logout emptied it.
 */
const logoutEpochs = new Map<string, number>()

/**
 * Base URLs whose vault entry is being cleared right now. Closes the one gap
 * the epoch cannot: a refresh that *starts* after the bump would capture the
 * new epoch and be allowed to persist while the clear is still awaiting.
 */
const clearingLogouts = new Set<string>()

function logoutEpoch(key: string): number {
  return logoutEpochs.get(key) ?? 0
}

function applyTokens(
  baseUrl: string,
  tokens: RemoteControlTokenResponse,
): void {
  setRemoteControlAccessState(
    baseUrl,
    tokens.access_token,
    tokens.expires_in,
    tokens.user,
  )
}

/**
 * Writes a token pair to memory and the vault. Returns false when `guard` is
 * supplied and a logout has since invalidated the write.
 */
async function persistTokens(
  baseUrl: string,
  tokens: RemoteControlTokenResponse,
  guard?: { epoch: number },
): Promise<boolean> {
  const key = normalizeRemoteControlBaseUrl(baseUrl)
  if (guard && (logoutEpoch(key) !== guard.epoch || clearingLogouts.has(key))) {
    return false
  }
  applyTokens(key, tokens)
  await saveRemoteControlCredential(
    key,
    tokens.user.username,
    tokens.refresh_token,
  )
  migrateLegacyBridgeToken()
  return true
}

function migrateLegacyBridgeToken(): void {
  if (!process.env.CLAUDE_BRIDGE_OAUTH_TOKEN) return
  const patch = {
    env: { CLAUDE_BRIDGE_OAUTH_TOKEN: undefined },
  } as unknown as SettingsJson
  const { error } = updateSettingsForSource('userSettings', patch)
  if (!error) {
    delete process.env.CLAUDE_BRIDGE_OAUTH_TOKEN
  }
}

async function refreshStoredCredential(baseUrl: string): Promise<boolean> {
  const key = normalizeRemoteControlBaseUrl(baseUrl)
  const epoch = logoutEpoch(key)
  const credential = await readRemoteControlCredential(key)
  if (!credential) return false

  try {
    const tokens = await refreshRemoteControlAccount(
      key,
      credential.refreshToken,
    )
    return await persistTokens(key, tokens, { epoch })
  } catch (error) {
    if (error instanceof RemoteControlAuthError && error.status === 401) {
      await clearRemoteControlCredential(key)
      clearRemoteControlAccessState(key)
    }
    return false
  }
}

export async function prepareRemoteControlAuthentication(
  baseUrl: string,
): Promise<RemoteControlAuthPreparation> {
  const normalizedBaseUrl = normalizeRemoteControlBaseUrl(baseUrl)
  let capabilities
  try {
    capabilities = await fetchRemoteControlCapabilities(normalizedBaseUrl)
  } catch (error) {
    if (error instanceof RemoteControlAuthError && error.status === 404) {
      setRemoteControlAuthMode(normalizedBaseUrl, 'legacy_api_key')
      return { status: 'legacy', registrationEnabled: false }
    }
    throw error
  }

  const registrationEnabled = capabilities.registration_enabled
  setRemoteControlAuthMode(normalizedBaseUrl, capabilities.auth_mode)
  if (capabilities.auth_mode !== 'accounts') {
    return { status: 'legacy', registrationEnabled }
  }

  const accessToken = getRemoteControlAccessToken(normalizedBaseUrl, 30_000)
  const user = getRemoteControlUser(normalizedBaseUrl)
  if (accessToken && user) {
    return { status: 'authenticated', user, registrationEnabled }
  }

  if (await refreshRemoteControlAccessToken(normalizedBaseUrl)) {
    const refreshedUser = getRemoteControlUser(normalizedBaseUrl)
    if (refreshedUser) {
      return {
        status: 'authenticated',
        user: refreshedUser,
        registrationEnabled,
      }
    }
  }

  return { status: 'login_required', registrationEnabled }
}

export async function authenticateRemoteControl(
  baseUrl: string,
  action: 'login' | 'register',
  username: string,
  password: string,
): Promise<RemoteControlUser> {
  const tokens =
    action === 'register'
      ? await registerRemoteControlAccount(baseUrl, username, password)
      : await loginRemoteControlAccount(baseUrl, username, password)
  setRemoteControlAuthMode(baseUrl, 'accounts')
  await persistTokens(baseUrl, tokens)
  return tokens.user
}

export async function refreshRemoteControlAccessToken(
  baseUrl: string,
  staleAccessToken?: string,
): Promise<boolean> {
  if (getRemoteControlAuthMode(baseUrl) !== 'accounts') {
    return false
  }

  const key = normalizeRemoteControlBaseUrl(baseUrl)
  // The credential is being torn down. Reporting success here would hand the
  // caller an access token the logout is about to revoke, and the refresh
  // itself would race the vault clear.
  if (clearingLogouts.has(key)) {
    return false
  }

  const current = getRemoteControlAccessToken(baseUrl)
  if (staleAccessToken && current && current !== staleAccessToken) {
    return true
  }

  const existing = refreshes.get(key)
  if (existing) return existing

  const refresh = refreshStoredCredential(key).finally(() => {
    refreshes.delete(key)
  })
  refreshes.set(key, refresh)
  return refresh
}

export async function logoutRemoteControl(baseUrl: string): Promise<void> {
  const key = normalizeRemoteControlBaseUrl(baseUrl)
  let credential = await readRemoteControlCredential(key)
  try {
    if (credential) {
      // Revocation needs a live access token and the current refresh token, so
      // this preparation (and the refresh it may trigger) has to run *before*
      // the barrier below — it is the one write the logout wants.
      await prepareRemoteControlAuthentication(key)
      credential = await readRemoteControlCredential(key)
    }
    await logoutRemoteControlAccount(
      key,
      getRemoteControlAccessToken(key),
      credential?.refreshToken,
    )
  } catch (error) {
    if (!(error instanceof RemoteControlAuthError) || error.status >= 500) {
      throw error
    }
  } finally {
    // Let a refresh that is already in flight finish before touching the
    // vault, so its write cannot land after the clear. Then close the door:
    // the epoch bump invalidates anything still holding an older snapshot and
    // the in-flight marker stops new refreshes from starting mid-clear.
    await refreshes.get(key)?.catch(() => false)
    logoutEpochs.set(key, logoutEpoch(key) + 1)
    clearingLogouts.add(key)
    try {
      await clearRemoteControlCredential(key)
      clearRemoteControlAuthState(key)
    } finally {
      clearingLogouts.delete(key)
    }
  }
}

export {
  getRemoteControlAccessExpiry,
  getRemoteControlAuthMode,
  getRemoteControlUser,
  RemoteControlAuthError,
}
export type { RemoteControlUser }
