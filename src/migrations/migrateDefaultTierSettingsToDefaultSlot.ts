import { getSettingsForSource } from '../utils/settings/settings.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { getDefaultMainLoopModel } from '../utils/model/model.js'
import { getModelTier } from '../utils/model/modelTier.js'

/**
 * Carry a 2.34 "Default" row's model settings into the new `default` slot.
 *
 * 2.34's `/model` picker had no `default` slot: the Default row resolved the
 * model first and wrote whichever TIER that id reverse-looked-up to, so a Max
 * user adjusting the Default row wrote `modelSettings.opus` and a DeepSeek user
 * wrote whichever alias their `OPENAI_DEFAULT_*_MODEL` pins named. 2.35 gives
 * the provider default its own slot and reads it by selection SOURCE, so those
 * values become unreachable for the session they were configured on — the
 * settings are still in the file, still shown by `/model-settings`, and silently
 * ignored.
 *
 * Copy rather than move: the tier slot is still the right home for an explicit
 * `/model opus`, and the two are independent from here on.
 *
 * Idempotent by construction — it does nothing once `default` exists, which is
 * also what makes a second run after the user has edited `default` a no-op.
 */
export function migrateDefaultTierSettingsToDefaultSlot(): void {
  const modelSettings = getSettingsForSource('userSettings')?.modelSettings
  if (!modelSettings || modelSettings.default) return

  const tier = defaultModelTier()
  if (!tier) return

  const inherited = modelSettings[tier]
  if (!inherited) return
  if (inherited.effort === undefined && inherited.contextTokens === undefined) {
    return
  }

  updateSettingsForSource('userSettings', {
    modelSettings: { ...modelSettings, default: { ...inherited } },
  })
}

/**
 * The tier 2.34 would have written for the Default row, or undefined.
 *
 * getDefaultMainLoopModel() reaches the subscription chain for first-party
 * sessions, and that chain throws when no credential is present (CI, a config
 * subprocess, a user who has not logged in yet). A migration that cannot tell
 * which tier to copy from must skip, not crash the startup path it runs on.
 */
function defaultModelTier(): ReturnType<typeof getModelTier> {
  try {
    return getModelTier(getDefaultMainLoopModel())
  } catch {
    return undefined
  }
}
