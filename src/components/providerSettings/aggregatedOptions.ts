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
import {
  PROFILE_ENV_KEYS,
  type ProfileModelType,
} from 'src/services/providerProfiles/envKeys.js'
import type { ProviderProfilesFile } from 'src/services/providerProfiles/profiles.js'

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
 * Which saved profiles describe the provider this session is ALREADY talking
 * to.
 *
 * Not `file.active`, or not only it. That pointer is written by
 * `activateProfile()` and by nothing else, so a session configured through
 * `/login` — or through the setup wizard, or by exported keys — has none at
 * all, and the de-duplication below was silently skipped for exactly those
 * users: every model of the provider they were using came back a second time
 * under its profile's name.
 *
 * The identity that does not depend on a pointer is the configuration itself: a
 * profile whose family matches `settings.modelType` and whose endpoint matches
 * the live one IS the provider in use, whether or not anything recorded that.
 * Only the endpoint is compared, not the credentials — two profiles on the same
 * endpoint with different keys are the same PROVIDER, and offering the session
 * its own models again is the thing being fixed.
 *
 * `file.active` is still honoured on top, so a session that did switch through
 * a profile keeps behaving exactly as before.
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
  if (file.active !== undefined) owned.add(file.active)
  const family = session.modelType ?? 'anthropic'
  for (const [name, profile] of Object.entries(file.profiles ?? {})) {
    if (!profile || typeof profile !== 'object') continue
    if (profile.modelType !== family) continue
    const keys = endpointKeysFor(family)
    const sameEndpoint = keys.every(
      key =>
        normalizeEndpoint(profile.env?.[key]) ===
        normalizeEndpoint(session.env[key]),
    )
    if (sameEndpoint) owned.add(name)
  }
  return owned
}

function endpointKeysFor(family: string): readonly string[] {
  // Indexed loosely: the registry file is user-editable and a hand-written
  // modelType must degrade to "no endpoint keys", not throw.
  const keys: readonly string[] =
    PROFILE_ENV_KEYS[family as ProfileModelType] ?? []
  return keys.filter(key => key.endsWith('_BASE_URL'))
}

/** Unset and "the default spelled out with a trailing slash" are one endpoint. */
function normalizeEndpoint(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '')
}

/**
 * The concrete models the picker's own rows already offer.
 *
 * Built by RESOLVING each option value, because the two sides are otherwise
 * not the same kind of thing: a tier row's value is an alias (`opus`,
 * `sonnet[1m]`) while every aggregated row carries a concrete id, so comparing
 * them raw meant the guard could essentially never fire for tier rows — which
 * is how a session on a saved profile still saw its own models listed again.
 *
 * The resolver is injected, and every call is guarded: resolution reaches the
 * model-provider chain, which throws for providers that require configuration
 * (Gemini's does) and for the "no preference" row on a session with no
 * credentials. A row occ cannot resolve simply does not participate in
 * de-duplication; it must never take the picker down.
 */
export function offeredModelIds(
  values: readonly string[],
  resolve: (value: string) => string | undefined,
): Set<string> {
  const ids = new Set<string>()
  for (const value of values) {
    try {
      const id = resolve(value)
      if (id) ids.add(id)
    } catch {
      // Unresolvable row: not a duplicate of anything we can name.
    }
  }
  return ids
}

type BuildAggregatedOptionsParams = {
  /**
   * Concrete model ids the picker already offers, resolved from its own rows
   * — see offeredModelIds. Raw option values do not answer this.
   */
  existingModelIds?: ReadonlySet<string>
  /** Registry keys of the profiles that ARE the provider in use right now. */
  sessionProfiles?: ReadonlySet<string>
}

/**
 * Aggregated rows, in the order `buildAggregatedModels` produced them.
 *
 * A row is dropped when both halves of "pure duplicate" hold: it comes from a
 * profile that describes the provider the session is already using, AND the
 * picker already offers that model. Rows from every OTHER provider stay even
 * when the id matches — the same model on another account or relay is a
 * legitimate thing to want, which is what `ambiguous` and the `id (profile)`
 * tag exist for.
 *
 * An unambiguous id renders as just the id — that is all the user needs to
 * pick it. An ambiguous one is tagged with its owning profile, because the id
 * alone genuinely does not say which credentials would answer.
 */
export function buildAggregatedModelOptions(
  models: readonly AggregatedModel[],
  params: BuildAggregatedOptionsParams = {},
): AggregatedOption[] {
  const existing = params.existingModelIds ?? new Set<string>()
  const sessionProfiles = params.sessionProfiles ?? new Set<string>()
  const options: AggregatedOption[] = []
  const seen = new Set<string>()
  for (const model of models) {
    if (sessionProfiles.has(model.profile) && existing.has(model.id)) continue
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
