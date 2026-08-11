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

type BuildAggregatedOptionsParams = {
  /** Values already present in the picker, so a row is not offered twice. */
  existingValues?: ReadonlySet<string>
  /** Registry key of the active profile, if any. */
  activeProfile?: string
}

/**
 * Aggregated rows, in the order `buildAggregatedModels` produced them.
 *
 * Rows the ACTIVE profile contributes are dropped when the picker already
 * lists that id: those come from the same endpoint the session is talking to
 * right now, so a second row would offer to "switch" to the provider already
 * in use. Rows from every other profile stay, because selecting one really
 * does change something.
 *
 * An unambiguous id renders as just the id — that is all the user needs to
 * pick it. An ambiguous one is tagged with its owning profile, because the id
 * alone genuinely does not say which credentials would answer.
 */
export function buildAggregatedModelOptions(
  models: readonly AggregatedModel[],
  params: BuildAggregatedOptionsParams = {},
): AggregatedOption[] {
  const existing = params.existingValues ?? new Set<string>()
  const options: AggregatedOption[] = []
  const seen = new Set<string>()
  for (const model of models) {
    if (
      params.activeProfile !== undefined &&
      model.profile === params.activeProfile &&
      existing.has(model.id)
    ) {
      continue
    }
    const value = aggregatedOptionValue(model.selector)
    // buildAggregatedModels already emits one row per (id, profile), so this
    // only fires on a hand-edited registry; skipping beats a duplicate key.
    if (seen.has(value) || existing.has(value)) continue
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
