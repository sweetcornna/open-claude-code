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
import { getModelTier, type ModelTier } from './modelTier.js'
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
  tier: ModelTier | undefined,
): TierOverride | undefined {
  if (!tier) return undefined
  const settings = getSettingsForSource('userSettings')
  const perTier = settings?.modelSettings
  if (!perTier) return undefined
  return perTier[tier] as TierOverride | undefined
}

/**
 * Effort for a model after applying the per-tier override, or the factory
 * default. Does NOT consult the env override — callers sit downstream of that
 * (see resolveAppliedEffort, which checks CLAUDE_CODE_EFFORT_LEVEL first).
 */
export function getTierEffort(model: string): TierEffort {
  const tier = getModelTier(model)
  const override = getTierOverride(tier)?.effort
  return override ?? getTierDefaults(model, tier).effort
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
): number | undefined {
  return getTierOverride(getModelTier(model))?.contextTokens
}

/** The family default window, used as the bottom fallback. */
export function getTierDefaultContextTokens(model: string): number {
  const tier = getModelTier(model)
  return getTierDefaults(model, tier).contextTokens
}

/**
 * Context window for a model after applying the per-tier override, or the
 * factory default. Used by the panel and by the 1M opt-in, which both want the
 * resolved intent rather than the layered lookup.
 */
export function getTierContextTokens(model: string): number {
  const tier = getModelTier(model)
  const override = getTierOverride(tier)?.contextTokens
  return override ?? getTierDefaults(model, tier).contextTokens
}

/** Both axes at once, for the `/model-settings` panel and diagnostics. */
export function getResolvedTierSettings(model: string): TierDefaults {
  return {
    effort: getTierEffort(model),
    contextTokens: getTierContextTokens(model),
  }
}

/** Whether the user has explicitly configured anything for this tier. */
export function hasTierOverride(tier: ModelTier | undefined): boolean {
  const override = getTierOverride(tier)
  return override?.effort !== undefined || override?.contextTokens !== undefined
}
