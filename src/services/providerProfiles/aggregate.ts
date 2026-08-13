/**
 * Aggregated model list — the union of several profiles' catalog snapshots
 * presented as one pickable list.
 *
 * This is the CHEAP version of "multiple providers at once": picking a model
 * switches the whole session to that model's owning profile (see
 * activateProfileForModel in ./activate.ts). Nothing here routes individual
 * requests per provider — aggregation is about the LIST, not about
 * simultaneous connections. Keeping that boundary explicit is what lets this
 * module stay pure data: no env writes, no client caches, no I/O.
 *
 * Two profiles can legitimately serve the same model id (an official endpoint
 * and a relay both answer to `gpt-5.4`). The id alone is then not a selection:
 * it does not say which credentials to use. So an id served by more than one
 * participating profile is marked `ambiguous` and gets a qualified selector.
 *
 * ## Selector grammar
 *
 *   <id>                  unique id, used verbatim
 *   <id>@<profile>        ambiguous id, qualified by its owning profile
 *
 * with every `@` INSIDE an id doubled (`@@`). The doubling is not decoration:
 * Vertex-style ids really do contain `@` (`text-bison@002`), and profile names
 * really do look like version suffixes (`002` passes isValidProfileName). Left
 * unescaped, `text-bison@002` would be indistinguishable from "model
 * text-bison, profile 002", and parseModelSelector — which is pure and has no
 * registry to consult — would have to guess. With doubling it never guesses:
 * profile names can never contain `@` (isValidProfileName), so the first
 * un-doubled `@` is always the separator. Ids without `@` (the overwhelming
 * majority) pass through untouched, so the common selector really is just the
 * bare id.
 */

import { isLikelyChatModel } from '../modelCatalog/merge.js'
import type { ProviderProfile, ProviderProfilesFile } from './profiles.js'

export type AggregatedModel = {
  /** Model id as the owning provider serves it. */
  id: string
  displayName?: string
  /** Name of the profile that serves it. */
  profile: string
  /** True when more than one profile serves this id. */
  ambiguous: boolean
  /** Stable selection token: `id` when unique, `id@profile` when ambiguous. */
  selector: string
}

const SEPARATOR = '@'

/**
 * Codepoint order, not localeCompare: the picker's order must not depend on
 * the machine's default locale (ICU collation differs between platforms and
 * even between Node/Bun builds), and model ids are ASCII-ish identifiers where
 * "sorted like the strings actually are" is the least surprising answer.
 */
