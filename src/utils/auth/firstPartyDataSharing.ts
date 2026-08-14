/**
 * "May this session send data to Anthropic on occ's own behalf?"
 *
 * The DeepSeek and OpenCode wires mirror their own credential into
 * `ANTHROPIC_API_KEY` so the first-party client can reach an
 * Anthropic-compatible endpoint that is not Anthropic's (see
 * `isThirdPartyMirroredApiKey` in auth.ts). Requests occ addresses to
 * api.anthropic.com itself must not carry that credential.
 *
 * Background sinks (telemetry, feature gates, post-login bookkeeping) handle
 * this by calling `getFirstPartyTelemetryAuthHeaders()` and failing closed —
 * no auth header, request skipped, nothing for the user to see.
 *
 * This module is for the other half: the handful of features a user
 * *deliberately* invokes that only make sense against an Anthropic account
 * (`/bug`, transcript sharing). Silently dropping those would look like a bug;
 * they need to say why. The predicate is derived from the same two helpers the
 * background sinks use, so it cannot drift from them:
 *
 *   getAuthHeaders() succeeds        -> occ does have a credential
 *   first-party variant refuses it   -> ...but it belongs to another vendor
 *
 * Deliberately narrower than "is this a third-party session". Bedrock, Vertex,
 * Foundry and plain gateway users authenticate through their own chains and
 * still have a real Anthropic relationship to file a bug report against; only
 * a mirrored credential is positively known to belong to someone else.
 */

import {
  getAuthHeaders,
  getFirstPartyTelemetryAuthHeaders,
} from '../network/http.js'

/**
 * Shown to the user when a first-party-only feature is declined. Kept in one
 * place so `/bug` and transcript sharing say the same thing.
 */
export const MIRRORED_CREDENTIAL_NOTICE =
  'This session authenticates with a third-party provider credential (DeepSeek/OpenCode), not an Anthropic account, so there is nothing to submit to. Run /login to sign in to Anthropic first.'

/**
 * True when the session holds a credential that is usable for inference but
 * belongs to a vendor other than Anthropic. Callers that address
 * api.anthropic.com on occ's own behalf must not proceed.
 */
export function isBlockedByMirroredCredential(): boolean {
  try {
    // No credential at all is a different condition (each caller already has
    // its own "no auth" branch), so require the ordinary path to succeed first.
    if (getAuthHeaders().error !== undefined) {
      return false
    }
    return getFirstPartyTelemetryAuthHeaders().error !== undefined
  } catch {
    // getAnthropicApiKeyWithSource throws rather than returning when it cannot
    // resolve a credential under CI/NODE_ENV=test, and apiKeyHelper can fail
    // for its own reasons. Answer "not positively known to be someone else's"
    // and let the caller's existing auth-error branch handle it — the sinks
    // this guards all re-resolve auth themselves and fail closed there.
    return false
  }
}
