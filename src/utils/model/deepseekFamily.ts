/**
 * The DeepSeek predicates for callers that only have a model name.
 *
 * Split out of deepseekTuning.ts so the context/effort paths can identify a
 * DeepSeek model without pulling in that module's main-loop-model lookup —
 * importing it from session/context.ts closed a runtime import cycle
 * (`bun run check:cycles` is a strict two-way ratchet).
 *
 * deepseekTuning.ts re-exports everything here, so the "one gate for all
 * DeepSeek-specific behavior" rule in CLAUDE.md still holds.
 */

import { resolveOpenAIModel } from '@ant/model-provider'
import { getAPIProvider } from './providers.js'

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
 * The concrete model a request will actually name.
 *
 * The model string these callers hold is usually a family ALIAS — a default
 * session's main-loop model is `sonnet`, and `deepseek-v4-pro` only appears
 * after OPENAI_DEFAULT_SONNET_MODEL is applied inside the adapter. Checking the
 * alias against the DeepSeek predicate therefore always said "no" for exactly
 * the sessions that needed it, which is why the tuning appeared to do nothing
 * until the user picked a concrete id by hand.
 *
 * CLAUDE.md states this rule for the GPT gate too: resolve first, then test.
 * Gated on the provider because resolveOpenAIModel reads OPENAI_DEFAULT_*
 * straight from env — a leftover key must not redirect an Anthropic session.
 */
export function resolveModelForDeepSeekGate(model: string): string {
  return getAPIProvider() === 'openai' ? resolveOpenAIModel(model) : model
}

/** isDeepSeekFamilyModel, but after alias resolution. */
export function isDeepSeekModelOrAlias(model: string): boolean {
  return isDeepSeekFamilyModel(resolveModelForDeepSeekGate(model))
}

/**
 * The context window for a model that resolves to DeepSeek, or undefined.
 *
 * Name-based on purpose — no base-URL arm. getContextWindowForModel runs for
 * every provider, so a leftover OPENAI_BASE_URL pointing at DeepSeek would hand
 * a 1M window to an Anthropic session. A gateway that renames the model beyond
 * recognition therefore falls back to the 200k default;
 * CLAUDE_CODE_MAX_CONTEXT_TOKENS is the documented correction for that.
 */
export function getDeepSeekContextWindow(model: string): number | undefined {
  return isDeepSeekModelOrAlias(model) ? DEEPSEEK_CONTEXT_WINDOW : undefined
}
