/**
 * Antigravity OAuth wire calls: authorization URL, code exchange, refresh,
 * user info, and GCP project discovery.
 *
 * Flow type is a **loopback authorization-code flow**, not device code: Google
 * redirects the browser to http://localhost:<port>/oauth-callback, and the
 * client swaps `code` for tokens using the installed-app client id + secret.
 * (The ChatGPT path next door is device-code because OpenAI's Codex client
 * exposes a device endpoint; Google's does not for this client.)
 *
 * Project discovery is mandatory, not decorative. Every generate call carries a
 * `project` field, and the backend rejects requests whose project is absent or
 * does not belong to the caller. `loadCodeAssist` returns it for accounts that
 * have used Antigravity before; brand-new accounts must be pushed through
 * `onboardUser`, which is a long-running operation that has to be polled until
 * `done: true`.
 *
 * No UI imports — this is a pure service module consumed by /login, the
 * onboarding wizard, /search-setting, and the Gemini request path alike.
 */

import { NonRetryableError } from 'src/services/api/retryClassification.js'
import { searchOAuthCopyPath } from 'src/services/search/oauthCopies.js'
import { getProxyFetchOptions } from 'src/utils/network/proxy.js'
import {
  errorMessageWithCause,
  isAbortError,
} from 'src/utils/runtime/errors.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import {
  ANTIGRAVITY_API_BASE_DAILY,
  ANTIGRAVITY_API_BASE_PROD,
  ANTIGRAVITY_API_VERSION,
  ANTIGRAVITY_AUTH_ENDPOINT,
  ANTIGRAVITY_GOOG_API_CLIENT,
  ANTIGRAVITY_IDE_NAME,
  ANTIGRAVITY_IDE_TYPE,
  ANTIGRAVITY_IDE_VERSION,
  ANTIGRAVITY_ONBOARD_USER_AGENT,
  ANTIGRAVITY_REFRESH_SKEW_MS,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_TOKEN_ENDPOINT,
  ANTIGRAVITY_USER_AGENT,
  ANTIGRAVITY_USERINFO_ENDPOINT,
  getAntigravityClientId,
  getAntigravityClientSecret,
} from './constants.js'
import {
  type AntigravityTokens,
  antigravityAuthFilePath,
  readAntigravityTokens,
  removeAntigravityTokens,
  saveAntigravityTokens,
} from './store.js'

export type { AntigravityTokens }

/** Everything a generate request needs from the credential store. */
export type AntigravityAuth = {
  accessToken: string
  projectId: string
}

type FetchLike = typeof fetch

type GoogleTokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
}

function proxyOptions(): RequestInit {
  return getProxyFetchOptions({ forAnthropicAPI: false }) as RequestInit
}

/**
 * Run a fetch, turning a transport-level failure into something the user can
 * act on.
 *
 * Every endpoint here is a Google host. When one is unreachable — blocked
 * network, TLS interception, a proxy that is down — Node rejects with the bare
 * string "fetch failed" and hides the reason in `error.cause`, so the login
 * screen used to show exactly two useless words. Name the step and the host,
 * keep the underlying cause, and point at the proxy knob that fixes it.
 */
