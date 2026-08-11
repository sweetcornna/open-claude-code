/**
 * OpenCode credential policy — "give me a token I can send right now".
 *
 * Two credential kinds, mirroring the two auth methods sst/opencode registers
 * for this provider (`packages/core/src/plugin/provider/opencode.ts`):
 *
 *   oauth — a Console subscription, obtained through the device flow and
 *           refreshed here as it ages.
 *   key   — a Zen or service-account API key from OPENCODE_API_KEY.
 *
 * They are interchangeable downstream, which is not an occ simplification: the
 * opencode runtime resolves both to the same bearer value
 * (`session/runner/model.ts` — `credential.type === "key" ? key : access`), so
 * the inference plane genuinely cannot tell them apart.
 *
 * Precedence is key-over-OAuth. An explicitly exported OPENCODE_API_KEY is a
 * deliberate, per-invocation act (CI, a service account, a second org); a
 * stored login is ambient. Letting the ambient one win would make the env var
 * silently inert, which is the failure mode CLAUDE.md records for
 * OPENAI_MODEL.
 */

import { OPENCODE_API_KEY_ENV, TOKEN_REFRESH_MARGIN_MS } from './constants.js'
import { refreshTokens } from './deviceFlow.js'
import {
  readOpencodeTokens,
  removeOpencodeTokens,
  saveOpencodeTokens,
  type OpencodeTokens,
} from './store.js'

export type OpencodeCredential = {
  /** Value for the `Authorization: Bearer` header. */
  token: string
  kind: 'oauth' | 'key'
  /** Sent as `x-org-id` when the account resolved one. */
  orgId?: string
  /** Console host, for catalog requests. OAuth credentials only. */
  server?: string
}

function envApiKey(): string | undefined {
  const value = process.env[OPENCODE_API_KEY_ENV]?.trim()
  return value ? value : undefined
}

function isExpiring(tokens: OpencodeTokens): boolean {
  return tokens.expiresAt - TOKEN_REFRESH_MARGIN_MS <= Date.now()
}

type InFlight = {
  promise: Promise<OpencodeTokens>
  generation: number
}

let inFlight: InFlight | undefined
let credentialGeneration = 0

/**
 * Refresh once per lapse, however many callers notice at the same moment.
 *
 * Concurrent model calls all observe the same expired token; without this each
 * would spend the refresh token separately and the last write would win, so
 * every earlier holder's freshly-minted pair becomes garbage. Keyed on the
 * generation counter so a logout mid-refresh cannot resurrect the file.
 */
async function refreshAndPersist(
  tokens: OpencodeTokens,
): Promise<OpencodeTokens> {
  if (inFlight && inFlight.generation === credentialGeneration) {
    return inFlight.promise
  }
  const generation = credentialGeneration
  const promise = (async () => {
    const refreshed = await refreshTokens(tokens.refreshToken, tokens.server)
    const next: OpencodeTokens = {
      ...tokens,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
    }
    // A logout that landed while this was in flight must not be undone.
    if (generation === credentialGeneration) {
      await saveOpencodeTokens(next)
    }
    return next
  })().finally(() => {
    if (inFlight?.promise === promise) inFlight = undefined
  })
  inFlight = { promise, generation }
  return promise
}

/**
 * A credential ready to send, refreshing the OAuth pair when it is near expiry.
 *
 * Returns null rather than throwing when nothing is configured — callers
 * distinguish "not logged in" (offer login) from "refresh failed" (surface the
 * error), and collapsing the two turns a first run into an error toast.
 */
export async function getOpencodeCredential(): Promise<OpencodeCredential | null> {
  const key = envApiKey()
  if (key) return { token: key, kind: 'key' }

  const tokens = await readOpencodeTokens()
  if (!tokens) return null

  const fresh = isExpiring(tokens) ? await refreshAndPersist(tokens) : tokens
  return {
    token: fresh.accessToken,
    kind: 'oauth',
    server: fresh.server,
    ...(fresh.orgId ? { orgId: fresh.orgId } : {}),
  }
}

/**
 * Headers every OpenCode request carries.
 *
 * `x-org-id` scopes the request to one organization; omitting it on a
 * multi-org account bills whichever org the console defaults to.
 */
export function opencodeAuthHeaders(
  credential: OpencodeCredential,
): Record<string, string> {
  return {
    authorization: `Bearer ${credential.token}`,
    ...(credential.orgId ? { 'x-org-id': credential.orgId } : {}),
  }
}

export async function removeOpencodeAuth(): Promise<void> {
  credentialGeneration++
  inFlight = undefined
  await removeOpencodeTokens()
}

export function _resetOpencodeRefreshStateForTesting(): void {
  credentialGeneration++
  inFlight = undefined
}
