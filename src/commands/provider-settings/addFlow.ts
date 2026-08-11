/**
 * Adding a provider from the panel, decided without rendering.
 *
 * ## Adding ACTIVATES, and says so before it starts
 *
 * The setup wizard's save IS the activation: it writes settings.env
 * whole-shape (every other provider group cleared) and replays the patch onto
 * `process.env`. There is no version of "run the wizard but do not apply it" —
 * the model list it shows comes from credentials that only exist in its own
 * state, and everything after step 2 is a settings write.
 *
 * So the flow captures that result into a profile and LEAVES the session on
 * the new provider. The alternative — capture, then put the previous
 * configuration back — was rejected, and not because it is more work:
 *
 *   - the only honest way to restore is `activateProfile()`, and that needs a
 *     profile. `file.active` is not one: it records the last profile SWITCH,
 *     not what the session is running on now. A `/login` or a hand-edited
 *     settings.env after that switch leaves the pointer naming something the
 *     session stopped using, and "restoring" it would be a silent switch to a
 *     third configuration — strictly worse than an honest one to the provider
 *     the user just finished configuring.
 *   - a session that never came from a profile (plain Claude OAuth, exported
 *     keys, a hand-written settings.env) has nothing to restore at all, which
 *     is the common case for the very first `A`. A rollback that works
 *     sometimes is the half-restore this file exists to avoid.
 *
 * What the flow does instead is make the return trip real: when the live
 * configuration matches no saved profile, it offers to snapshot it first
 * (`saveCurrentAsProfile`, the same thing `save <name>` does). Then switching
 * back is Enter on a row, which is a mechanism that already exists and already
 * works, rather than a rollback invented for this screen.
 *
 * Nothing here enumerates providers: the menu is derived from whatever
 * `PROVIDER_SETUP_SPECS` holds, passed in as an argument so the pure layer
 * never imports the table (which would drag every provider's fetcher and OAuth
 * client into a `-p` run that only wants to print the registry).
 */

import {
  ALL_PROFILE_ENV_KEYS,
  isValidProfileName,
  type ProviderProfilesFile,
} from 'src/services/providerProfiles/profiles.js'

/** OpenAI's two wire lanes. Spelled locally so this module imports no specs. */
type AddWireApi = 'chat' | 'responses'

/**
 * The slice of a provider setup spec the menu reads.
 *
 * Structural rather than the spec type itself: `PROVIDER_SETUP_SPECS` is the
 * one table of providers and it grows without this file being edited, so what
 * matters here is that the fields exist, not which module declared them.
 */
export type SetupSpecView = {
  modelType: string
  /** False for specs that collect their endpoint on a screen of their own. */
  hasEndpointStep: boolean
  defaultBaseUrl: string
  title: (context: { wireApi?: AddWireApi; baseUrl?: string }) => string
}

export type AddProviderEntry<Kind extends string = string> = {
  kind: Kind
  /** Present only for the specs that have more than one lane. */
  wireApi?: AddWireApi
  /** Stable option value, and how the flow refers back to this entry. */
  value: string
  /** Menu label, taken from the spec's own heading. */
  label: string
  /** One line under the label: the family and where the form starts. */
  description: string
  /** Endpoint the wizard's step 1 opens on. */
  baseUrl: string
}

/**
 * A dimension the spec table cannot express: OpenAI is one spec but two
 * sessions, and which lane a profile speaks is not editable afterwards without
 * redoing the form. A kind absent here contributes exactly one entry, so a
 * provider added to the table later shows up with no edit here.
 */
const WIRE_LANES: Record<string, readonly AddWireApi[]> = {
  openai: ['chat', 'responses'],
}

/** Spec headings all end in " Setup"; the menu says that once, in its own header. */
function menuLabel(title: string): string {
  return title.replace(/\s+Setup$/, '')
}

/**
 * One menu row per addable (spec, lane).
 *
 * Specs without a step 1 are left out: they collect their endpoint and key on
 * screens of their own (the China presets pick both from a table), so entering
 * their wizard at step 1 would present a form that provider never uses.
 *
 * The endpoint is seeded from the spec's own default rather than from the live
 * session. Reading `process.env` here — which is what the login menu does,
 * where the user is REPLACING the current provider — would prefill the active
 * provider's endpoint and key into a form whose result is then saved under a
 * second name, so pressing Enter twice would duplicate the profile the user is
 * already on. Adding is about a provider the session is not using.
 */