async function fetchGoogleEndpoint(
  step: string,
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<Response> {
  try {
    return await fetchImpl(url, init)
  } catch (e) {
    if (isAbortError(e)) throw e
    const host = (() => {
      try {
        return new URL(url).host
      } catch {
        return url
      }
    })()
    throw new Error(
      `Cannot reach ${host} for ${step}: ${errorMessageWithCause(e)}. ` +
        `Check your network, or set HTTPS_PROXY if this host needs a proxy.`,
      { cause: e },
    )
  }
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  return text.trim().slice(0, 500)
}

/**
 * Build the Google consent URL.
 *
 * `access_type=offline` + `prompt=consent` are both required: without them
 * Google withholds the refresh token on repeat authorizations, which would
 * silently turn every login into a one-hour session.
 */
export function buildAntigravityAuthUrl(params: {
  state: string
  redirectUri: string
}): string {
  const query = new URLSearchParams({
    access_type: 'offline',
    client_id: getAntigravityClientId(),
    prompt: 'consent',
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: ANTIGRAVITY_SCOPES.join(' '),
    state: params.state,
  })
  return `${ANTIGRAVITY_AUTH_ENDPOINT}?${query.toString()}`
}

function tokensFromResponse(
  data: GoogleTokenResponse,
  previous?: AntigravityTokens,
): AntigravityTokens {
  const accessToken = data.access_token ?? previous?.accessToken
  // Google omits refresh_token on refresh responses; keep the existing one.
  const refreshToken = data.refresh_token ?? previous?.refreshToken
  if (!accessToken || !refreshToken) {
    throw new Error('Antigravity token response was missing a token')
  }
  const expiresInMs =
    typeof data.expires_in === 'number' && data.expires_in > 0
      ? data.expires_in * 1000
      : 3600 * 1000
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresInMs,
    ...(previous?.email ? { email: previous.email } : {}),
    ...(previous?.projectId ? { projectId: previous.projectId } : {}),
  }
}

async function postTokenEndpoint(
  body: URLSearchParams,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<GoogleTokenResponse> {
  const response = await fetchGoogleEndpoint(
    'the OAuth token exchange',
    ANTIGRAVITY_TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      ...(signal ? { signal } : {}),
      ...proxyOptions(),
    },
    fetchImpl,
  )
  if (!response.ok) {
    const detail = await readErrorBody(response)
    throw new Error(
      `Antigravity token request failed (${response.status})${detail ? `: ${detail}` : ''}`,
    )
  }
  return (await response.json()) as GoogleTokenResponse
}

export async function exchangeAntigravityCode(params: {
  code: string
  redirectUri: string
  fetchImpl?: FetchLike
}): Promise<AntigravityTokens> {
  await invalidateAntigravityRefreshes()
  const data = await postTokenEndpoint(
    new URLSearchParams({
      code: params.code,
      client_id: getAntigravityClientId(),
      client_secret: getAntigravityClientSecret(),
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
    }),
    params.fetchImpl ?? fetch,
  )
  // A request could have read the old credential file while the code exchange
  // was in flight. Invalidate it before the caller persists the new login.
  await invalidateAntigravityRefreshes()
  return tokensFromResponse(data)
}

export async function refreshAntigravityTokens(
  tokens: AntigravityTokens,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<AntigravityTokens> {
  const data = await postTokenEndpoint(
    new URLSearchParams({
      client_id: getAntigravityClientId(),
      client_secret: getAntigravityClientSecret(),
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    }),
    fetchImpl,
    signal,
  )
  return tokensFromResponse(data, tokens)
}

export async function fetchAntigravityUserEmail(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<string | undefined> {
  const response = await fetchGoogleEndpoint(
    'the account lookup',
    ANTIGRAVITY_USERINFO_ENDPOINT,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': ANTIGRAVITY_USER_AGENT,
      },
      ...proxyOptions(),
    },
    fetchImpl,
  )
  if (!response.ok) return undefined
  const data = (await response.json().catch(() => null)) as {
    email?: string
  } | null
  const email = data?.email?.trim()
  return email || undefined
}

function extractProjectId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  for (const key of ['cloudaicompanionProject', 'projectId', 'project']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (value && typeof value === 'object') {
      const id = (value as Record<string, unknown>).id
      if (typeof id === 'string' && id.trim()) return id.trim()
    }
  }
  return undefined
}

/**
 * Pick the tier to onboard into: the entry flagged `isDefault` in
 * `allowedTiers`, else whatever the account currently sits on, else free.
 */
