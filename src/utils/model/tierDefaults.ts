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
 * | family              | effort | context               |
 * | ------------------- | ------ | --------------------- |
 * | DeepSeek            | max    | 1M                    |
 * | GPT                 | xhigh  | 272k                  |
 * | Gemini              | high   | 1M for known text ids |
 * | Grok                | high   | per generation        |
 * | Claude opus/fable   | xhigh  | 1M                    |
 * | Claude sonnet/haiku | xhigh  | 200k                  |
 * | anything else       | xhigh  | 200k                  |
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
 * That argument is about EFFORT only. It was applied to the context axis by
 * accident, and a flat 200k there is not an identity — it is wrong by 5× for
 * Gemini and by up to 5× for Grok, so every session of theirs auto-compacted at
 * roughly 15% of the capacity it had paid for. The two axes are now decided
 * separately; see the tables below for what each window is and how sure we are
 * of it.
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
type ProviderFamily =
  | 'deepseek'
  | 'gpt'
  | 'claude'
  | 'gemini'
  | 'grok'
  | 'other'

export const CONTEXT_200K = 200_000
export const CONTEXT_256K = 256_000
export const CONTEXT_272K = 272_000
export const CONTEXT_500K = 500_000
export const CONTEXT_1M = 1_000_000

export type TierDefaults = {
  effort: TierEffort
  contextTokens: number
}

/**
 * OpenAI's reasoning line: `o1`, `o1-mini`, `o3`, `o3-mini`, `o4-mini`.
 *
 * They are GPT-family models with none of the GPT-family spelling, so without
 * this they landed in `other` and were handed the 200k fallback instead of the
 * 272k budget the rest of the family gets. Anchored and digit-gated so it cannot
 * reach `opus`, `openai/…` or anything else that merely starts with an "o".
 */
const O_SERIES_ID = /^o[1-9][0-9]?(?:[-.]|$)/

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
  if (
    lower.startsWith('gpt-') ||
    lower.includes('codex') ||
    O_SERIES_ID.test(lower)
  ) {
    return 'gpt'
  }
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
 * Every generative Gemini text model since 1.5 publishes the same 1,048,576
 * input-token limit — 2.0 Flash, 2.5 Pro/Flash/Flash-Lite, the whole 3.x line.
 * It is the one family where a version-prefixed rule is safer than a list: the
 * list goes stale (Google retired 3-pro-preview and 2.0-flash within six months
 * of shipping them) while the number has not moved in four generations.
 *
 * The exceptions are all spelled out in the id. Embedding models are 2k–8k and
 * image models are 64k–128k, and neither is something occ can drive a session
 * with — but a `gemini-` prefix rule that swallowed them would hand a 1M window
 * to a 2k model, which is the failure this whole change exists to prevent.
 *
 * 1M and not 1,048,576: undershooting a window costs a slightly early compact,
 * overshooting costs a hard prompt-too-long, and the round number is what the
 * `/model` ladder and `/model-settings` render.
 */
const GEMINI_VERSIONED_ID = /^gemini-\d/
const GEMINI_SMALL_WINDOW_ID = /embedding|image|imagen|veo|tts|native-audio/

/**
 * Grok, per generation, from docs.x.ai.
 *
 * No prefix rule here: unlike Gemini, xAI's windows genuinely differ between
 * live models (256k for the coding line, 500k for 4.5/4.6, 1M for 4.20/4.3), so
 * a family-wide guess would be wrong for most of them in one direction or the
 * other. An unmatched `grok-*` id therefore keeps the 200k fallback rather than
 * inheriting a sibling's number.
 *
 * Two deliberate imprecisions, both in the safe direction. The direction is not
 * a matter of taste: overestimating a window means the upstream rejects the
 * request outright, while underestimating it means compacting sooner than
 * necessary — wasteful but working. The costs are not symmetric, so anything
 * that cannot be confirmed from a primary source resolves toward "still works".
 *   - grok-4-fast / grok-4.1-fast documented 2M, but were retired on
 *     2026-05-15 and now redirect to grok-4.3, so they get grok-4.3's 1M.
 *   - grok-3 / grok-3-mini are commonly cited at 131k, but xAI's pages for them
 *     are gone, so the number cannot be confirmed first-hand. They are left off
 *     the table entirely and keep the 200k fallback rather than being pinned to
 *     something unverifiable — and since these ids redirect too, the real
 *     behaviour is not this table's to decide anyway.
 *
 * Also unresolved: xAI publishes one "context window" figure without saying
 * whether it is input-only or input+output. These are used as occ's input
 * budget, which is the conservative reading — and occ subtracts reserved output
 * tokens from it on top (see getEffectiveContextWindowSize).
 *
 * Order matters: first match wins, so the specific generations precede the
 * `grok-4` catch-all.
 */
const GROK_CONTEXT_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  // grok-build-0.1, aliased as grok-code-fast / grok-code-fast-1[-0825].
  [/^grok-(?:build|code-fast)/, CONTEXT_256K],
  [/^grok-4\.[56](?:\D|$)/, CONTEXT_500K],
  [/^grok-4\.(?:20|3)(?:\D|$)/, CONTEXT_1M],
  [/^grok-4(?:\.1)?-(?:1-)?fast/, CONTEXT_1M],
  // grok-4 / grok-4-0709.
  [/^grok-4(?:-|$)/, CONTEXT_256K],
]

function getGeminiContextWindow(lower: string): number {
  if (!GEMINI_VERSIONED_ID.test(lower)) return CONTEXT_200K
  if (GEMINI_SMALL_WINDOW_ID.test(lower)) return CONTEXT_200K
  return CONTEXT_1M
}

function getGrokContextWindow(lower: string): number {
  for (const [pattern, window] of GROK_CONTEXT_WINDOWS) {
    if (pattern.test(lower)) return window
  }
  return CONTEXT_200K
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
      return {
        effort: 'high',
        contextTokens: getGeminiContextWindow(model.toLowerCase()),
      }
    case 'grok':
      return {
        effort: 'high',
        contextTokens: getGrokContextWindow(model.toLowerCase()),
      }
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
