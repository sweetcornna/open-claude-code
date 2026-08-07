/**
 * Whether the per-tier configuration asks for the 1M window on this model.
 *
 * Split from tierSettings.ts so `model.ts` can consult it without importing
 * the settings reader directly: `apply1mContextOptIn` runs on both exits of
 * `getMainLoopModel`, which the settings layer itself can reach.
 *
 * Capability is checked here rather than by the caller because the answer is
 * "should this id carry `[1m]`", and a model that cannot do 1M must never get
 * the suffix — the suffix is what sends the beta header.
 */

import { modelSupports1M } from '../session/context.js'
import { servesAnthropicModels } from './providers.js'
import { getTierContextTokens } from './tierSettings.js'

/** Tokens at or above which the 1M opt-in applies. */
const ONE_MILLION = 1_000_000

export function wantsTierWideContext(model: string): boolean {
  // The suffix exists to produce Anthropic's context-1m beta header, so it is
  // meaningless anywhere that header is not going to Anthropic. An
  // OpenAI-compatible session whose tier resolved to a leftover `claude-
  // sonnet-5` would otherwise be shown — and would send — `claude-sonnet-5[1m]`.
  if (!servesAnthropicModels()) return false
  if (!modelSupports1M(model)) return false
  return getTierContextTokens(model) >= ONE_MILLION
}