function defaultTierId(loadResponse: unknown): string {
  const record =
    loadResponse && typeof loadResponse === 'object'
      ? (loadResponse as Record<string, unknown>)
      : {}
  const tiers = record.allowedTiers
  if (Array.isArray(tiers)) {
    for (const tier of tiers) {
      if (!tier || typeof tier !== 'object') continue
      const entry = tier as Record<string, unknown>
      if (
        entry.isDefault === true &&
        typeof entry.id === 'string' &&
        entry.id
      ) {
        return entry.id
      }
    }
  }
  const current = record.currentTier
  if (current && typeof current === 'object') {
    const id = (current as Record<string, unknown>).id
    if (typeof id === 'string' && id.trim()) return id.trim()
  }
  return 'free-tier'
}

async function onboardAntigravityUser(params: {
  accessToken: string
  tierId: string
  fetchImpl: FetchLike
  signal?: AbortSignal
}): Promise<string | undefined> {
  const url = `${ANTIGRAVITY_API_BASE_DAILY}/${ANTIGRAVITY_API_VERSION}:onboardUser`
  const body = JSON.stringify({
    tier_id: params.tierId,
    metadata: {
      ide_type: ANTIGRAVITY_IDE_TYPE,
      ide_version: ANTIGRAVITY_IDE_VERSION,
      ide_name: ANTIGRAVITY_IDE_NAME,
    },
  })
  // onboardUser is a long-running operation: a 200 with `done: false` means
  // "still provisioning", so poll rather than treating the first reply as final.
  const maxAttempts = 5
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (params.signal?.aborted) throw new Error('Antigravity login cancelled')
    const response = await fetchGoogleEndpoint(
      'user onboarding',
      url,
      {
        method: 'POST',
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${params.accessToken}`,
          'User-Agent': ANTIGRAVITY_ONBOARD_USER_AGENT,
          'X-Goog-Api-Client': ANTIGRAVITY_GOOG_API_CLIENT,
        },
        body,
        ...(params.signal ? { signal: params.signal } : {}),
        ...proxyOptions(),
      },
      params.fetchImpl,
    )
    if (!response.ok) {
      const detail = await readErrorBody(response)
      throw new Error(
        `Antigravity onboardUser failed (${response.status})${detail ? `: ${detail}` : ''}`,
      )
    }
    const data = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    if (data?.done === true) {
      return extractProjectId(data.response)
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  return undefined
}

/**
 * Resolve the cloudaicompanion project for this account, onboarding it first
 * if Google has never provisioned one.
 */
export async function discoverAntigravityProject(params: {
  accessToken: string
  fetchImpl?: FetchLike
  signal?: AbortSignal
}): Promise<string> {
  const fetchImpl = params.fetchImpl ?? fetch
  const url = `${ANTIGRAVITY_API_BASE_PROD}/${ANTIGRAVITY_API_VERSION}:loadCodeAssist`
  const response = await fetchGoogleEndpoint(
    'project discovery',
    url,
    {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.accessToken}`,
        'User-Agent': ANTIGRAVITY_USER_AGENT,
      },
      body: JSON.stringify({ metadata: { ideType: ANTIGRAVITY_IDE_TYPE } }),
      ...(params.signal ? { signal: params.signal } : {}),
      ...proxyOptions(),
    },
    fetchImpl,
  )
  if (!response.ok) {
    const detail = await readErrorBody(response)
    throw new Error(
      `Antigravity loadCodeAssist failed (${response.status})${detail ? `: ${detail}` : ''}`,
    )
  }
  const loadResponse = (await response.json().catch(() => null)) as unknown
  const existing = extractProjectId(loadResponse)
  if (existing) return existing

  const onboarded = await onboardAntigravityUser({
    accessToken: params.accessToken,
    tierId: defaultTierId(loadResponse),
    fetchImpl,
    ...(params.signal ? { signal: params.signal } : {}),
  })
  if (!onboarded) {
    // Onboarding completed and still produced no project — the account is not
    // provisioned for Antigravity. Only a human action in the Antigravity app
    // changes that, so this must not enter the retry ladder. The prose ends in
    // "then retry", which is advice for the user, not for the client.
    throw new NonRetryableError(
      'Antigravity project discovery returned no project. Open Antigravity once with this Google account, then retry.',
      { category: 'invalid_request' },
    )
  }
  return onboarded
}

