/**
 * Reading `settings.modelSettings` — the per-tier effort / context overrides.
 *
 * Resolution order for both axes, decided deliberately:
 *
 *   env  >  per-tier setting  >  built-in provider default
 *
 * Env stays on top because `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is documented as
 * the last-resort correction for a third-party model whose real window nobody
 * can detect, and scripts / containers / CI rely on being able to force it for
 * one run. Demoting it would silently break those.
 *
 * Reads go through `getSettingsForSource('userSettings')` rather than the
 * merged snapshot, matching how effort.ts and ModelPicker already read a
 * "prior explicit choice": project and policy layers should not silently
 * decide how hard a user's model thinks.
 */

import { getSettingsForSource } from '../settings/settings.js'
import {
  getModelTier,
  getModelTiers,
  type ModelSettingsSlot,
} from './modelTier.js'
import {
  getTierDefaults,
  type TierDefaults,
  type TierEffort,
} from './tierDefaults.js'

type TierOverride = {
  effort?: TierEffort
  contextTokens?: number
}

/**
 * The user's overrides for one tier, or undefined.
 *
 * `userSettings` only — see the module comment.
 */
export function getTierOverride(
  slot: ModelSettingsSlot | undefined,
): TierOverride | undefined {
  if (!slot) return undefined
  const settings = getSettingsForSource('userSettings')
  const perTier = settings?.modelSettings
  if (!perTier) return undefined
  return perTier[slot] as TierOverride | undefined
}

/**
 * The override that applies to a model id, resolving the many-to-one case.
 *
 * `getModelTiers` can return several tiers for one id — pinning every alias to
 * one checkpoint is a normal third-party setup, and nothing in the request
 * distinguishes them afterwards. Preferring the candidate the user actually
 * configured is what makes `/model-settings opus context 512k` do something on
 * such a session; falling back to the most capable candidate only matters when
 * two of them are configured differently, which is a preference the id can no
 * longer carry either way.
 */
function getOverrideForModel(
  model: string,
  settingsSlot?: ModelSettingsSlot,
): TierOverride | undefined {
  if (settingsSlot) return getTierOverride(settingsSlot)
  const tiers = getModelTiers(model)
  if (tiers.length === 0) return undefined
  if (tiers.length === 1) return getTierOverride(tiers[0])
  const configured = tiers.find(tier => hasTierOverride(tier))
  return getTierOverride(configured ?? tiers[0])
}

function tierForDefaults(
  model: string,
  settingsSlot?: ModelSettingsSlot,
): Exclude<ModelSettingsSlot, 'default'> | undefined {
  return settingsSlot === 'default'
    ? undefined
    : (settingsSlot ?? getModelTier(model))
}

/**
 * Effort for a model after applying the per-tier override, or the factory
 * default. Does NOT consult the env override — callers sit downstream of that
 * (see resolveAppliedEffort, which checks CLAUDE_CODE_EFFORT_LEVEL first).
 */
export function getTierEffort(
  model: string,
  settingsSlot?: ModelSettingsSlot,
): TierEffort {
  const override = getOverrideForModel(model, settingsSlot)?.effort
  return (
    override ??
    getTierDefaults(model, tierForDefaults(model, settingsSlot)).effort
  )
}

/**
 * Only the user's EXPLICIT context setting for this model's tier.
 *
 * Separate from the default because the two belong at different points in
 * getContextWindowForModel: an explicit choice outranks every detection arm,
 * while a family default must sit BELOW them — returning a default early would
 * short-circuit China-preset windows, ChatGPT windows and the /v1/models
 * capability lookup, all of which know more than a default does.
 */
export function getExplicitTierContextTokens(
  model: string,
  settingsSlot?: ModelSettingsSlot,
): number | undefined {
  return getOverrideForModel(model, settingsSlot)?.contextTokens
}

/** The family default window, used as the bottom fallback. */
export function getTierDefaultContextTokens(
  model: string,
  settingsSlot?: ModelSettingsSlot,
): number {
  return getTierDefaults(model, tierForDefaults(model, settingsSlot))
    .contextTokens
}

/**
 * Context window for a model after applying the per-tier override, or the
 * factory default. Used by the panel and by the 1M opt-in, which both want the
 * resolved intent rather than the layered lookup.
 */
export function getTierContextTokens(
  model: string,
  settingsSlot?: ModelSettingsSlot,
): number {
  const override = getOverrideForModel(model, settingsSlot)?.contextTokens
  return (
    override ??
    getTierDefaults(model, tierForDefaults(model, settingsSlot)).contextTokens
  )
}

/** Both axes at once, for the `/model-settings` panel and diagnostics. */
export function getResolvedTierSettings(
  model: string,
  settingsSlot?: ModelSettingsSlot,
): TierDefaults {
  return {
    effort: getTierEffort(model, settingsSlot),
    contextTokens: getTierContextTokens(model, settingsSlot),
  }
}

/** `1000000` → `1M`, `272000` → `272k`. Shared by `/model` and `/model-settings`. */
export function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

/** Whether the user has explicitly configured anything for this tier. */
export function hasTierOverride(slot: ModelSettingsSlot | undefined): boolean {
  const override = getTierOverride(slot)
  return override?.effort !== undefined || override?.contextTokens !== undefined
}
