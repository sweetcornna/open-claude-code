import { existsSync, readFileSync } from 'fs'
import { mkdir, readFile, unlink } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { occConfigDir, occConfigPath } from 'src/config/paths.js'
import { NonRetryableError } from 'src/services/api/retryClassification.js'
import {
  readSearchOAuthCopySync,
  searchOAuthCopyPath,
} from 'src/services/search/oauthCopies.js'
import { sleep } from 'src/utils/process/sleep.js'
import { writePrivateFileAtomic } from 'src/utils/secureStorage/atomicWrite.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'

const ISSUER = 'https://auth.openai.com'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_FILE = 'openai-chatgpt-auth.json'
const REFRESH_SKEW_MS = 5 * 60 * 1000
// codex-rs refreshes on age too (TOKEN_REFRESH_INTERVAL = 8 days), not just
// on access-token expiry — id_token claims (plan, account) go stale otherwise.
const MAX_TOKEN_AGE_MS = 8 * 24 * 60 * 60 * 1000

export type ChatGPTDeviceCode = {
  verificationUrl: string
  userCode: string
  deviceAuthId: string
  intervalSeconds: number
}

export type ChatGPTAuthTokens = {
  idToken: string
  accessToken: string
  refreshToken: string
  accountId?: string
  lastRefresh?: string
}

export type ChatGPTAuth = {
  accessToken: string
  accountId?: string
}

type StoredAuthFile = {
  auth_mode?: string
  tokens?: {
    id_token?: string
    access_token?: string
    refresh_token?: string
    account_id?: string
  }
  last_refresh?: string
}

/**
 * occ's own ChatGPT credential file — the one `/login` writes and `/logout`
 * deletes.
 *
 * Exported so `autoPin.ts` can copy it into web search's own store; nothing
 * else outside this module should be reading or writing it directly.
 */
export function chatgptAuthFilePath(): string {
  return occConfigPath(AUTH_FILE)
}

function authFilePath(): string {
  return chatgptAuthFilePath()
}

function codexAuthFilePath(): string {
  // homedir(), not process.env.HOME: Windows does not set HOME, so the old
  // `?? ''` fallback produced the *relative* path `.codex/auth.json` and read
  // and wrote credentials inside whatever project directory occ happened to be
  // launched from.
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseJSONRecord(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split('.')
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      '=',
    )
    const json = Buffer.from(padded, 'base64').toString('utf8')
    return parseJSONRecord(json)
  } catch {
    return null
  }
}

function getOpenAIAuthClaims(token: string): Record<string, unknown> {
  const payload = decodeJwtPayload(token)
  const nested = payload?.['https://api.openai.com/auth']
  if (nested && typeof nested === 'object') {
    return nested as Record<string, unknown>
  }
  return payload ?? {}
}

function getTokenExpiryMs(token: string): number | null {
  const payload = decodeJwtPayload(token)
  const exp = payload?.exp
  return typeof exp === 'number' ? exp * 1000 : null
}

function extractAccountId(tokens: {
  idToken?: string
  accessToken?: string
  accountId?: string
}): string | undefined {
  if (tokens.accountId) return tokens.accountId
  for (const token of [tokens.idToken, tokens.accessToken]) {
    if (!token) continue
    const claims = getOpenAIAuthClaims(token)
    const accountId =
      asString(claims.chatgpt_account_id) ??
      asString(claims.chatgpt_account_user_id) ??
      asString(claims.account_id)
    if (accountId) return accountId
  }
  return undefined
}

async function readStoredAuth(path: string): Promise<ChatGPTAuthTokens | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as StoredAuthFile
    const tokens = parsed.tokens
    const idToken = tokens?.id_token
    const accessToken = tokens?.access_token
    const refreshToken = tokens?.refresh_token
    if (!idToken || !accessToken || !refreshToken) return null
    return {
      idToken,
      accessToken,
      refreshToken,
      accountId: extractAccountId({
        idToken,
        accessToken,
        accountId: tokens.account_id,
      }),
      lastRefresh: parsed.last_refresh,
    }
  } catch {
    return null
  }
}

async function saveStoredAuth(
  tokens: ChatGPTAuthTokens,
  path: string = authFilePath(),
): Promise<void> {
  await mkdir(occConfigDir(), { recursive: true })
  const body: StoredAuthFile = {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: extractAccountId(tokens),
    },
    last_refresh: new Date().toISOString(),
  }
  await writePrivateFileAtomic(path, `${JSON.stringify(body, null, 2)}\n`)
}