export function addableProviderEntries<Kind extends string>(
  specs: Record<Kind, SetupSpecView>,
): AddProviderEntry<Kind>[] {
  const entries: AddProviderEntry<Kind>[] = []
  for (const [kind, spec] of Object.entries(specs) as [Kind, SetupSpecView][]) {
    if (!spec.hasEndpointStep) continue
    const lanes = WIRE_LANES[kind] ?? [undefined]
    for (const wireApi of lanes) {
      entries.push({
        kind,
        ...(wireApi ? { wireApi } : {}),
        value: wireApi ? `${kind}:${wireApi}` : kind,
        label: menuLabel(spec.title({ ...(wireApi ? { wireApi } : {}) })),
        description: `${spec.modelType} · ${spec.defaultBaseUrl}`,
        baseUrl: spec.defaultBaseUrl,
      })
    }
  }
  return entries
}

/**
 * The saved profile the session is already running, or undefined.
 *
 * "Already running" is defined as activation being a no-op: every managed key
 * holds exactly what the profile would write. That is the same comparison
 * `buildActivationEnvPatch` performs, so a match really does mean pressing
 * Enter on that row would change nothing — and a session carrying one extra
 * exported key genuinely is not that profile, which is why the comparison
 * covers the whole managed union rather than just the profile's own keys.
 *
 * Values are read but never returned; only the registry key comes back out.
 */
export function sessionProfileMatch(
  file: ProviderProfilesFile,
  mergedEnv: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const names = Object.keys(file.profiles ?? {}).sort()
  for (const name of names) {
    const profile = file.profiles[name]
    if (!profile || typeof profile !== 'object') continue
    const env = profile.env ?? {}
    const same = ALL_PROFILE_ENV_KEYS.every(
      key => (env[key] ?? '') === (mergedEnv[key] ?? ''),
    )
    if (same) return name
  }
  return undefined
}

/**
 * A free profile name built from `base`, for the "snapshot what is running
 * now" offer. The user never typed it, so it has to be shown in full on the
 * button rather than chosen behind their back.
 */
export function suggestSnapshotName(
  file: ProviderProfilesFile,
  base: string | undefined,
): string {
  const cleaned = (base ?? '').replace(/[^A-Za-z0-9._-]/g, '')
  const stem = isValidProfileName(cleaned) ? cleaned : 'current'
  const taken = new Set(Object.keys(file.profiles ?? {}))
  if (!taken.has(stem)) return stem
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${stem}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  return `${stem}-${Date.now()}`
}

/** Whether this name can become a new profile, with the reason when it cannot. */
export function validateNewProfileName(
  file: ProviderProfilesFile,
  name: string,
): { name: string } | { error: string } {
  const trimmed = name.trim()
  if (trimmed === '') return { error: 'Give the profile a name.' }
  if (!isValidProfileName(trimmed)) {
    return {
      error: `Invalid profile name "${trimmed}" (use letters, digits, ".", "_", "-"; max 64 chars).`,
    }
  }
  if (file.profiles?.[trimmed]) {
    return { error: `A profile named "${trimmed}" already exists.` }
  }
  return { name: trimmed }
}

/**
 * Where the flow is.
 *
 * `preserve` is conditional — see the header — and every step before `setup`
 * has written nothing, so Esc out of any of them leaves the registry and the
 * session exactly as they were.
 */
export type AddFlowState =
  | { step: 'kind' }
  | { step: 'preserve'; entry: AddProviderEntry; suggestion: string }
  | { step: 'name'; entry: AddProviderEntry; draft: string; error?: string }
  | { step: 'aggregate'; entry: AddProviderEntry; name: string }
  | {
      step: 'setup'
      entry: AddProviderEntry
      name: string
      aggregate: boolean
    }

export function beginAddFlow(): AddFlowState {
  return { step: 'kind' }
}

