/**
 * Turning the setup wizard's two form values into per-tier settings that
 * outlive the session.
 *
 * The wizard used to persist its "Max context tokens" answer as
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, one flat env key for every tier. That was
 * the only place it could go before `settings.modelSettings` existed, and it
 * has since become actively wrong: env sits ABOVE the per-tier layer on
 * purpose (it is the documented last-resort correction for a window nobody can
 * detect), so a value written there at login silently outranks everything the
 * user later sets in `/model` or `/model-settings`. Login is not a
 * last-resort correction; it is the user configuring their provider.
 *
 * Thinking effort had nowhere to go at all — the wizard never asked, and the
 * resolved default lived only in memory.
 *
 * So both now land in `settings.modelSettings`, per tier, as concrete values.
 * Concrete rather than left implicit because the point is that they persist:
 * after login `/model-settings` shows five configured slots instead of five
 * rows of "(defaults)" whose meaning shifts under the user when occ's default
 * table changes. `/model-settings <tier> reset` puts a tier back on the
 * moving default.
 *
 * Pure, and separate from the component, for the same reason
 * `/model-settings` keeps state.ts: what lands in settings.json is worth
 * testing without rendering a form.
 */

import type { ModelSettingsSlot, ModelTier } from 'src/utils/model/modelTier.js'
import {
  getTierDefaults,
  type TierEffort,
} from 'src/utils/model/tierDefaults.js'
import type { TierField } from './specs.js'

type TierSettingsPatch = {
  effort?: TierEffort
  contextTokens?: number
}

/** Form field name → the tier it configures. */
const TIER_BY_FIELD: Record<TierField, ModelTier> = {
  haiku_model: 'haiku',
  sonnet_model: 'sonnet',
  opus_model: 'opus',
  fable_model: 'fable',
}

type BuildTierSettingsArgs = {
  /** The tier model fields as the form holds them; '' means "not configured". */
  tierModels: Record<TierField, string>
  /** The default-model field, used for tiers the user left empty. */
  defaultModel: string
  /** Parsed "Max context tokens"; undefined when the field was left empty. */
  contextTokens: number | undefined
  /** Chosen effort; undefined when the field was left on "(model default)". */
  effort: TierEffort | undefined
  /**
   * Whether the user changed a saved effort back to "(model default)".
   * Ignored on a first setup — there is nothing saved to change back.
   */
  resetEffort?: boolean
  /** What `settings.modelSettings` already holds, if anything. */
  existing: Partial<Record<ModelSettingsSlot, TierSettingsPatch>> | undefined
}

/** Whether any tier has already been configured, by this wizard or by hand. */
function hasAnyTierConfigured(
  existing: Partial<Record<ModelSettingsSlot, TierSettingsPatch>> | undefined,
): boolean {
  if (!existing) return false
  return Object.values(existing).some(
    tier => tier?.effort !== undefined || tier?.contextTokens !== undefined,
  )
}

/**
 * The `modelSettings` patch a wizard save should write.
 *
 * An empty form field means two different things depending on whether the user
 * has configured anything before, and the difference matters:
 *
 *   - **First setup** (nothing in `modelSettings` yet): write each tier's
 *     resolved family default. That is the whole point of persisting here — a
 *     fresh login ends with five concrete slots rather than four rows whose
 *     meaning shifts under the user when occ's default table changes.
 *   - **Re-running the wizard** (`/models-setting`, or a second `/login`): leave that
 *     axis alone. Someone who tuned opus and haiku differently in `/model` must
 *     not have both flattened to one value just because they reopened the form
 *     to change an endpoint. Only an explicitly filled field is applied, and it
 *     is applied to every tier.
 *
 * A tier with no model behind it is skipped rather than guessed at: the
 * defaults are keyed on the provider family, and inventing one for a tier the
 * user never configured would write `xhigh`/200k — the "unknown provider" row —
 * over a tier that would otherwise resolve correctly at runtime once a model
 * does exist.
 */
export function buildTierSettings({
  tierModels,
  defaultModel,
  contextTokens,
  effort,
  resetEffort = false,
  existing,
}: BuildTierSettingsArgs): Partial<
  Record<ModelSettingsSlot, TierSettingsPatch>
> {
  const seedDefaults = !hasAnyTierConfigured(existing)
  // Nothing is configured yet, so there is nothing to clear. Honouring a reset
  // here would invert the first-setup rule instead: the same empty field that
  // is supposed to seed each family default would write `effort: undefined`
  // over it, and a fresh login would end with the four rows of "(defaults)"
  // this whole module exists to avoid.
  const clearEffort = resetEffort && !seedDefaults
  const patch: Partial<Record<ModelSettingsSlot, TierSettingsPatch>> = {}
  const primaryModel = defaultModel.trim()
  const slots: [ModelSettingsSlot, string][] = []
  if (primaryModel) slots.push(['default', primaryModel])
  for (const [field, tier] of Object.entries(TIER_BY_FIELD) as [
    TierField,
    ModelTier,
  ][]) {
    slots.push([tier, tierModels[field].trim() || primaryModel])
  }

  for (const [slot, model] of slots) {
    if (!model) continue
    const defaults = getTierDefaults(
      model,
      slot === 'default' ? undefined : slot,
    )
    const tierEffort = effort ?? (seedDefaults ? defaults.effort : undefined)
    const tierContext =
      contextTokens ?? (seedDefaults ? defaults.contextTokens : undefined)
    if (tierEffort === undefined && tierContext === undefined && !clearEffort) {
      continue
    }
    patch[slot] = {
      ...(clearEffort
        ? { effort: undefined }
        : tierEffort !== undefined
          ? { effort: tierEffort }
          : {}),
      ...(tierContext !== undefined ? { contextTokens: tierContext } : {}),
    }
  }
  if (clearEffort) {
    for (const slot of Object.keys(existing ?? {}) as ModelSettingsSlot[]) {
      patch[slot] = { ...patch[slot], effort: undefined }
    }
  }
  return patch
}

/**
 * What the form's two fields should show when it opens.
 *
 * One field describes four tiers, so a saved value is only offered back when
 * every configured tier agrees on it — showing one tier's value would invite
 * the user to press Enter and flatten the other three onto it. Disagreement
 * reads as empty, which the rules above then leave untouched.
 *
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is still read as a fallback so a config
 * written by an older occ opens showing the value it is actually running with.
 */
export function prefillTierFields(
  existing: Partial<Record<ModelSettingsSlot, TierSettingsPatch>> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { maxContext: string; effort: string } {
  const configured = Object.values(existing ?? {}).filter(
    tier => tier?.effort !== undefined || tier?.contextTokens !== undefined,
  )
  const agreed = <T>(pick: (tier: TierSettingsPatch) => T): T | undefined => {
    if (configured.length === 0) return undefined
    const first = pick(configured[0]!)
    if (first === undefined) return undefined
    return configured.every(tier => pick(tier) === first) ? first : undefined
  }

  const contextTokens = agreed(tier => tier.contextTokens)
  return {
    maxContext:
      contextTokens !== undefined
        ? String(contextTokens)
        : (env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? ''),
    effort: agreed(tier => tier.effort) ?? '',
  }
}
