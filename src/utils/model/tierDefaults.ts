/**
 * Factory defaults for thinking effort and context window, by provider family.
 *
 * Before this, both axes were single global values: one flat
 * `settings.effortLevel`, and one `CLAUDE_CODE_MAX_CONTEXT_TOKENS` that
 * `utils/session/context.ts` describes as "the single knob". Neither could say
 * "opus should think hard and get the big window, haiku should stay cheap",
 * and neither knew that a sensible default depends on which provider is behind
 * the alias.
 *
 * | family              | effort | context |
 * | ------------------- | ------ | ------- |
 * | DeepSeek            | max    | 1M      |
 * | GPT                 | xhigh  | 272k    |
 * | Gemini / Grok       | high   | 200k    |
 * | Claude opus/fable   | xhigh  | 1M      |
 * | Claude sonnet/haiku | xhigh  | 200k    |
 * | anything else       | xhigh  | 200k    |
 *
 * Claude sonnet and haiku take the same effort as opus — the tier difference is
 * about the window, which is a capability, not about how hard to think, which
 * is a preference.
 *
 * Gemini and Grok are the two families whose effort knob occ maps onto a
 * provider parameter with no five-rung vocabulary of its own (a thinking budget
 * and a two-rung ladder respectively). `high` is the rung those mappings define
 * as the identity — the value that reproduces what the provider did before occ
 * started steering it — so an existing session is byte-identical until its user
 * picks something else.
 *
 * Two hard limits are applied by the callers, not here:
 *   - effort is only ever SENT when `modelSupportsEffort(model)` is true, so a
 *     checkpoint that rejects the parameter never sees it;
 *   - the 1M window is only taken when `modelSupports1M(model)` is true, and
 *     for Claude it also requires the `[1m]` opt-in that produces the beta
 *     header. Widening the local accounting without that header would stop
 *     auto-compact from ever firing and turn a compaction into a hard
 *     prompt-too-long at 200k.
 *
 * Zero imports for the same reason as modelTier.ts: both hot resolvers consult
 * this and both are reachable from providers.ts.
 */

import type { ModelTier } from './modelTier.js'

/** The five levels occ exposes, lowest to highest. */
export type TierEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Provider families that get their own defaults. */
export type ProviderFamily =
  | 'deepseek'
  | 'gpt'
  | 'claude'
  | 'gemini'
  | 'grok'
  | 'other'

export const CONTEXT_200K = 200_000
export const CONTEXT_272K = 272_000
export const CONTEXT_1M = 1_000_000

export type TierDefaults = {
  effort: TierEffort
  contextTokens: number
}

/**
 * Classify a model id by provider family.
 *
 * String-only so this stays dependency-free. The equivalent predicates
 * elsewhere (`isDeepSeekFamilyModel`, `isGptFamilyModel`) use the same tests;
 * they are not imported because both live in modules that reach providers.ts.
 */
export function getProviderFamily(model: string): ProviderFamily {
  const lower = model.toLowerCase()
  if (lower.includes('deepseek')) return 'deepseek'
  if (lower.startsWith('gpt-') || lower.includes('codex')) return 'gpt'
  if (lower.startsWith('gemini')) return 'gemini'
  if (lower.startsWith('grok')) return 'grok'
  if (
    lower.includes('claude') ||
    lower.includes('opus') ||
    lower.includes('sonnet') ||
    lower.includes('haiku') ||
    lower.includes('fable')
  ) {
    return 'claude'
  }
  return 'other'
}

/**
 * The factory defaults for a model, before any user configuration or env
 * override is applied.
 */
export function getTierDefaults(
  model: string,
  tier: ModelTier | undefined = undefined,
): TierDefaults {
  const family = getProviderFamily(model)
  switch (family) {
    case 'deepseek':
      return { effort: 'max', contextTokens: CONTEXT_1M }
    case 'gpt':
      return { effort: 'xhigh', contextTokens: CONTEXT_272K }
    case 'gemini':
    case 'grok':
      return { effort: 'high', contextTokens: CONTEXT_200K }
    case 'claude': {
      // The tier argument wins when the caller knows which alias was asked
      // for; otherwise sniff the id. Sonnet and Haiku do not get the 1M
      // default — Opus and Fable do.
      const resolved = tier ?? sniffClaudeTier(model)
      const wide = resolved === 'opus' || resolved === 'fable'
      return {
        effort: 'xhigh',
        contextTokens: wide ? CONTEXT_1M : CONTEXT_200K,
      }
    }
    default:
      return { effort: 'xhigh', contextTokens: CONTEXT_200K }
  }
}

/** Inline tier sniff — kept private so modelTier.ts stays the public answer. */
function sniffClaudeTier(model: string): ModelTier | undefined {
  const lower = model.toLowerCase()
  if (lower.includes('haiku')) return 'haiku'
  if (lower.includes('fable')) return 'fable'
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  return undefined
}
