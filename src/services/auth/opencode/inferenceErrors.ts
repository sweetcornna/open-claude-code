/**
 * The one OpenCode inference failure occ has to explain itself.
 *
 * `managed_inference_model_disabled` is a 403 an organization gets for a model
 * its plan does not include — and the account's own `/api/config` still lists
 * that model with `status: "active"` and puts it in `whitelist`. Measured on the
 * live console (2026-08-11): `claude-haiku-4-5` answers
 *
 *   403 {"error":{"type":"managed_inference_model_disabled",
 *                 "message":"Model is disabled for this organization"}}
 *
 * while `big-pickle` on the same account and the same endpoint answers 200. So
 * per-org availability is NOT knowable ahead of the request, which is exactly
 * why this needs a sentence rather than a validation rule: occ cannot filter the
 * picker, and the raw error reads as a broken provider.
 *
 * It is also not an auth failure, and the 403 makes it look like one — the HTTP
 * status alone classifies as `authentication_failed`, which sends the user to
 * `/login` to fix a credential that is working perfectly. `retryClassification`
 * reads the `MODEL_DISABLED` signal off the body's `type` first, so the class
 * lands on `invalid_request` instead; this module is the message half.
 *
 * Dependency-free on purpose: the request path imports it, and it must not drag
 * the credential layer (a config dir, a 0600 file) into a hot catch block.
 */

/** Error `type` the console stamps on a model the org may not use. */
export const OPENCODE_MODEL_DISABLED_TYPE = 'managed_inference_model_disabled'

/** Depth cap: error graphs nest (`error.error.cause`), user data does not. */
const MAX_DEPTH = 5

function mentionsMarker(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return false
  if (typeof value === 'string')
    return value.includes(OPENCODE_MODEL_DISABLED_TYPE)
  if (Array.isArray(value)) {
    return value.some(item => mentionsMarker(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(item =>
      mentionsMarker(item, depth + 1),
    )
  }
  return false
}

/**
 * Whether a failure is the console refusing a model rather than a credential.
 *
 * Matched on the marker appearing anywhere in the error graph, not on a
 * particular field: the same body reaches occ as an SDK error object on the
 * chat lane and as interpolated text once an adapter has stringified it, and a
 * rule that only reads `error.type` sees the first and misses the second.
 */
export function isOpencodeModelDisabledError(error: unknown): boolean {
  if (typeof error === 'string') return mentionsMarker(error, 0)
  if (error instanceof Error && mentionsMarker(error.message, 0)) return true
  return mentionsMarker(error, 0)
}

/**
 * What the user is told instead of the raw 403.
 *
 * Names the three things the service's own sentence leaves out: that the
 * credential is fine, that the model list said otherwise and could not have
 * known better, and what to do next. Returns undefined for everything else, so
 * the caller falls back to the normal diagnostic.
 */
export function describeOpencodeModelDisabled(
  error: unknown,
  model?: string,
): string | undefined {
  if (!isOpencodeModelDisabledError(error)) return undefined
  const named = model?.trim() ? `"${model.trim()}"` : 'that model'
  return (
    `OpenCode: this organization is not entitled to ${named}. ` +
    'Your sign-in is fine — the console refused the model, not the credential. ' +
    'Its own model list reports every id as active, so occ cannot tell which ' +
    'ones are enabled until a request is made. Pick another model with /model, ' +
    'or enable this one for the organization in the OpenCode console.'
  )
}
