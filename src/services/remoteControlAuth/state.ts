import type { RemoteControlAuthMode, RemoteControlUser } from './types.js'

type AccessState = {
  accessToken: string
  expiresAt: number
  user: RemoteControlUser
}

const accessByBaseUrl = new Map<string, AccessState>()
const modeByBaseUrl = new Map<string, RemoteControlAuthMode>()

export function normalizeRemoteControlBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

export function setRemoteControlAuthMode(
  baseUrl: string,
  mode: RemoteControlAuthMode,
): void {
  modeByBaseUrl.set(normalizeRemoteControlBaseUrl(baseUrl), mode)
}

export function getRemoteControlAuthMode(
  baseUrl: string,
): RemoteControlAuthMode | undefined {
  return modeByBaseUrl.get(normalizeRemoteControlBaseUrl(baseUrl))
}

export function setRemoteControlAccessState(
  baseUrl: string,
  accessToken: string,
  expiresInSeconds: number,
  user: RemoteControlUser,
): void {
  accessByBaseUrl.set(normalizeRemoteControlBaseUrl(baseUrl), {
    accessToken,
    expiresAt: Date.now() + expiresInSeconds * 1000,
    user,
  })
}

export function getRemoteControlAccessToken(
  baseUrl: string,
  minimumValidityMs = 0,
): string | undefined {
  const state = accessByBaseUrl.get(normalizeRemoteControlBaseUrl(baseUrl))
  if (!state || state.expiresAt <= Date.now() + minimumValidityMs) {
    return undefined
  }
  return state.accessToken
}

export function getRemoteControlAccessTokenForRequest(
  baseUrl: string,
): string | undefined {
  return accessByBaseUrl.get(normalizeRemoteControlBaseUrl(baseUrl))
    ?.accessToken
}

/**
 * When the cached access token stops being accepted, in epoch milliseconds.
 *
 * A long-lived transport is validated against the exact credential it was
 * opened with on every frame, so knowing "when" is not the same question as
 * `getRemoteControlAccessToken(baseUrl, minimumValidityMs)`'s "still good?":
 * the bridge has to rebuild its socket *before* this moment rather than
 * discover the answer from a server-side close. Undefined for base URLs with
 * no account session (legacy servers, claude.ai) — callers treat that as
 * "nothing to schedule".
 */
export function getRemoteControlAccessExpiry(
  baseUrl: string,
): number | undefined {
  return accessByBaseUrl.get(normalizeRemoteControlBaseUrl(baseUrl))?.expiresAt
}

export function getRemoteControlUser(
  baseUrl: string,
): RemoteControlUser | undefined {
  return accessByBaseUrl.get(normalizeRemoteControlBaseUrl(baseUrl))?.user
}

export function clearRemoteControlAccessState(baseUrl: string): void {
  accessByBaseUrl.delete(normalizeRemoteControlBaseUrl(baseUrl))
}

export function clearRemoteControlAuthState(baseUrl: string): void {
  const normalized = normalizeRemoteControlBaseUrl(baseUrl)
  accessByBaseUrl.delete(normalized)
  modeByBaseUrl.delete(normalized)
}
