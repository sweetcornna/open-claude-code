/**
 * The requests step 1 makes, and the one verdict that can stop the flow there.
 *
 * Out of the component for the reason savePlan.ts and activateSession.ts give:
 * what happens here is a DECISION — does this credential get to configure a
 * session at all? — and an Ink effect cannot be driven from a test, so left
 * inside the effect it would never be exercised at all.
 *
 * Two requests, in this order, and the order is load-bearing: `GET /models`
 * first, because its answer is what a credential check names a probe model
 * from; then the spec's optional check. A spec that declares no check has no
 * second half — same request, same arguments, same result as before this file
 * existed — and that is the property every other provider depends on.
 */

import type { CatalogModel } from 'src/services/modelCatalog/types.js'
import type { ProviderSetupSpec } from './specs.js'

/**
 * What step 1 learned: either the material step 2 is built from, or a refusal
 * that must not be allowed to become a configured session.
 *
 * Deliberately not an exception. A refusal is an ordinary answer to the
 * question step 1 asks, and the caller has to render it rather than log it.
 */
type EndpointRequestOutcome =
  | { proceed: true; models: CatalogModel[] | null; failureReason: string }
  | { proceed: false; message: string }

export async function runEndpointRequests({
  spec,
  baseURL,
  apiKey,
  signal,
}: {
  spec: ProviderSetupSpec
  /** Endpoint, already resolved to `spec.defaultBaseUrl` when left empty. */
  baseURL: string
  apiKey: string
  signal?: AbortSignal
}): Promise<EndpointRequestOutcome> {
  let failureReason = 'the request failed'
  let models: CatalogModel[] | null = null

  if (!apiKey && !spec.apiKeyRequired) {
    // Keyless is legal here — see `apiKeyRequired`: a local gateway behind an
    // Anthropic- or OpenAI-compatible shim was configurable before this wizard
    // existed. There is simply nothing to authorize a catalog request with, so
    // it is not attempted and step 2 falls back to occ's table or to typing.
    failureReason =
      'no API key was provided, so the model list could not be requested'
  } else {
    models = await spec.fetchModels({
      baseURL,
      apiKey,
      signal,
      onError: reason => {
        failureReason = reason
      },
    })
  }

  // Only OpenCode declares one of these. For every other provider the optional
  // call is absent and this function is the old effect body verbatim.
  const verdict = await spec.verifyCredential?.({
    baseURL,
    apiKey,
    models,
    signal,
  })
  if (verdict && !verdict.ok) {
    return { proceed: false, message: verdict.message }
  }

  return { proceed: true, models, failureReason }
}
