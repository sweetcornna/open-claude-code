/**
 * Pure logic behind /provider-settings.
 *
 * Split from the panel the way `/model-settings` splits state.ts from its
 * .tsx: what the user typed, what the registry looks like, and how both read
 * back as text are all decidable without rendering Ink or touching the disk.
 * Every function here takes its inputs as arguments — the registry is loaded
 * by ./actions.ts, which owns all the side effects.
 *
 * Nothing in this file knows the provider list. Rows are derived from whatever
 * profiles the registry holds and from the env-key table in
 * `src/services/providerProfiles/envKeys.ts`, so a provider family added later
 * shows up here without an edit.
 */

import type { AggregatedModel } from 'src/services/providerProfiles/aggregate.js'
import {
  isProviderFamily,
  PROVIDER_FAMILIES,
  type ProviderFamily,
} from './providerFamilies.js'
import { PROFILE_ENV_KEYS } from 'src/services/providerProfiles/envKeys.js'
import {
  ALL_PROFILE_ENV_KEYS,
  type ProviderProfile,
  type ProviderProfilesFile,
} from 'src/services/providerProfiles/profiles.js'

export type ParsedCommand =
  | { kind: 'panel' }
  | { kind: 'list' }
  | { kind: 'models' }
  | { kind: 'overview' }
  | { kind: 'use'; name: string }
  | { kind: 'save'; name: string; notes?: string }
  | { kind: 'add'; name?: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'delete'; name: string }
  | { kind: 'refresh'; name: string }
  | { kind: 'aggregate'; name: string; enabled: boolean }
  | { kind: 'set-provider'; provider: ProviderFamily }
  | { kind: 'unset-provider' }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

const HELP_ARGS = new Set(['help', '--help', '-h', '?'])
const ON_WORDS = new Set(['on', 'true', 'yes', 'enable', 'enabled', '1'])
const OFF_WORDS = new Set(['off', 'false', 'no', 'disable', 'disabled', '0'])

/**
 * Verb aliases.
 *
 * `/provider` has shipped `save|use|list|delete` since profiles landed, and
 * those spellings keep working here — this command is the same registry with a
 * panel in front of it, not a second one.
 */
const VERB_ALIASES: Record<string, string> = {
  current: 'list',
  ls: 'list',
  show: 'list',
  switch: 'use',
  activate: 'use',
  rm: 'delete',
  remove: 'delete',
  fetch: 'refresh',
  models: 'models',
  new: 'add',
  mv: 'rename',
  summary: 'overview',
}

/**
 * Parse the argument form.
 *
 * Verbs are lowercased; profile NAMES are not. `isValidProfileName` accepts
 * upper case, so folding a name would quietly address a different profile —
 * or none at all — which reads exactly like the command doing nothing.
 */
