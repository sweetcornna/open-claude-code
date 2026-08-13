/**
 * Which family alias a concrete model id belongs to.
 *
 * This regex already existed three times, module-private, in
 * `packages/@ant/model-provider/src/providers/{openai,gemini,grok}/modelMapping.ts`.
 * Per-tier configuration needs the same answer on the host side, so it lives
 * here once instead of a fourth copy.
 *
 * Deliberately zero imports. `getContextWindowForModel` and
 * `getDefaultEffortForModel` both consult this, and both are reachable from
 * `providers.ts`; anything with a dependency would close a cycle — the same
 * trap that made deepseekHost.ts necessary.
 *
 * Order matters: `fable` is checked before `opus`/`sonnet` because a Fable id
 * never contains those words, but future marketing names might combine them.
 */

/** The four family aliases occ exposes (`/model opus`, `/model haiku`, …). */
export const MODEL_TIERS = ['haiku', 'sonnet', 'opus', 'fable'] as const

export type ModelTier = (typeof MODEL_TIERS)[number]

/** The provider default plus the four aliases that can own model settings. */
export const MODEL_SETTINGS_SLOTS = ['default', ...MODEL_TIERS] as const

export type ModelSettingsSlot = (typeof MODEL_SETTINGS_SLOTS)[number]

export type SessionModelSettingsOverride = {
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  contextTokens?: number
}

export type SessionModelSettingsOverrides = Partial<
  Record<ModelSettingsSlot, SessionModelSettingsOverride>
>

export function updateSessionModelSettingsOverride(
  current: SessionModelSettingsOverrides,
  slot: ModelSettingsSlot,
  patch: {
    effort?: SessionModelSettingsOverride['effort']
    contextTokens?: number | null
  },
): SessionModelSettingsOverrides {
  const next = { ...current }
  const entry = { ...next[slot] }
  if (patch.effort !== undefined) entry.effort = patch.effort
  if (patch.contextTokens === null) delete entry.contextTokens
  else if (patch.contextTokens !== undefined) {
    entry.contextTokens = patch.contextTokens
  }
  next[slot] = Object.keys(entry).length > 0 ? entry : undefined
  return next
}

/**
 * Env prefixes that can carry per-tier model pins, and the order they are
 * searched in. Every provider-setup spec writes one of these
 * (`specs.ts`, `tierEnv(...)`), and the DeepSeek Anthropic wire mirrors the
 * OPENAI_* set onto the ANTHROPIC_* set.
 */
const TIER_ENV_PREFIXES = ['ANTHROPIC', 'OPENAI', 'GEMINI', 'GROK'] as const

/**
 * Descending capability, which is the tie-break when several tiers are pinned
 * to the SAME model id — see getModelTiers.
 */
const TIER_RESOLUTION_ORDER = ['fable', 'opus', 'sonnet', 'haiku'] as const

/** `deepseek-v4-pro[1m]` and `deepseek-v4-pro` are the same pin. */
function normalizeModelId(model: string): string {
  return model
    .trim()
    .replace(/\[1m\]$/i, '')
    .trim()
    .toLowerCase()
}

/**
 * Every tier a model id could have come from, most capable first.
 *
 * A Claude id names its own tier, so that path returns exactly one answer.
 * Third-party ids (`deepseek-v4-pro`, `glm-5.2`, `gpt-5.6-sol`) name none, and
 * that used to be the end of it: `getModelTier` returned undefined, so
 * `getTierOverride` returned undefined, so every value written by
 * `/model-settings` was silently ignored for exactly the sessions the feature
 * exists for. The pins the user configured (`OPENAI_DEFAULT_OPUS_MODEL=…`) are
 * the missing link — they say which alias resolves to which id, so they can be
 * read backwards.
 *
 * The reverse direction can be many-to-one: pinning all four aliases to one
 * checkpoint is a normal DeepSeek setup. The model is then literally the same
 * one whichever alias asked for it, so nothing about the request can
 * distinguish them; the list is returned most-capable-first and callers that
 * need a single answer say how they break the tie.
 */
export function getModelTiers(model: string): ModelTier[] {
  const named = sniffTierFromName(model)
  if (named) return [named]

  const id = normalizeModelId(model)
  if (!id) return []
  const matches: ModelTier[] = []
  for (const tier of TIER_RESOLUTION_ORDER) {
    for (const prefix of TIER_ENV_PREFIXES) {
      const pinned =
        process.env[`${prefix}_DEFAULT_${tier.toUpperCase()}_MODEL`]
      if (pinned && normalizeModelId(pinned) === id) {
        matches.push(tier)
        break
      }
    }
  }
  return matches
}

/**
 * The tier a model id maps to, or undefined when nothing names or pins it.
 *
 * Single-answer form of getModelTiers: the most capable candidate. Callers
 * that can do better — `getTierOverride` prefers whichever candidate the user
 * actually configured — should.
 */
export function getModelTier(model: string): ModelTier | undefined {
  return getModelTiers(model)[0]
}

/**
 * Settings slot for a user-facing model selection.
 *
 * `null` means the provider default. A tier alias keeps its identity even when
 * several aliases resolve to the same concrete id. Explicit model ids continue
 * through the existing reverse lookup.
 */
export function getModelSettingsSlot(
  model: string,
  selection: string | null | undefined,
): ModelSettingsSlot | undefined {
  if (selection === null || selection === undefined) return 'default'
  const normalizedSelection = normalizeModelId(selection)
  if ((MODEL_TIERS as readonly string[]).includes(normalizedSelection)) {
    return normalizedSelection as ModelTier
  }
  return getModelTier(model)
}

function sniffTierFromName(model: string): ModelTier | undefined {
  if (/haiku/i.test(model)) return 'haiku'
  if (/fable/i.test(model)) return 'fable'
  if (/opus/i.test(model)) return 'opus'
  if (/sonnet/i.test(model)) return 'sonnet'
  return undefined
}

/** Type guard for values coming out of settings.json. */
export function isModelTier(value: unknown): value is ModelTier {
  return (
    typeof value === 'string' &&
    (MODEL_TIERS as readonly string[]).includes(value)
  )
}
