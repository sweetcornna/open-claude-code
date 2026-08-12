/**
 * Picker rows for the aggregated model list.
 *
 * The union of several profiles' catalogs is built by
 * `src/services/providerProfiles/aggregate.ts`; this module is the thin,
 * render-free layer that turns those rows into ModelPicker options and back.
 * It is separate from the component so the option shape — and, more
 * importantly, the value encoding below — can be tested without rendering Ink.
 *
 * ## Why aggregated option values are namespaced
 *
 * Every other option value in the picker is either a tier ALIAS (`opus`,
 * `sonnet[1m]`) or a concrete model id, and `settingsSlotForOption()` tells
 * them apart by asking whether the value spells a tier. An aggregated row's
 * natural value is the selector, which is a provider's own model id — and a
 * provider is free to serve a model literally named `opus`. Handing that
 * straight to the tier machinery would let one relay's model id silently
 * capture the opus slot's effort and max-context settings.
 *
 * So aggregated values carry a prefix no model list can produce, and the
 * picker resolves them through `parseAggregatedOptionValue()` BEFORE the tier
 * lookup runs. The prefix never leaves the picker: selecting the row activates
 * the owning profile and hands the bare model id to `onSelect`.
 */

import {
  parseModelSelector,
  type AggregatedModel,
} from 'src/services/providerProfiles/aggregate.js'
import type { ProviderProfilesFile } from 'src/services/providerProfiles/profiles.js'
import { PROFILE_ENV_KEYS } from 'src/services/providerProfiles/envKeys.js'

/**
 * Marks an option value as an aggregated selector rather than a model id.
 *
 * A URL-ish scheme rather than a control character so it stays readable in
 * logs and debug output; no `/models` endpoint has ever served an id shaped
 * like this, and the picker checks for it before anything else looks at the
 * value.
 */
export const AGGREGATED_OPTION_PREFIX = 'occ-profile://'

type AggregatedOption = {
  value: string
  label: string
  description: string
}

/** What an aggregated option value decodes to. */
type AggregatedOptionTarget = {
  /** Selector exactly as `buildAggregatedModels` emitted it. */
  selector: string
  /** Model id as the owning provider serves it. */
  id: string
  /** Present only when the selector was qualified (an ambiguous id). */
  profile?: string
}

export function aggregatedOptionValue(selector: string): string {
  return `${AGGREGATED_OPTION_PREFIX}${selector}`
}

/**
 * Decode an option value, or undefined when it is an ordinary picker value.
 *
 * Pure and registry-free on purpose: the picker calls this on every focus
 * change and every render, and the selector already carries everything needed
 * to answer "which model id is this row" — only ACTIVATION needs the registry.
 */
export function parseAggregatedOptionValue(
  value: string | undefined,
): AggregatedOptionTarget | undefined {
  if (value === undefined) return undefined
  if (!value.startsWith(AGGREGATED_OPTION_PREFIX)) return undefined
  const selector = value.slice(AGGREGATED_OPTION_PREFIX.length)
  if (selector === '') return undefined
  const { id, profile } = parseModelSelector(selector)
  if (id === '') return undefined
  return {
    selector,
    id,
    ...(profile !== undefined ? { profile } : {}),
  }
}

/**
 * Which saved profiles exactly describe the provider configuration in force.
 *
 * `file.active` is only a record of the last profile switch. `/login`, the add
 * wizard and hand-edited settings can all replace the live configuration
 * without updating it, so trusting that pointer hides a stale profile from the
 * aggregated picker. Comparing only endpoints is also too broad: two profiles
 * on the same service with different credentials are distinct switch targets.
 *
 * Match the selected family's managed shape instead. Values from other families
 * may belong to the parent shell or a runtime wire mirror and are deliberately
 * preserved across activation; they do not make this profile a different
 * account. Every other profile remains visible and selectable.
 */
export function sessionOwnedProfiles(
  file: ProviderProfilesFile,
  session: {
    /** `settings.modelType`; absent means the Anthropic default. */
    modelType?: string | undefined
    /** settings.env over process.env — the configuration in force. */
    env: Readonly<Record<string, string | undefined>>
  },
): Set<string> {
  const owned = new Set<string>()
  const family = session.modelType ?? 'anthropic'
  for (const [name, profile] of Object.entries(file.profiles ?? {})) {
    if (!profile || typeof profile !== 'object') continue
    if (profile.modelType !== family) continue
    const managedKeys = PROFILE_ENV_KEYS[profile.modelType]
    if (!managedKeys) continue
    const profileEnv = profile.env ?? {}
    const sameConfiguration = managedKeys.every(
      key => (profileEnv[key] ?? '') === (session.env[key] ?? ''),
    )
    if (sameConfiguration) owned.add(name)
  }
  return owned
}

type BuildAggregatedOptionsParams = {
  /** Registry keys of the profiles that ARE the provider in use right now. */
  sessionProfiles?: ReadonlySet<string>
}

/**
 * Aggregated rows, in the order `buildAggregatedModels` produced them.
 *
 * A profile that describes the provider the session is already using
 * contributes NOTHING, whatever its individual ids are. Every aggregated row
 * means "selecting this switches provider", and there is no such thing as
 * switching to the provider you are on — so the row is at best noise and at
 * worst a lie about what selecting it does.
 *
 * This used to also require that the picker already offered the same id, which
 * left a residue nobody could explain: the picker's own catalog rows are
 * filtered (it drops the image, audio and realtime ids a chat session cannot
 * use) while a profile's `models` is the raw `/v1/models` answer, so precisely
 * the ids the picker had deliberately removed came back at the bottom of the
 * list, tagged with the name of the provider already in use. On one real
 * registry that was 5 rows of `gpt-image-*` / `gpt-4o-audio-preview` /
 * `gpt-4o-realtime-preview`. Dropping the id check and keeping only the
 * ownership one fixes it: ownership is the half that carries the meaning.
 *
 * Rows from every OTHER provider stay even when the id matches — the same
 * model on another account or relay is a legitimate thing to want, which is
 * what `ambiguous` and the `id (profile)` tag exist for.
 *
 * An unambiguous id renders as just the id — that is all the user needs to
 * pick it. An ambiguous one is tagged with its owning profile, because the id
 * alone genuinely does not say which credentials would answer.
 */
export function buildAggregatedModelOptions(
  models: readonly AggregatedModel[],
  params: BuildAggregatedOptionsParams = {},
): AggregatedOption[] {
  const sessionProfiles = params.sessionProfiles ?? new Set<string>()
  const options: AggregatedOption[] = []
  const seen = new Set<string>()
  for (const model of models) {
    if (sessionProfiles.has(model.profile)) continue
    const value = aggregatedOptionValue(model.selector)
    // buildAggregatedModels already emits one row per (id, profile), so this
    // only fires on a hand-edited registry; skipping beats a duplicate key.
    if (seen.has(value)) continue
    seen.add(value)
    options.push({
      value,
      label: model.ambiguous ? `${model.id} (${model.profile})` : model.id,
      description: describeAggregatedModel(model),
    })
  }
  return options
}

/**
 * Row subtitle. Always names the owning profile, including for unambiguous
 * rows whose label does not: selecting one switches provider, and that is not
 * something to discover afterwards.
 */
export function describeAggregatedModel(model: AggregatedModel): string {
  const name = model.displayName ? `${model.displayName} · ` : ''
  return `${name}${model.profile} profile · selecting switches provider`
}
