/**
 * The seam between the OpenCode credential layer and the request path.
 *
 * Two things have to happen before an OpenCode request can go out, and they
 * disagree about time: reading the credential is asynchronous (a 0600 file, and
 * an OAuth pair that has to be refreshed roughly hourly), while the mirror that
 * turns OPENCODE_* into the lane keys the clients read (ANTHROPIC_* or OPENAI_*)
 * is a synchronous env rewrite that runs from synchronous places — managedEnv's
 * two apply functions, getOpenAIClient().
 *
 * So the token is cached in opencodeWire.ts (in memory, never persisted) and
 * this module is the only thing that puts it there. `applyOpencodeWire()` on
 * its own is the synchronous read of that cache and is safe to call anywhere;
 * ensureOpencodeCredential() is the asynchronous refresh, and it is called from
 * the two places that already have an await to spend: getAnthropicClient(),
 * which is async and builds a fresh client per call, and the OpenAI client's
 * fetch wrapper, which is per-request by construction.
 *
 * Doing it per request rather than once at startup is not caution, it is the
 * only thing that works: OpenCode access tokens expire in about an hour, and
 * the OpenAI SDK client is cached for the life of the process. A token captured
 * at construction would be a 401 by the second hour of a session.
 *
 * `./auth/opencode/oauth.js` directly rather than the barrel — the barrel
 * re-exports the device flow, which no request path should carry.
 */

import {
  getOpencodeCredential,
  opencodeAuthHeaders,
} from 'src/services/auth/opencode/oauth.js'
import {
  applyOpencodeWire,
  isOpencodeSessionActive,
  setOpencodeRuntimeCredential,
} from 'src/utils/model/opencodeWire.js'

/**
 * The token most recently pushed into the wire module.
 *
 * Only here so the mirror is re-applied when the value actually changes. The
 * mirror deletes and rewrites env keys, and running that on every request would
 * churn process.env — which is handed to every Bash tool call — for nothing.
 */
let appliedToken: string | undefined

/**
 * Refresh the in-memory credential, re-apply the mirror if it moved, and hand
 * back the headers a request should carry.
 *
 * Returns undefined when this is not an OpenCode session or when nothing is
 * configured. A failure to read or refresh also returns undefined rather than
 * throwing: the request is already being built, and a rejected promise here
 * would surface as a client-construction crash with no retry ladder behind it
 * instead of the 401 the server would have sent.
 */
export async function ensureOpencodeCredential(): Promise<
  Record<string, string> | undefined
> {
  if (!isOpencodeSessionActive()) {
    if (appliedToken !== undefined) {
      appliedToken = undefined
      setOpencodeRuntimeCredential(undefined)
      applyOpencodeWire()
    }
    return undefined
  }
  try {
    const credential = await getOpencodeCredential()
    if (!credential) {
      if (appliedToken !== undefined) {
        appliedToken = undefined
        setOpencodeRuntimeCredential(undefined)
        applyOpencodeWire()
      }
      return undefined
    }
    if (credential.token !== appliedToken) {
      appliedToken = credential.token
      setOpencodeRuntimeCredential(credential.token)
      applyOpencodeWire()
    }
    return opencodeAuthHeaders(credential)
  } catch {
    return undefined
  }
}

/** Drop the cached token — for logout, and for tests that switch sessions. */
export function resetOpencodeCredentialCache(): void {
  appliedToken = undefined
  setOpencodeRuntimeCredential(undefined)
  applyOpencodeWire()
}