/**
 * Which credential files a caller may authenticate from.
 *
 * `'provider'` is the login file `/login` writes and `/logout` deletes.
 * `'search'` adds web search's own copy of it — the copy exists precisely
 * because `/logout` deletes the original, which used to drop the `gemini`
 * search source to the keyless scraping lane without saying anything (see
 * services/search/oauthCopies.ts).
 *
 * The login file is FIRST on both planes: while a login exists it is the
 * freshest by construction — every provider request refreshes it — so the copy
 * must never outrank it. And the copy is on the search plane ONLY: if the main
 * loop could fall through to it, `/logout` would not log anything out.
 */
export type AntigravityCredentialPlane = 'provider' | 'search'

function credentialPaths(plane: AntigravityCredentialPlane): string[] {
  const own = antigravityAuthFilePath()
  return plane === 'search' ? [own, searchOAuthCopyPath('gemini')] : [own]
}

/** The first file on this plane that holds a usable login, and which file it was. */
async function readPlaneTokens(
  plane: AntigravityCredentialPlane,
): Promise<{ tokens: AntigravityTokens; path: string } | null> {
  for (const path of credentialPaths(plane)) {
    const tokens = await readAntigravityTokens(path)
    if (tokens) return { tokens, path }
  }
  return null
}

type InFlightRefresh = {
  generation: number
  controller: AbortController
  promise: Promise<AntigravityTokens>
}

// Refreshes dedupe only for the same credential identity. A global promise
// lets a newly logged-in account await and receive the previous account's
// token, while a generation guard prevents pre-logout work from committing.
//
// The identity is (file, refresh token), not the refresh token alone. Right
// after web search copies the login, both files hold the SAME refresh token
// while being two independent credentials with two independent write targets —
// keyed on the token alone, a refresh of one would be handed the other's
// promise and only one of the two files would ever be updated.
const inFlightRefreshes = new Map<string, InFlightRefresh>()
let credentialGeneration = 0

async function invalidateAntigravityRefreshes(): Promise<void> {
  credentialGeneration++
  const stale = [...inFlightRefreshes.values()]
  for (const refresh of stale) refresh.controller.abort()
  await Promise.allSettled(stale.map(refresh => refresh.promise))
}

/**
 * Refresh one credential file's tokens and write them back to THAT file.
 *
 * `path` is the file the tokens were read from, and the refresh never lands
 * anywhere else. For web search's copy that is the load-bearing part: writing
 * a refresh into the login file instead would recreate, from inside a search,
 * the account login the user had just ended with `/logout`.
 */
async function refreshAndPersist(
  tokens: AntigravityTokens,
  fetchImpl: FetchLike,
  path: string = antigravityAuthFilePath(),
): Promise<AntigravityTokens> {
  const identityKey = `${path} ${tokens.refreshToken}`
  const existing = inFlightRefreshes.get(identityKey)
  if (existing?.generation === credentialGeneration) return existing.promise

  const generation = credentialGeneration
  const controller = new AbortController()
  let entry: InFlightRefresh
  const refresh = (async () => {
    const refreshed = await refreshAntigravityTokens(
      tokens,
      fetchImpl,
      controller.signal,
    )
    const current = await readAntigravityTokens(path)
    if (
      generation !== credentialGeneration ||
      current?.refreshToken !== tokens.refreshToken
    ) {
      throw new Error('Antigravity credentials changed during token refresh')
    }
    await saveAntigravityTokens(refreshed, path)
    if (generation !== credentialGeneration) {
      throw new Error('Antigravity credentials changed during token refresh')
    }
    return refreshed
  })()
  entry = {
    generation,
    controller,
    promise: refresh.finally(() => {
      if (inFlightRefreshes.get(identityKey) === entry) {
        inFlightRefreshes.delete(identityKey)
      }
    }),
  }
  inFlightRefreshes.set(identityKey, entry)
  return entry.promise
}