async function postJSON<T>(
  url: string,
  body: Record<string, string>,
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`ChatGPT auth request failed (${res.status})`)
  }
  return (await res.json()) as T
}

async function postForm<T>(url: string, body: URLSearchParams): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(
      `ChatGPT token request failed (${res.status})${text ? `: ${text}` : ''}`,
    )
  }
  return (await res.json()) as T
}

export async function requestChatGPTDeviceCode(): Promise<ChatGPTDeviceCode> {
  type UserCodeResponse = {
    device_auth_id: string
    user_code?: string
    usercode?: string
    interval?: string | number
  }
  const data = await postJSON<UserCodeResponse>(
    `${ISSUER}/api/accounts/deviceauth/usercode`,
    { client_id: CLIENT_ID },
  )
  const userCode = data.user_code ?? data.usercode
  if (!data.device_auth_id || !userCode) {
    throw new Error('ChatGPT auth response did not include a device code')
  }
  const interval =
    typeof data.interval === 'number'
      ? data.interval
      : Number.parseInt(data.interval ?? '5', 10)
  return {
    verificationUrl: `${ISSUER}/codex/device`,
    userCode,
    deviceAuthId: data.device_auth_id,
    intervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : 5,
  }
}

async function pollForAuthorizationCode(
  deviceCode: ChatGPTDeviceCode,
  signal?: AbortSignal,
): Promise<{ authorizationCode: string; codeVerifier: string }> {
  type TokenPollResponse = {
    authorization_code: string
    code_verifier: string
  }
  const started = Date.now()
  while (Date.now() - started < 15 * 60 * 1000) {
    if (signal?.aborted) throw new Error('ChatGPT login cancelled')
    const res = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: deviceCode.deviceAuthId,
        user_code: deviceCode.userCode,
      }),
      signal,
    })
    if (res.ok) {
      const data = (await res.json()) as TokenPollResponse
      return {
        authorizationCode: data.authorization_code,
        codeVerifier: data.code_verifier,
      }
    }
    if (res.status !== 403 && res.status !== 404) {
      throw new Error(`ChatGPT device auth failed (${res.status})`)
    }
    await sleep(deviceCode.intervalSeconds * 1000, signal, {
      abortError: () => new Error('ChatGPT login cancelled'),
    })
  }
  throw new Error('ChatGPT device auth timed out after 15 minutes')
}

async function exchangeAuthorizationCode(params: {
  authorizationCode: string
  codeVerifier: string
}): Promise<ChatGPTAuthTokens> {
  type TokenResponse = {
    id_token: string
    access_token: string
    refresh_token: string
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.authorizationCode,
    redirect_uri: `${ISSUER}/deviceauth/callback`,
    client_id: CLIENT_ID,
    code_verifier: params.codeVerifier,
  })
  const data = await postForm<TokenResponse>(`${ISSUER}/oauth/token`, body)
  return {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accountId: extractAccountId({
      idToken: data.id_token,
      accessToken: data.access_token,
    }),
  }
}

async function refreshTokens(
  tokens: ChatGPTAuthTokens,
): Promise<ChatGPTAuthTokens> {
  // All three fields are optional in the refresh response (codex-rs
  // token_data.rs) — write back selectively, keeping the previous value for
  // anything omitted.
  type TokenResponse = {
    id_token?: string
    access_token?: string
    refresh_token?: string
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: CLIENT_ID,
    scope:
      'openid profile email offline_access api.connectors.read api.connectors.invoke',
  })
  const data = await postForm<TokenResponse>(`${ISSUER}/oauth/token`, body)
  const idToken = data.id_token ?? tokens.idToken
  const accessToken = data.access_token ?? tokens.accessToken
  return {
    idToken,
    accessToken,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    accountId: extractAccountId({
      idToken,
      accessToken,
      accountId: tokens.accountId,
    }),
  }
}

export async function completeChatGPTDeviceLogin(
  deviceCode: ChatGPTDeviceCode,
  signal?: AbortSignal,
): Promise<ChatGPTAuthTokens> {
  const code = await pollForAuthorizationCode(deviceCode, signal)
  const tokens = await exchangeAuthorizationCode(code)
  await saveStoredAuth(tokens)
  return tokens
}

