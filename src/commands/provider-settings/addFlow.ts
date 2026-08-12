/**
 * Adding a provider from the panel, decided without rendering.
 *
 * The setup wizard's save activates the provider: it writes settings.env
 * whole-shape (every other provider group cleared) and replays the patch onto
 * `process.env`. The flow captures that result into the user-supplied profile
 * name and leaves the session on the new provider.
 *
 * Nothing here enumerates providers: the menu is derived from whatever
 * `PROVIDER_SETUP_SPECS` holds, passed in as an argument so the pure layer
 * never imports the table (which would drag every provider's fetcher and OAuth
 * client into a `-p` run that only wants to print the registry).
 */

import {
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

/** Every step before `setup` is side-effect free. */
export type AddFlowState =
  | { step: 'kind' }
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

/** Choosing a provider always asks the user to name the new profile next. */
export function afterKindChosen(entry: AddProviderEntry): AddFlowState {
  return { step: 'name', entry, draft: '' }
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
      refreshCatalog: false,
    }
  }
  const head = `Added "${name}" (${capture.modelType}) and switched this session to it.`
  if (!aggregate) {
    return {
      notice: `${head} Space adds its models to the aggregated /model list.`,
      refreshCatalog: false,
    }
  }
  // A brand-new profile has no snapshot, so opting it in without reading the
  // endpoint would leave it contributing nothing — which reads as a broken
  // toggle rather than a missing snapshot.
  return {
    notice: `${head} Reading its model list for the aggregated /model list…`,
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