export function _resetAntigravityRefreshStateForTesting(): void {
  credentialGeneration++
  for (const refresh of inFlightRefreshes.values()) {
    refresh.controller.abort()
  }
  inFlightRefreshes.clear()
}

/**
 * Stored credentials with a live access token, refreshing ahead of expiry.
 *
 * Throws (rather than returning null) because the caller is a request path that
 * must surface *why* the call cannot be made — an opaque failure here reads as
 * a model outage.
 *
 * Everything it writes goes back to the file the login was read from — see
 * {@link AntigravityCredentialPlane}.
 */
async function resolveAntigravityAuth(
  plane: AntigravityCredentialPlane,
  fetchImpl: FetchLike,
): Promise<AntigravityAuth> {
  const found = await readPlaneTokens(plane)
  if (!found) {
    throw new Error(
      'Antigravity account is not logged in. Run /login and select Antigravity (Google OAuth).',
    )
  }
  let { tokens } = found
  const { path } = found
  if (tokens.expiresAt <= Date.now() + ANTIGRAVITY_REFRESH_SKEW_MS) {
    tokens = await refreshAndPersist(tokens, fetchImpl, path)
  }
  let projectId = tokens.projectId
  if (!projectId) {
    // Older credential files predate project persistence, and a token minted
    // before onboarding completed has none either. Recover silently.
    projectId = await discoverAntigravityProject({
      accessToken: tokens.accessToken,
      fetchImpl,
    })
    // Into the file this login came from, for the same reason the refresh is:
    // a search running off the copy must not write the login file back into
    // existence.
    await saveAntigravityTokens({ ...tokens, projectId }, path)
  }
  return { accessToken: tokens.accessToken, projectId }
}

export async function getValidAntigravityAuth(
  fetchImpl: FetchLike = fetch,
): Promise<AntigravityAuth> {
  return resolveAntigravityAuth('provider', fetchImpl)
}

/**
 * The same credential for WebSearch's `gemini` lane, which may also use the
 * copy of the login web search pinned for itself. See
 * {@link AntigravityCredentialPlane}.
 */
export async function getValidAntigravitySearchAuth(
  fetchImpl: FetchLike = fetch,
): Promise<AntigravityAuth> {
  return resolveAntigravityAuth('search', fetchImpl)
}

/**
 * Contract export (pinned): a valid access token, or null when the user is not
 * logged in or the refresh token has been revoked. Never throws — callers such
 * as the search-source picker use it as a capability probe.
 *
 * Reads the SEARCH plane, because that is the only thing that asks: the one
 * consumer is `gemini/oauthToken.ts`, the seam between this flow and the search
 * stack (the main loop goes through `getValidAntigravityAuth` instead). It has
 * to see the copy, or `/search-setting` would report the `gemini` row as
 * disconnected after a `/logout` while its lane was still searching happily off
 * the copied login.
 */
export async function getAntigravityAccessToken(
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  try {
    const found = await readPlaneTokens('search')
    if (!found) return null
    const { tokens, path } = found
    if (tokens.expiresAt > Date.now() + ANTIGRAVITY_REFRESH_SKEW_MS) {
      return tokens.accessToken
    }
    const refreshed = await refreshAndPersist(tokens, fetchImpl, path)
    return refreshed.accessToken
  } catch (error) {
    logForDebugging(
      `[Antigravity] Access token unavailable: ${String(error)}`,
      { level: 'error' },
    )
    return null
  }
}

/** Whether a credential file exists (no network, no refresh). */
export async function hasAntigravityCredentials(): Promise<boolean> {
  return (await readAntigravityTokens()) !== null
}

export async function removeAntigravityAuth(): Promise<void> {
  await invalidateAntigravityRefreshes()
  await removeAntigravityTokens()
}