export function isChatGPTAuthEnabled(): boolean {
  return process.env.OPENAI_AUTH_MODE === 'chatgpt'
}

/**
 * One credential file a plane may authenticate from, and where a refresh of it
 * is written back.
 *
 * `persistTo` absent means "read only": the tokens may be used, but a refresh
 * of them lands nowhere. That is not laziness, it is the only honest answer for
 * a file this CLI does not own — see the two lists below.
 */
type AuthSource = { path: string; persistTo?: string }

/**
 * Where the MAIN LOOP authenticates from. Unchanged, and it must stay that way:
 * occ's own file, then the Codex CLI's, with a refresh of either written into
 * occ's own.
 *
 * Web search's copy is deliberately absent. A `/logout` deletes the file this
 * list starts with; if the provider plane could then fall through to the search
 * copy, logging out would not log anything out.
 */
function providerAuthSources(): AuthSource[] {
  const own = authFilePath()
  return [
    { path: own, persistTo: own },
    { path: codexAuthFilePath(), persistTo: own },
  ]
}

/**
 * Where WEB SEARCH's `codex` lane authenticates from.
 *
 * Order, and why each position is where it is:
 *
 *   1. occ's own login file. Freshest by construction while a login exists —
 *      the provider plane refreshes it on every request — so the copy must
 *      never outrank it.
 *   2. The search copy. Reached once the login file is gone, which is exactly
 *      what `/logout` does and exactly what this whole mechanism is for. A
 *      refresh here writes back to the COPY and never to the login file:
 *      recreating that file would resurrect the provider-plane login the user
 *      just ended, from inside a web search.
 *   3. `~/.codex/auth.json`, the official Codex CLI's own credential file.
 *      LAST, and read-only. Last because the copy is a deliberate, recorded
 *      decision about which account search uses, while this file is an incidental
 *      borrow from another tool that happens to be installed — letting it
 *      outrank the pin would put the panel's account display and the lane's
 *      request on different accounts. Read-only because it belongs to another
 *      CLI (the isolation invariant), and because writing a refresh of it into
 *      occ's own login file — which is what the provider plane does — would
 *      recreate that file after a logout.
 */
function searchAuthSources(): AuthSource[] {
  const own = authFilePath()
  const copy = searchOAuthCopyPath('codex')
  return [
    { path: own, persistTo: own },
    { path: copy, persistTo: copy },
    { path: codexAuthFilePath() },
  ]
}

/**
 * Sync probe for the credential files — the async version's rules, without the
 * await.
 *
 * Used where an async read is not an option: the WebSearch source resolver runs
 * inside a synchronous factory.
 *
 * IT COUNTS THE SEARCH COPY, and the three probes below do too. That is a
 * statement about their callers, not a loosening: every one of them is on the
 * web-search plane (`sourceCredentials.ts`, `codexAdapter`'s route choice, and
 * `/search-setting`'s row), and on that plane a copied login is a credential
 * the lane really will authenticate with. The provider plane never asks these —
 * it asks `getValidChatGPTAuth()`, which is copy-blind by construction
 * (`providerAuthSources`), so `/logout` still logs the account out.
 *
 * It reads the file rather than just stat-ing it, because `~/.codex/auth.json`
 * has two shapes. The official Codex CLI writes `{"OPENAI_API_KEY": "..."}`
 * there when you authenticate with a key instead of a ChatGPT account — a file
 * that exists, carries a real credential, and is NOT a ChatGPT login. Treating
 * its presence as one made every caller take the OAuth route and fail with
 * "ChatGPT account is not logged in", while a perfectly good API key sat
 * unused. The three OAuth token fields are the only honest signal.
 */
export function hasStoredChatGPTAuthSync(): boolean {
  const fromDisk = [authFilePath(), codexAuthFilePath()].map(path =>
    existsSync(path) ? readFileTextOrUndefined(path) : undefined,
  )
  return [...fromDisk, readSearchOAuthCopySync('codex')].some(isChatGPTAuthText)
}

function readFileTextOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function isChatGPTAuthText(text: string | undefined): boolean {
  if (text === undefined) return false
  try {
    const tokens = (JSON.parse(text) as StoredAuthFile).tokens
    return Boolean(
      tokens?.id_token && tokens.access_token && tokens.refresh_token,
    )
  } catch {
    return false
  }
}