export function parseArgs(args: string | undefined): ParsedCommand {
  const parts = (args ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { kind: 'panel' }

  const raw = parts[0]!.toLowerCase()
  if (HELP_ARGS.has(raw)) return { kind: 'help' }
  const verb = VERB_ALIASES[raw] ?? raw
  const name = parts[1]
  const rest = parts.slice(2)

  // A bare family name is the `/provider <family>` form, which this command
  // absorbed. Checked before the verb table so a profile that happens to be
  // called `openai` cannot shadow it: switching the family and activating a
  // profile are different requests, told apart by position — `use openai`
  // activates the profile, `openai` selects the family.
  if (isProviderFamily(verb)) return { kind: 'set-provider', provider: verb }
  if (verb === 'unset') return { kind: 'unset-provider' }

  switch (verb) {
    case 'list':
      return { kind: 'list' }
    case 'models':
      return { kind: 'models' }
    case 'overview':
      return { kind: 'overview' }
    case 'add':
      // The name is optional: `add` on its own is the "how do I do this"
      // answer, and `add <name>` additionally says whether that name is free.
      return name ? { kind: 'add', name } : { kind: 'add' }
    case 'rename': {
      const to = rest[0]
      return name && to
        ? { kind: 'rename', from: name, to }
        : {
            kind: 'error',
            message: 'Usage: /provider-settings rename <old> <new>',
          }
    }
    case 'use':
      return name
        ? { kind: 'use', name }
        : { kind: 'error', message: 'Usage: /provider-settings use <name>' }
    case 'save':
      return name
        ? {
            kind: 'save',
            name,
            ...(rest.length > 0 ? { notes: rest.join(' ') } : {}),
          }
        : {
            kind: 'error',
            message: 'Usage: /provider-settings save <name> [notes...]',
          }
    case 'delete':
      return name
        ? { kind: 'delete', name }
        : { kind: 'error', message: 'Usage: /provider-settings delete <name>' }
    case 'refresh':
      return name
        ? { kind: 'refresh', name }
        : { kind: 'error', message: 'Usage: /provider-settings refresh <name>' }
    case 'aggregate': {
      if (!name) {
        return {
          kind: 'error',
          message: 'Usage: /provider-settings aggregate <name> on|off',
        }
      }
      const flag = (rest[0] ?? '').toLowerCase()
      if (ON_WORDS.has(flag)) return { kind: 'aggregate', name, enabled: true }
      if (OFF_WORDS.has(flag))
        return { kind: 'aggregate', name, enabled: false }
      return {
        kind: 'error',
        message:
          `Say whether aggregation is on or off: ` +
          `/provider-settings aggregate ${name} on|off`,
      }
    }
    default:
      return {
        kind: 'error',
        message: `Unknown subcommand "${parts[0]}".\n\n${usage()}`,
      }
  }
}

export function usage(): string {
  return [
    'Usage:',
    '  /provider-settings                        open the panel',
    '  /provider-settings list                   print every saved profile',
    '  /provider-settings models                 print the aggregated model list',
    '  /provider-settings overview               who contributes what to it',
    '  /provider-settings use <name>             switch this session to a profile',
    '  /provider-settings save <name> [notes]    snapshot the current provider',
    '  /provider-settings add [name]             how to add one (needs the panel)',
    '  /provider-settings rename <old> <new>     rename a profile',
    '  /provider-settings aggregate <name> on    add its models to the union',
    '  /provider-settings aggregate <name> off   remove them again',
    '  /provider-settings refresh <name>         re-read its /models endpoint',
    '  /provider-settings delete <name>          drop the profile',
    '',
    // The other axis, absorbed from `/provider`: pick the family without
    // touching credentials. `use <name>` activates a profile; a bare family
    // name selects the family.
    `  /provider-settings <family>               select a provider family`,
    `                                            (${PROVIDER_FAMILIES.join(', ')})`,
    '  /provider-settings unset                  fall back to the environment',
  ].join('\n')
}

/**
 * The line `/provider` printed on its own: which provider this session would
 * talk to, and which saved profile it came from.
 *
 * `getAPIProvider()` answers the WIRE protocol rather than the vendor, which is
 * what this has always reported — a DeepSeek or OpenCode session on the
 * /messages lane reads as `firstParty` here. Kept as it was: the merge is not
 * the place to change what a long-standing line means.
 */
export function describeCurrentProvider(
  provider: string,
  activeProfile: string | undefined,
): string {
  return (
    `Current API provider: ${provider}` +
    (activeProfile ? ` (profile: ${activeProfile})` : '')
  )
}

export type ProviderRow = {
  /** Registry key — the identity `activateProfile()` resolves. */
  name: string
  modelType: string
  active: boolean
  aggregate: boolean
  /** Endpoint the profile points at, or undefined for the provider default. */
  endpoint?: string
  /** Whether a credential is SAVED. The value is never read out of here. */
  hasCredential: boolean
  modelCount: number
  notes?: string
}

/** Keys whose value is a secret. Matched on the suffix so `OPENAI_AUTH_MODE`
 * (a mode name) and `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (a number) stay out. */
const CREDENTIAL_KEY_PATTERN = /(?:API_KEY|AUTH_TOKEN)$/
const ENDPOINT_KEY_SUFFIX = '_BASE_URL'

/**
 * Env keys to inspect for this profile, most specific first.
 *
 * The profile's own family answers first, then the full union. The fallback is
 * not decoration: a profile written by an older version, or hand-edited, can
 * carry keys its recorded family no longer claims, and a row that silently
 * shows "(provider default endpoint)" for a profile that plainly has one reads
 * as the panel being wrong about the profile.
 */
export function profileEnvKeys(profile: ProviderProfile): readonly string[] {
  // Indexed loosely on purpose: the registry file is user-editable and a
  // hand-written modelType must degrade to "no family", not throw.
  const table: Record<string, readonly string[]> = PROFILE_ENV_KEYS
  const family = table[profile.modelType] ?? []
  const familySet = new Set(family)
  return [...family, ...ALL_PROFILE_ENV_KEYS.filter(k => !familySet.has(k))]
}

/** The endpoint this profile talks to, or undefined for the provider default. */
export function profileEndpoint(profile: ProviderProfile): string | undefined {
  const env = profile.env
  if (!env || typeof env !== 'object') return undefined
  for (const key of profileEnvKeys(profile)) {
    if (!key.endsWith(ENDPOINT_KEY_SUFFIX)) continue
    const value = env[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/**
 * Name of the credential key this profile carries, if any — never its value.
 *
 * An `*_API_KEY` outranks an `*_AUTH_TOKEN` even when the family table lists
 * the token first, matching `buildAnthropicAuthHeaders`: the model-list
 * request sends the credential as an API key, and a bearer token presented in
 * that header just 401s.
 */
export function profileCredentialKey(
  profile: ProviderProfile,
): string | undefined {
  const env = profile.env
  if (!env || typeof env !== 'object') return undefined
  const keys = profileEnvKeys(profile).filter(key => {
    const value = env[key]
    return CREDENTIAL_KEY_PATTERN.test(key) && !!value && value !== ''
  })
  return keys.find(key => key.endsWith('API_KEY')) ?? keys[0]
}

/**
 * One row per saved profile, ordered by registry key on codepoints.
 *
 * Same ordering rule as aggregate.ts, and for the same reason: `localeCompare`
 * would make the panel's row order depend on the machine's ICU collation.
 *
 * The file is user-editable and never deeply validated, so a garbage entry
 * degrades to a row that reads as empty rather than throwing at panel-open
 * time.
 */
export function buildProviderRows(file: ProviderProfilesFile): ProviderRow[] {
  const rows: ProviderRow[] = []
  for (const [name, profile] of Object.entries(file.profiles ?? {})) {
    if (!profile || typeof profile !== 'object') continue
    const models = Array.isArray(profile.models) ? profile.models : []
    const endpoint = profileEndpoint(profile)
    rows.push({
      name,
      modelType:
        typeof profile.modelType === 'string' ? profile.modelType : 'unknown',
      active: file.active === name,
      aggregate: profile.aggregate === true,
      ...(endpoint !== undefined ? { endpoint } : {}),
      hasCredential: profileCredentialKey(profile) !== undefined,
      modelCount: models.length,
      ...(typeof profile.notes === 'string' && profile.notes !== ''
        ? { notes: profile.notes }
        : {}),
    })
  }
  return rows.sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1))
}

/** How a row's credential column reads. Never the value, only its presence. */
export function describeCredential(row: ProviderRow): string {
  return row.hasCredential ? 'key saved' : 'no key (OAuth or env)'
}

export const EMPTY_REGISTRY_HINT =
  'No saved provider profiles yet. Snapshot the current one with: ' +
  '/provider-settings save <name>'

/**
 * The text form of the panel. Also what `/provider list` prints, so the two
 * entry points can never drift into describing the registry differently.
 */
export function describeProviderRows(
  rows: readonly ProviderRow[],
  aggregated: readonly AggregatedModel[],
): string {
  if (rows.length === 0) return EMPTY_REGISTRY_HINT

  const nameWidth = Math.max(...rows.map(r => r.name.length))
  const typeWidth = Math.max(...rows.map(r => r.modelType.length))
  const lines = [
    'Provider profiles — * is active, [x] joins the aggregated model list.',
    '',
  ]
  for (const row of rows) {
    lines.push(
      [
        row.active ? '*' : ' ',
        row.aggregate ? '[x]' : '[ ]',
        row.name.padEnd(nameWidth),
        row.modelType.padEnd(typeWidth),
        `${String(row.modelCount).padStart(3)} models`,
        describeCredential(row),
        row.endpoint ?? '(provider default endpoint)',
      ].join('  '),
    )
    if (row.notes) lines.push(`${' '.repeat(6)}${row.notes}`)
  }

  lines.push('', summarizeAggregate(rows, aggregated))
  return lines.join('\n')
}

/** One-line status of the union, including the "nobody opted in" case. */
export function summarizeAggregate(
  rows: readonly ProviderRow[],
  aggregated: readonly AggregatedModel[],
): string {
  const participating = rows.filter(row => row.aggregate)
  if (participating.length === 0) {
    return (
      'Aggregated list: empty — no profile has opted in. ' +
      'Turn one on with: /provider-settings aggregate <name> on'
    )
  }
  if (aggregated.length === 0) {
    // Naming them matters: "opted in but contributes nothing" is the one state
    // that reads as a broken toggle rather than a missing snapshot.
    const empty = participating.map(row => row.name).join(', ')
    return (
      `Aggregated list: empty — ${participating.length} profile(s) opted in ` +
      `but have no model snapshot yet. Run: ` +
      `/provider-settings refresh ${participating[0]?.name ?? '<name>'}` +
      (participating.length > 1 ? ` (waiting: ${empty})` : '')
    )
  }
  const ambiguous = aggregated.filter(model => model.ambiguous).length
  const shared =
    ambiguous > 0 ? `, ${ambiguous} of them served by more than one` : ''
  return (
    `Aggregated list: ${aggregated.length} models from ` +
    `${participating.length} profile(s)${shared}.`
  )
}

type AggregateOverview = {
  /** Participating profiles and what each actually contributes. */
  contributors: { profile: string; models: number }[]
  /** Ids more than one participating profile serves, with their owners. */
  collisions: { id: string; profiles: string[] }[]
}

/**
 * The union broken down by who contributes what.
 *
 * Counts come from the AGGREGATED rows, not from `row.modelCount`: the
 * snapshot is the provider's raw answer and the union drops what it cannot
 * use (a blank id, the same id listed twice). A profile whose two numbers
 * disagree is the one case where "61 models" in the row and "58 models" in the
 * picker are both true, and the picker's number is the one being explained
 * here.
 *
 * Collisions are exactly the `ambiguous` rows, regrouped: the union carries one
 * row per (id, profile) because that is what the picker lists, while the
 * question "which ids are shared" is asked once per id.
 */
function buildAggregateOverview(
  rows: readonly ProviderRow[],
  aggregated: readonly AggregatedModel[],
): AggregateOverview {
  const counts = new Map<string, number>()
  for (const model of aggregated) {
    counts.set(model.profile, (counts.get(model.profile) ?? 0) + 1)
  }
  const owners = new Map<string, string[]>()
  for (const model of aggregated) {
    if (!model.ambiguous) continue
    const existing = owners.get(model.id)
    if (existing) existing.push(model.profile)
    else owners.set(model.id, [model.profile])
  }
  return {
    contributors: rows
      .filter(row => row.aggregate)
      .map(row => ({ profile: row.name, models: counts.get(row.name) ?? 0 })),
    // buildAggregatedModels already ordered by id then profile, so both the
    // collision order and each collision's owner order are stable.
    collisions: [...owners].map(([id, profiles]) => ({ id, profiles })),
  }
}

function withOverflow(shown: string[], total: number): string {
  const rest = total - shown.length
  return rest > 0 ? [...shown, `+${rest} more`].join(' · ') : shown.join(' · ')
}

/**
 * The aggregated list as a whole: the headline, who feeds it, and which ids
 * two providers both answer to.
 *
 * Returned as lines so the panel can bound it (a registry with eight profiles
 * would otherwise push the rows off the screen) and the argument form can print
 * all of it. One implementation, because a panel that counts differently from
 * the command is a panel nobody can check.
 *
 * The collision list is the `ambiguous` flag made visible: those are precisely
 * the ids that render as `id (profile)` in `/model`, and until they are named
 * the tag looks like a rendering quirk rather than the answer to "these two are
 * not the same model".
 */
export function describeAggregateOverview(
  rows: readonly ProviderRow[],
  aggregated: readonly AggregatedModel[],
  limits: { contributors?: number; collisions?: number } = {},
): string[] {
  const lines = [summarizeAggregate(rows, aggregated)]
  const { contributors, collisions } = buildAggregateOverview(rows, aggregated)
  if (contributors.length > 0) {
    const shown = contributors
      .slice(0, limits.contributors ?? contributors.length)
      .map(entry => `${entry.profile} ${entry.models}`)
    lines.push(`  from: ${withOverflow(shown, contributors.length)}`)
  }
  if (collisions.length > 0) {
    const shown = collisions
      .slice(0, limits.collisions ?? collisions.length)
      .map(entry => `${entry.id} (${entry.profiles.join(', ')})`)
    lines.push(`  shared ids: ${withOverflow(shown, collisions.length)}`)
  }
  return lines
}

/**
 * The aggregated union as a table.
 *
 * Deliberately not the picker's one-line label: there the profile is a tag
 * that only appears when the id alone is not a selection, here it is a column
 * that always answers "whose credentials would serve this".
 */
export function describeAggregatedModels(
  aggregated: readonly AggregatedModel[],
): string {
  if (aggregated.length === 0) {
    return (
      'The aggregated model list is empty. Opt a profile in with: ' +
      '/provider-settings aggregate <name> on'
    )
  }
  const idWidth = Math.max(...aggregated.map(model => model.id.length))
  const profileWidth = Math.max(
    ...aggregated.map(model => model.profile.length),
  )
  return [
    `Aggregated models (${aggregated.length}) — these appear in /model:`,
    '',
    ...aggregated.map(model =>
      [
        `  ${model.id.padEnd(idWidth)}`,
        model.profile.padEnd(profileWidth),
        model.ambiguous ? '(shared id — tagged in the picker)' : '',
      ]
        .join('  ')
        .trimEnd(),
    ),
  ].join('\n')
}
