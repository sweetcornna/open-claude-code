/**
 * Everything a wizard save decides, decided before anything is written.
 *
 * The save used to be a straight line inside ModelStep: build an env patch,
 * hand it to updateSettingsForSource, then replay the same patch onto
 * process.env. Three bugs lived in that line and none of them were reachable
 * from a test, because reaching them meant rendering a form and driving a
 * picker:
 *
 *   - a blank credential field deleted the credential, which for a
 *     subscription session (ChatGPT, Antigravity) meant the form destroyed the
 *     login it was opened on top of;
 *   - clearing the *other* provider groups deleted their keys from
 *     `process.env` too, including an `ANTHROPIC_API_KEY` the user had exported
 *     in their own shell — which then stayed missing from every Bash tool call
 *     for the rest of the session;
 *   - "reset thinking effort" was inferred from the prefill rather than from
 *     the user, so the one case where the prefill is empty *because the tiers
 *     disagree* was the one case where choosing "(model default)" did nothing.
 *
 * So the decision is a pure function over (spec, screen, values, settings,
 * environment) and the component only applies it.
 */

import {
  PROFILE_ENV_KEYS,
  type ProfileModelType,
} from 'src/services/providerProfiles/envKeys.js'
import type { TierEffort } from 'src/utils/model/tierDefaults.js'
import type { ProviderSetupSpec, ProviderSetupValues } from './specs.js'
import type { ProviderModelSetupStatus } from './state.js'
import { buildTierSettings } from './tierPersistence.js'

type TierSettingsPatch = ReturnType<typeof buildTierSettings>

/** The slice of `settings.json` a save reads before deciding what to write. */
export type ProviderSaveSettings = {
  modelType?: string
  env?: Readonly<Record<string, string>>
  modelSettings?: Parameters<typeof buildTierSettings>[0]['existing']
}

/**
 * What changed, for the host that has to refresh the session afterwards.
 *
 * `providerChanged` is deliberately narrower than "the wizard saved": an
 * in-session `/model` choice survives an effort or context-window edit, and
 * dropping it every time meant a user who opened `/models-setting` to nudge
 * thinking effort came back to a different model than the one they were using.
 */
export type ProviderSaveOutcome = {
  /** `settings.modelType` after the save. */
  modelType: string
  /** True when an in-session `/model` choice can no longer be trusted. */
  providerChanged: boolean
}

export type ProviderSavePlan = {
  /** Patch for `settings.env`; `undefined` deletes the key. */
  env: Record<string, string | undefined>
  /** Patch for `settings.modelSettings`. */
  modelSettings: TierSettingsPatch
  /** Whether the flat `effortLevel` (which seeds AppState) must be cleared. */
  clearFlatEffort: boolean
  /** Whether this save (re)configured credentials — passed to `afterSave`. */
  credentialsConfigured: boolean
  outcome: ProviderSaveOutcome
}

export type ProviderSaveInput = {
  /** The spec as it applies to this screen (see specForSubscriptionAuth). */
  spec: ProviderSetupSpec
  status: ProviderModelSetupStatus
  values: ProviderSetupValues
  /** Parsed "Max context tokens"; undefined when the field was left empty. */
  contextTokens: number | undefined
  /**
   * Whether the user moved the effort picker in this run. The prefill cannot
   * answer this: it is empty both when nothing is configured and when the tiers
   * disagree, and only in the second case does choosing "(model default)" mean
   * "clear what is saved".
   */
  effortTouched: boolean
  /** `settings.json` (userSettings) as it stands before the save. */
  existingSettings: ProviderSaveSettings | null | undefined
  /** The live environment, for the before/after comparison. */
  processEnv: NodeJS.ProcessEnv
}