/**
 * Whether ChatGPT credentials exist on disk, regardless of whether the main
 * loop is configured to use them (`OPENAI_AUTH_MODE`).
 *
 * WebSearch's `codex` source needs exactly this distinction: a user logged in
 * to ChatGPT gets OpenAI's search layer as an extra source even when the main
 * loop is talking to some other provider. Reads only — no refresh, no
 * network — so the panel and the source resolver can call it freely.
 */
export async function hasStoredChatGPTAuth(): Promise<boolean> {
  for (const source of searchAuthSources()) {
    if (await readStoredAuth(source.path)) return true
  }
  return false
}

/**
 * Account id of the stored ChatGPT credentials, for status display.
 *
 * Read in `searchAuthSources()` order, which is the order the lane itself picks
 * a credential in — so after a `/logout` this names the account inside the
 * copied login, which is the one the next search will authenticate as. A
 * display order that disagreed with the request order is the mislabelling the
 * `gemini` row already had to be fixed for.
 */
export async function getStoredChatGPTAccountId(): Promise<string | undefined> {
  for (const source of searchAuthSources()) {
    const tokens = await readStoredAuth(source.path)
    if (tokens) return tokens.accountId ?? extractAccountId(tokens)
  }
  return undefined
}

export async function removeChatGPTAuth(): Promise<void> {
  await unlink(authFilePath()).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  })
}

async function resolveChatGPTAuth(sources: AuthSource[]): Promise<ChatGPTAuth> {
  let tokens: ChatGPTAuthTokens | null = null
  let persistTo: string | undefined
  for (const source of sources) {
    tokens = await readStoredAuth(source.path)
    if (!tokens) continue
    persistTo = source.persistTo
    if (source.path === codexAuthFilePath()) {
      logForDebugging('[OpenAI] Using ChatGPT auth from Codex auth.json')
    }
    break
  }
  if (!tokens) {
    // No credentials on disk: nothing was sent, and re-reading an absent file
    // ten times only delays the /login prompt. See NonRetryableError.
    throw new NonRetryableError(
      'ChatGPT account is not logged in. Run /login and select ChatGPT account with subscription.',
      { category: 'authentication_failed' },
    )
  }
  const expiresAt = getTokenExpiryMs(tokens.accessToken)
  const expiringSoon =
    expiresAt !== null && expiresAt <= Date.now() + REFRESH_SKEW_MS
  const lastRefreshMs = tokens.lastRefresh
    ? Date.parse(tokens.lastRefresh)
    : Number.NaN
  const stale =
    !Number.isFinite(lastRefreshMs) ||
    Date.now() - lastRefreshMs > MAX_TOKEN_AGE_MS
  if (expiringSoon || stale) {
    try {
      tokens = await refreshTokens(tokens)
      // Back into the file the tokens came from, or nowhere. Nowhere is the
      // right answer for `~/.codex/auth.json` on the search plane: writing the
      // refresh into occ's own login file — which is what the provider plane
      // does with it — would put a logged-out account back on disk.
      if (persistTo) await saveStoredAuth(tokens, persistTo)
    } catch (error) {
      // A stale-only refresh is opportunistic: the access token is still
      // valid, so keep serving it rather than failing the request.
      if (expiringSoon) throw error
      logForDebugging(
        `[OpenAI] Opportunistic ChatGPT token refresh failed: ${String(error)}`,
      )
    }
  }
  return {
    accessToken: tokens.accessToken,
    accountId: tokens.accountId ?? extractAccountId(tokens),
  }
}

/**
 * The main loop's ChatGPT credential: occ's own login file, or the Codex CLI's.
 *
 * Never the web-search copy. That is the whole reason the copy exists as a
 * separate file rather than as a longer fallback chain here — see
 * `providerAuthSources`.
 */
export async function getValidChatGPTAuth(): Promise<ChatGPTAuth> {
  return resolveChatGPTAuth(providerAuthSources())
}

/**
 * WebSearch's ChatGPT credential: the login file, then the copy web search
 * pinned, then the Codex CLI's file (read-only). See `searchAuthSources` for
 * why that order and why a refresh lands where it does.
 */
export async function getValidChatGPTAuthForSearch(): Promise<ChatGPTAuth> {
  return resolveChatGPTAuth(searchAuthSources())
}
