/**
 * The DeepSeek predicates, with no dependencies of their own.
 *
 * Split out of deepseekTuning.ts so callers on the context/effort paths can
 * identify a DeepSeek model without pulling in that module's provider and
 * main-loop-model lookups — importing it from session/context.ts closed a
 * runtime import cycle (`bun run check:cycles` is a strict two-way ratchet).
 *
 * deepseekTuning.ts re-exports everything here, so the "one gate for all
 * DeepSeek-specific behavior" rule in CLAUDE.md still holds: this is the same
 * gate, just the half that needs nothing to answer.
 */

/**
 * Host of the official DeepSeek endpoint. Matched as a secondary signal so a
 * deployment that renames the model (`default`, `coder`, a proxy alias) still
 * gets the right request shape — pointing at api.deepseek.com *is* requesting
 * a DeepSeek model.
 */
export const DEEPSEEK_API_HOST = 'api.deepseek.com'

/**
 * DeepSeek V4's advertised context window.
 *
 * Without this the third-party fallback of 200k applies and a coding session
 * auto-compacts roughly five times earlier than it needs to. Sent nowhere; it
 * drives auto-compact thresholds, the blocking limit, `ctx:%` and `/context`.
 *
 * `CLAUDE_CODE_DISABLE_1M_CONTEXT` and `CLAUDE_CODE_MAX_CONTEXT_TOKENS` remain
 * the way out for a deployment serving something smaller (an older V3-era
 * checkpoint behind a DeepSeek-shaped proxy, say).
 */
export const DEEPSEEK_CONTEXT_WINDOW = 1_000_000

/**
 * Whether a model id belongs to the DeepSeek family. Covers the hosted ids
 * (`deepseek-chat`, `deepseek-reasoner`, `deepseek-v4-pro`, `deepseek-v4-flash`)
 * and the HuggingFace-style ids self-hosted deployments use
 * (`deepseek-ai/DeepSeek-V4-Pro`).
 */
export function isDeepSeekFamilyModel(model: string): boolean {
  return model.toLowerCase().includes('deepseek')
}

/** Whether a base URL points at the official DeepSeek API. */
export function isDeepSeekBaseURL(baseURL: string | undefined): boolean {
  if (!baseURL) return false
  try {
    return new URL(baseURL).hostname.toLowerCase().endsWith(DEEPSEEK_API_HOST)
  } catch {
    // Not a parseable URL — fall back to a substring check rather than
    // throwing inside request construction.
    return baseURL.toLowerCase().includes(DEEPSEEK_API_HOST)
  }
}

/**
 * The context window for a model identified as DeepSeek *by name*, or
 * undefined otherwise.
 *
 * Name-only on purpose. The base-URL signal the request path also uses would
 * be wrong here: getContextWindowForModel runs for every provider, so a
 * leftover OPENAI_BASE_URL pointing at DeepSeek would hand a 1M window to an
 * Anthropic session. Excluding that arm means a gateway that renames the model
 * beyond recognition falls back to the 200k default —
 * CLAUDE_CODE_MAX_CONTEXT_TOKENS is the documented correction for exactly that.
 */
export function getDeepSeekContextWindow(model: string): number | undefined {
  return isDeepSeekFamilyModel(model) ? DEEPSEEK_CONTEXT_WINDOW : undefined
}
