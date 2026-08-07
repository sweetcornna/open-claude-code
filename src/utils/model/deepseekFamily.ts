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
// Re-exported so existing importers keep working; the definitions live in a
// zero-import module so callers reachable from providers.ts can use them
// without closing a cycle.
export {
  DEEPSEEK_API_HOST,
  DEEPSEEK_CONTEXT_WINDOW,
  isDeepSeekBaseURL,
  isDeepSeekFamilyModel,
} from './deepseekHost.js'
import {
  DEEPSEEK_CONTEXT_WINDOW,
  isDeepSeekFamilyModel,
} from './deepseekHost.js'

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