export function planProviderSave({
  spec,
  status,
  values,
  contextTokens,
  effortTouched,
  existingSettings,
  processEnv,
}: ProviderSaveInput): ProviderSavePlan {
  // Model-only mode: the credentials belong to a subscription login that this
  // form never showed, so nothing on the credential plane is ours to write.
  const credentialsConfigured = status.credentialEditing !== 'locked'
  const showsDefaultModel = spec.defaultModelField !== 'omitted'

  const env: Record<string, string | undefined> = {}
  // Every provider group but this one is cleared, so a session cannot half
  // belong to two providers. What that means for the live process is
  // applyProviderSaveEnv's business, and it is not the same thing.
  for (const [modelType, keys] of Object.entries(PROFILE_ENV_KEYS) as [
    ProfileModelType,
    readonly string[],
  ][]) {
    if (modelType === spec.modelType) continue
    for (const key of keys) env[key] = undefined
  }
  if (credentialsConfigured) {
    Object.assign(env, spec.extraEnv?.(status) ?? {})
  }
  // The max-context answer goes to settings.modelSettings, not to
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS. That key sits ABOVE the per-tier layer on
  // purpose — it is the last-resort correction for a window nobody can detect
  // — so a value written there at login would silently outrank everything the
  // user later sets in /model. Any value an older occ left behind is deleted
  // here for the same reason: leaving it would make the setting they just
  // chose invisible. One-way, and the field carries the old value forward
  // (see prefillTierFields), so nothing is lost.
  env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = undefined
  if (credentialsConfigured) {
    // Empty values delete an earlier configuration. Leaving a field blank must
    // not preserve a stale endpoint or key from the previous provider.
    env[spec.env.baseUrl] = status.baseUrl.trim() || undefined
    env[spec.env.apiKey] = status.apiKey.trim() || undefined
  }
  // `omitted` still assigns undefined — that deletes any value a previous
  // login left behind, which is the point (see defaultModelField's docs).
  env[spec.env.model] = showsDefaultModel
    ? values.model.trim() || undefined
    : undefined
  for (const tier of spec.tiers) {
    env[spec.env.tiers[tier]] = values[tier].trim() || undefined
  }

  // "(model default)" chosen by a user who touched the picker is an
  // instruction; the same value sitting there because the tiers disagree is
  // just the form declining to guess. Reading the prefill alone conflated
  // them, and the disagreement case is exactly the one someone opens the form
  // to fix. `status.effort !== ''` is kept as a second route in for the save
  // paths that do not go through the picker at all.
  const resetEffort =
    values.effort === '' && (effortTouched || status.effort !== '')

  const modelSettings = buildTierSettings({
    tierModels: {
      haiku_model: values.haiku_model,
      sonnet_model: values.sonnet_model,
      opus_model: values.opus_model,
      fable_model: values.fable_model,
    },
    defaultModel: showsDefaultModel ? values.model : '',
    contextTokens,
    effort: (values.effort || undefined) as TierEffort | undefined,
    resetEffort,
    existing: existingSettings?.modelSettings,
  })

  return {
    env,
    modelSettings,
    // The flat effortLevel seeds AppState, which outranks the per-tier layer.
    // Clear it for explicit values and for first-setup defaults alike.
    clearFlatEffort:
      resetEffort ||
      Object.values(modelSettings).some(tier => tier?.effort !== undefined),
    credentialsConfigured,
    outcome: {
      modelType: spec.modelType,
      providerChanged: didProviderChange({
        spec,
        env,
        credentialsConfigured,
        existingSettings,
        processEnv,
      }),
    },
  }
}

/**
 * Whether the session is now pointed somewhere else.
 *
 * Three things can move it: the provider family, the endpoint, and the default
 * model (which pins one model for every alias, so changing it changes what
 * every unqualified request resolves to). Tier reassignments deliberately do
 * not count — a tier alias re-resolves on every request, so an in-session
 * `/model sonnet` keeps meaning whatever sonnet now points at.
 */
function didProviderChange({
  spec,
  env,
  credentialsConfigured,
  existingSettings,
  processEnv,
}: {
  spec: ProviderSetupSpec
  env: Record<string, string | undefined>
  credentialsConfigured: boolean
  existingSettings: ProviderSaveSettings | null | undefined
  processEnv: NodeJS.ProcessEnv
}): boolean {
  if (existingSettings?.modelType !== spec.modelType) return true
  const before = (key: string): string => processEnv[key]?.trim() ?? ''
  const after = (key: string): string => env[key]?.trim() ?? ''
  if (before(spec.env.model) !== after(spec.env.model)) return true
  // A model-only save never writes the base URL, so there is nothing to
  // compare — reading `env` there would report every save as a change.
  return (
    credentialsConfigured &&
    before(spec.env.baseUrl) !== after(spec.env.baseUrl)
  )
}

/**
 * Replay the settings patch onto the live process, without taking anything
 * that is not occ's to take.
 *
 * Writing a value is unconditional: the user just asked for it. Deleting one
 * is not. `settings.env` is occ's own layer and clearing a key there is always
 * right, but `process.env` is shared — `ANTHROPIC_API_KEY` and friends are
 * routinely exported from the user's shell, and occ hands the whole
 * environment to every Bash tool call. The old code deleted the other provider
 * groups' keys outright, so configuring Gemini silently unset an
 * `ANTHROPIC_API_KEY` the user had exported for their own scripts, for the
 * rest of the session and for reasons nothing surfaced.
 *
 * The test for "is this ours" is value equality with the settings layer we are
 * clearing: anything else was put there by a shell export or a later `export`,
 * and it is also what a restart would restore, so leaving it is the honest
 * answer as well as the safe one.
 */
export function applyProviderSaveEnv(
  env: Record<string, string | undefined>,
  /** `settings.env` as it stood BEFORE this save. */
  previousManagedEnv: Readonly<Record<string, string>> | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): void {
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      processEnv[key] = value
      continue
    }
    const current = processEnv[key]
    if (current !== undefined && current === previousManagedEnv?.[key]) {
      delete processEnv[key]
    }
  }
}