/**
 * Kind chosen. The offer to snapshot the running configuration is skipped when
 * it is already a profile — there is nothing to preserve and an extra screen
 * saying so is just an extra screen.
 */
export function afterKindChosen(
  entry: AddProviderEntry,
  session: { savedAs: string | undefined; suggestion: string },
): AddFlowState {
  if (session.savedAs !== undefined) {
    return { step: 'name', entry, draft: '' }
  }
  return { step: 'preserve', entry, suggestion: session.suggestion }
}

/** Preserve step answered, either way: on to naming the new profile. */
export function afterPreserveAnswered(
  state: Extract<AddFlowState, { step: 'preserve' }>,
): AddFlowState {
  return { step: 'name', entry: state.entry, draft: '' }
}

export function afterNameSubmitted(
  state: Extract<AddFlowState, { step: 'name' }>,
  file: ProviderProfilesFile,
): AddFlowState {
  const validated = validateNewProfileName(file, state.draft)
  if ('error' in validated) {
    return { ...state, error: validated.error }
  }
  return { step: 'aggregate', entry: state.entry, name: validated.name }
}

export function afterAggregateAnswered(
  state: Extract<AddFlowState, { step: 'aggregate' }>,
  aggregate: boolean,
): AddFlowState {
  return { step: 'setup', entry: state.entry, name: state.name, aggregate }
}

/** What `saveCurrentAsProfile` answered after the wizard wrote settings. */
type AddCapture = { modelType: string } | { error: string }

type AddOutcome = {
  /** Panel notice. Always says where the session ended up. */
  notice: string
  /** Whether to flip the new profile's aggregate opt-in. */
  enrollAggregate: boolean
  /** Whether to read its model list right away. */
  refreshCatalog: boolean
}

/**
 * What to say and what is left to do once the wizard has saved.
 *
 * A failed capture is not a failed setup: settings.env was written before this
 * runs, so the session is on the new provider either way and the notice has to
 * lead with that rather than with the registry.
 */
export function describeAddOutcome(input: {
  name: string
  aggregate: boolean
  capture: AddCapture
}): AddOutcome {
  const { name, aggregate, capture } = input
  if ('error' in capture) {
    return {
      notice:
        `This session is now using the provider you just set up, but it ` +
        `could not be saved as "${name}": ${capture.error}`,
      enrollAggregate: false,
      refreshCatalog: false,
    }
  }
  const head = `Added "${name}" (${capture.modelType}) and switched this session to it.`
  if (!aggregate) {
    return {
      notice: `${head} Space adds its models to the aggregated /model list.`,
      enrollAggregate: false,
      refreshCatalog: false,
    }
  }
  // A brand-new profile has no snapshot, so opting it in without reading the
  // endpoint would leave it contributing nothing — which reads as a broken
  // toggle rather than a missing snapshot.
  return {
    notice: `${head} Reading its model list for the aggregated /model list…`,
    enrollAggregate: true,
    refreshCatalog: true,
  }
}

/**
 * The argument form of `add`.
 *
 * There is no scriptable version of the setup form and there deliberately will
 * not be one: the thing it collects is a credential, and a credential passed as
 * a command argument lands in shell history and in every process listing on the
 * machine. So this answers with the two ways to get the same registry entry,
 * and validates the name against the registry while it is here — the panel
 * rejects the same names for the same reasons, and finding that out before
 * opening the form is worth the one line.
 */
export function describeNonInteractiveAdd(
  file: ProviderProfilesFile,
  name: string | undefined,
): string {
  const lines = [
    'Adding a provider runs the setup form, which collects a credential — ' +
      'and a credential passed as a command argument would land in your ' +
      'shell history. So there is no argument form for it.',
    '',
    'Either:',
    '  /provider-settings          then press A, which does the whole flow',
    '  /provider-settings save <name>   if this session is ALREADY talking ' +
      'to the provider you want to keep',
  ]
  if (name !== undefined) {
    const validated = validateNewProfileName(file, name)
    lines.push(
      '',
      'error' in validated
        ? validated.error
        : `The name "${validated.name}" is free.`,
    )
  }
  return lines.join('\n')
}