function compareCodepoints(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Inverse of parseModelSelector. Exported so callers can build a selector
 * for an id/profile pair they did not get from buildAggregatedModels. */
export function formatModelSelector(id: string, profile?: string): string {
  const encoded = id.replaceAll(SEPARATOR, `${SEPARATOR}${SEPARATOR}`)
  return profile ? `${encoded}${SEPARATOR}${profile}` : encoded
}

/**
 * Split a selector back into id + optional profile.
 *
 * Round-trips every selector buildAggregatedModels emits, including ids that
 * contain `@`. A trailing separator with an empty profile (`gpt-5.4@`) is
 * never produced here; it is read as the unqualified id, which is the only
 * useful reading of a half-typed selector.
 */
export function parseModelSelector(selector: string): {
  id: string
  profile?: string
} {
  let id = ''
  let index = 0
  while (index < selector.length) {
    if (selector[index] !== SEPARATOR) {
      id += selector[index]
      index += 1
      continue
    }
    if (selector[index + 1] === SEPARATOR) {
      id += SEPARATOR
      index += 2
      continue
    }
    const profile = selector.slice(index + 1)
    return profile ? { id, profile } : { id }
  }
  return { id }
}

type SnapshotRow = {
  id: string
  displayName?: string
  profile: string
}

/**
 * The registry key — not `profile.name` — is the profile identity here,
 * because the key is what activateProfile() resolves. A hand-edited file where
 * the two disagree must still produce selectors that can be activated.
 */
function collectRows(file: ProviderProfilesFile): SnapshotRow[] {
  const rows: SnapshotRow[] = []
  for (const [name, profile] of Object.entries(file.profiles ?? {})) {
    if (!isParticipating(profile)) continue
    // Same defensive posture as loadProfilesFile: the file is user-editable
    // and never deeply validated, so a garbage snapshot degrades to "this
    // profile contributes nothing" instead of throwing at picker-open time.
    const models = Array.isArray(profile.models) ? profile.models : []
    const seen = new Set<string>()
    for (const model of models) {
      if (!model || typeof model !== 'object') continue
      const id = typeof model.id === 'string' ? model.id : ''
      // A provider that lists the same id twice must not make it look like a
      // cross-profile collision, so dedupe within the profile first.
      if (id === '' || !isLikelyChatModel(id) || seen.has(id)) continue
      seen.add(id)
      rows.push({
        id,
        profile: name,
        ...(typeof model.displayName === 'string' && model.displayName !== ''
          ? { displayName: model.displayName }
          : {}),
      })
    }
  }
  return rows
}

function isParticipating(profile: ProviderProfile | undefined): boolean {
  // `aggregate` is an explicit opt-in: a saved profile is a credential
  // snapshot first, and having once fetched its model list is not consent to
  // splice those models into every other provider's picker.
  return !!profile && typeof profile === 'object' && profile.aggregate === true
}

/**
 * Union of the participating profiles' snapshots.
 *
 * Ordering is total and content-derived — id first, then profile name, both by
 * codepoint — so the list never reshuffles between calls and never depends on
 * JSON key order (which changes whenever a profile is re-saved). The
 * profile-name tie-break also keeps a collision cluster adjacent in the
 * picker, which is exactly where the provider tag needs to be readable.
 *
 * A profile with no snapshot (`models` absent) contributes nothing. That is
 * not an error, and it cannot make another profile's id look ambiguous:
 * ambiguity counts profiles that actually contributed the id.
 */
export function buildAggregatedModels(
  file: ProviderProfilesFile,
): AggregatedModel[] {
  const rows = collectRows(file)
  const profileCountById = new Map<string, number>()
  for (const row of rows) {
    profileCountById.set(row.id, (profileCountById.get(row.id) ?? 0) + 1)
  }
  rows.sort(
    (a, b) =>
      compareCodepoints(a.id, b.id) || compareCodepoints(a.profile, b.profile),
  )
  return rows.map(row => {
    const ambiguous = (profileCountById.get(row.id) ?? 0) > 1
    return {
      id: row.id,
      ...(row.displayName !== undefined
        ? { displayName: row.displayName }
        : {}),
      profile: row.profile,
      ambiguous,
      selector: formatModelSelector(
        row.id,
        ambiguous ? row.profile : undefined,
      ),
    }
  })
}

/**
 * Resolve a selection token against the aggregated list.
 *
 * Pure on purpose: the activation half (./activate.ts) is the only thing that
 * should touch settings/env, and tests for the resolution rules should not
 * need a settings mock to run.
 */
export function resolveModelSelector(
  file: ProviderProfilesFile,
  selector: string,
): { model: AggregatedModel } | { error: string } {
  const { id, profile } = parseModelSelector(selector)
  const models = buildAggregatedModels(file)
  const matches = models.filter(model => model.id === id)

  if (matches.length === 0) {
    return {
      error:
        `No aggregated model "${id}". Only profiles marked for aggregation ` +
        `contribute models.`,
    }
  }
  if (profile !== undefined) {
    const match = matches.find(model => model.profile === profile)
    if (!match) {
      const owners = matches.map(model => model.profile).join(', ')
      return {
        error: `Profile "${profile}" does not serve model "${id}" (served by: ${owners}).`,
      }
    }
    return { model: match }
  }
  if (matches.length > 1) {
    const options = matches
      .map(model => `"${formatModelSelector(model.id, model.profile)}"`)
      .join(', ')
    return {
      error: `Model "${id}" is served by ${matches.length} profiles — select one of: ${options}.`,
    }
  }
  return { model: matches[0] }
}
