/**
 * DeepSeek predicates and constants with ZERO imports.
 *
 * Split out of deepseekFamily.ts because that module imports getAPIProvider
 * (resolveModelForDeepSeekGate needs it to resolve an alias before testing the
 * family). Anything reachable from providers.ts therefore cannot import
 * deepseekFamily.ts without closing a cycle — which is exactly what happened
 * when getAPIProvider() grew an arm for the Anthropic-wire routing.
 *
 * Keep this file dependency-free. deepseekFamily.ts re-exports everything here
 * so existing importers are unaffected.
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
