/**
 * Provider profiles — cc-switch-style named provider configurations.
 *
 * A profile snapshots "which provider am I talking to and how" (modelType +
 * the provider-managed env keys + the per-tier model settings). Activation is
 * a whole-shape write, not a patch: every managed key is first cleared, then
 * the profile's keys are applied — so switching never leaves another
 * provider's endpoint or key behind (the failure mode single-slot editing
 * had). A Claude-OAuth profile is simply `modelType: 'anthropic'` with empty
 * env, which clears all third-party overrides and falls back to OAuth.
 *
 * `settings.modelSettings` is part of the snapshot for the same reason the
 * endpoint is: those values are PROVIDER-SHAPED. tierPersistence.ts seeds them
 * from the model family behind each tier — DeepSeek's row is `max` effort and
 * a 1M window, GPT's is `xhigh`/272k, Claude opus·fable `xhigh`/1M — so a
 * switch that restored the endpoint and left the previous provider's row in
 * place handed the new provider numbers its models were never measured
 * against. That is the same defect `/logout` was fixed for in 2.38.0 (see
 * commands/logout/resetProviderConfig.ts); this closes the `/provider use`
 * half of it.
 *
 * Minimal-intrusion invariant (borrowed from cc-switch): profiles are a
 * layer ABOVE settings.json. The live settings file stays a self-contained,
 * ordinary configuration — deleting provider-profiles.json loses only the
 * saved snapshots, never the working setup.
 *
 * Storage: `occConfigPath('provider-profiles.json')`, chmod 0600 (profiles
 * carry API keys — same plaintext posture as settings.env today; moving
 * secrets into secureStorage is the planned follow-up, see
 * docs/superpowers/plans/2026-08-02-quad-tasks-architecture.md 任务三).
 *
 * Cloud providers (bedrock/vertex/foundry) are deliberately out of scope:
 * they are env-only by design (see src/commands/provider.ts) and their
 * credentials live in external toolchains, not settings.env.
 */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { readFileSync } from 'fs'
import { dirname } from 'path'
import { occConfigPath } from 'src/config/paths.js'
import type { CatalogModel } from 'src/services/modelCatalog/types.js'
import {
  MODEL_SETTINGS_SLOTS,
  type ModelSettingsSlot,
} from 'src/utils/model/modelTier.js'
import type { TierEffort } from 'src/utils/model/tierDefaults.js'
import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import {
  ALL_PROFILE_ENV_KEYS,
  PROFILE_ENV_KEYS,
  type ProfileModelType,
} from './envKeys.js'

export { ALL_PROFILE_ENV_KEYS } from './envKeys.js'

/**
 * settings.env over process.env — the same merged view /provider uses.
 * Lives here (not activate.ts) so read-only consumers like getAuthStatus can
 * import it without transitively loading the OpenAI/Grok client modules that
 * activation needs for cache-clearing.
 */
export function getMergedProviderEnv(): Record<string, string> {
  const merged: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  )
  const settings = getSettings_DEPRECATED()
  if (settings?.env) Object.assign(merged, settings.env)
  return merged
}

/** One slot's overrides, mirroring `settings.modelSettings[slot]`. */
export type ProfileTierSettings = {
  effort?: TierEffort
  contextTokens?: number
}

/** The `settings.modelSettings` shape, as a profile stores it. */
export type ProfileModelSettings = Partial<
  Record<ModelSettingsSlot, ProfileTierSettings>
>

const TIER_EFFORTS: readonly TierEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/**
 * Read an unknown `modelSettings` blob into the shape activation may write.
 *
 * Validated rather than cast, unlike `env`, because the two are not equally
 * forgiving on the way out: settings.env is an untyped string map, while
 * `settings.modelSettings` is a zod enum, and envKeys.ts's header records what
 * a value that enum rejects costs. Per-field `.catch(undefined)` keeps a bad
 * value from taking the whole settings file down today, but it degrades
 * silently — dropping the value here means the profile file stays the thing
 * that is obviously wrong.
 *
 * Fail-soft in the same direction as loadProfilesFile(): an unreadable slot is
 * skipped, never thrown over. A slot left with neither axis is dropped
 * entirely, so "configured" and "present" cannot disagree downstream.
 */
export function sanitizeProfileModelSettings(
  value: unknown,
): ProfileModelSettings | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const result: ProfileModelSettings = {}
  for (const slot of MODEL_SETTINGS_SLOTS) {
    const raw = source[slot]
    if (!raw || typeof raw !== 'object') continue
    const { effort, contextTokens } = raw as Record<string, unknown>
    const tier: ProfileTierSettings = {}
    if (
      typeof effort === 'string' &&
      (TIER_EFFORTS as readonly string[]).includes(effort)
    ) {
      tier.effort = effort as TierEffort
    }
    if (
      typeof contextTokens === 'number' &&
      Number.isInteger(contextTokens) &&
      contextTokens > 0
    ) {
      tier.contextTokens = contextTokens
    }
    if (tier.effort !== undefined || tier.contextTokens !== undefined) {
      result[slot] = tier
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export type ProviderProfile = {
  name: string
  modelType: ProfileModelType
  /** Provider-managed env keys to write into settings.env on activation. */
  env: Record<string, string>
  notes?: string
  /**
   * Per-tier thinking effort and context window at save time.
   *
   * Optional, and it stays optional: a profile written by 2.38.3 or earlier
   * has none, and loadProfilesFile() must keep parsing those files
   * unchanged. Absent
   * means "this profile never recorded a preference", which activation answers
   * by clearing the slots rather than by leaving the previous provider's — see
   * buildActivationModelSettingsPatch.
   */
  modelSettings?: ProfileModelSettings
  /**
   * Catalog snapshot, ids exactly as the provider serves them.
   *
   * Optional, and it stays optional: every profile written by an earlier
   * version lacks this field, and loadProfilesFile() must keep parsing those
   * files unchanged. Absent means "no snapshot yet", never "no models".
   */
  models?: CatalogModel[]
  /** When true, this profile's models join the aggregated list. */
  aggregate?: boolean
  createdAt: string
  updatedAt: string
}

export type ProviderProfilesFile = {
  version: 1
  active?: string
  profiles: Record<string, ProviderProfile>
}

export function profilesFilePath(): string {
  return occConfigPath('provider-profiles.json')
}

const EMPTY_FILE: ProviderProfilesFile = { version: 1, profiles: {} }

export function loadProfilesFile(): ProviderProfilesFile {
  let content: string
  try {
    content = readFileSync(profilesFilePath(), 'utf8')
  } catch {
    return { ...EMPTY_FILE, profiles: {} }
  }
  try {
    const parsed = JSON.parse(content) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return { ...EMPTY_FILE, profiles: {} }
    }
    const record = parsed as Record<string, unknown>
    const profiles =
      record.profiles && typeof record.profiles === 'object'
        ? (record.profiles as Record<string, ProviderProfile>)
        : {}
    return {
      version: 1,
      profiles,
      ...(typeof record.active === 'string' ? { active: record.active } : {}),
    }
  } catch {
    // Corrupt file: fail soft with an empty registry rather than blocking
    // provider switching. saveProfilesFile() will rewrite it wholesale.
    return { ...EMPTY_FILE, profiles: {} }
  }
}

export function saveProfilesFile(file: ProviderProfilesFile): void {
  const target = profilesFilePath()
  mkdirSync(dirname(target), { recursive: true })
  // tmp + rename so a crash mid-write never truncates the registry
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, target)
  // rename preserves the tmp file's 0600; enforce anyway for pre-existing files
  try {
    chmodSync(target, 0o600)
  } catch {
    // best-effort on platforms without POSIX perms
  }
}

/** Profile names are used as CLI arguments — keep them shell-friendly. */
export function isValidProfileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
}

export function captureProfile(params: {
  name: string
  modelType: ProfileModelType
  /** Merged env to snapshot from (settings.env over process.env). */
  mergedEnv: Record<string, string>
  notes?: string
  /**
   * Live `settings.modelSettings` to snapshot.
   *
   * Re-read on every save and NOT carried over from `existing`, which is the
   * opposite of how `models`/`aggregate` behave below — deliberately. Those two
   * are a cache and a switch that belong to the profile; effort and context
   * window are session configuration in exactly the sense the endpoint and the
   * key are, and `save <name>` over an existing name is the user saying "record
   * what I am running now". Carrying the old values forward would make a
   * re-save the one way to keep a stale row alive.
   */
  modelSettings?: ProfileModelSettings
  /** Catalog snapshot; omit to keep whatever `existing` already carries. */
  models?: CatalogModel[]
  /** Aggregation opt-in; omit to keep whatever `existing` already carries. */
  aggregate?: boolean
  existing?: ProviderProfile
}): ProviderProfile {
  const env: Record<string, string> = {}
  for (const key of PROFILE_ENV_KEYS[params.modelType]) {
    const value = params.mergedEnv[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  const modelSettings = sanitizeProfileModelSettings(params.modelSettings)
  // Model list and aggregation opt-in survive a re-save (`/provider save` over
  // an existing name re-snapshots credentials, and losing the catalog there
  // would silently drop the profile out of the aggregated picker). `??` and
  // not `||` on purpose: an explicit `[]`/`false` is a real "clear it".
  const models = params.models ?? params.existing?.models
  const aggregate = params.aggregate ?? params.existing?.aggregate
  const now = new Date().toISOString()
  return {
    name: params.name,
    modelType: params.modelType,
    env,
    ...(params.notes ? { notes: params.notes } : {}),
    ...(modelSettings !== undefined ? { modelSettings } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(aggregate !== undefined ? { aggregate } : {}),
    createdAt: params.existing?.createdAt ?? now,
    updatedAt: now,
  }
}

/**
 * Update only the aggregation-facing fields of a saved profile.
 *
 * Deliberately not captureProfile(): refreshing a model list or flipping the
 * aggregate switch must not re-snapshot credentials from the live session,
 * which would rewrite a profile's env with whatever provider happens to be
 * active right now. Catalogs refresh far more often than credentials change.
 */
export function updateProfileCatalog(
  name: string,
  patch: { models?: CatalogModel[]; aggregate?: boolean },
): { profile: ProviderProfile } | { error: string } {
  const file = loadProfilesFile()
  const existing = file.profiles[name]
  if (!existing) return { error: `Unknown profile "${name}".` }
  const profile: ProviderProfile = {
    ...existing,
    ...(patch.models !== undefined ? { models: patch.models } : {}),
    ...(patch.aggregate !== undefined ? { aggregate: patch.aggregate } : {}),
    updatedAt: new Date().toISOString(),
  }
  file.profiles[name] = profile
  saveProfilesFile(file)
  return { profile }
}

/**
 * Rename decided before anything is written.
 *
 * A rename is a KEY MOVE, not a field edit: the registry key is the identity
 * `activateProfile()` resolves and the one `buildAggregatedModels()` puts in
 * every selector, so the record's own `name` field trailing behind would leave
 * `listProfiles()` reporting a name nothing can activate. Both move together
 * here.
 *
 * Two cases the caller must not be left to discover:
 *   - the target name is taken. Overwriting would delete another provider's
 *     endpoint and key, and the registry is the only copy of both.
 *   - the profile is the ACTIVE one. Only `file.active` points at it — the live
 *     configuration is in settings.env and carries no profile name at all — so
 *     moving the pointer is the whole of it. Nothing is re-activated: the
 *     session is already running on exactly these values.
 */
export function planProfileRename(
  file: ProviderProfilesFile,
  from: string,
  to: string,
  now: string,
): { file: ProviderProfilesFile; wasActive: boolean } | { error: string } {
  const existing = file.profiles?.[from]
  if (!existing) return { error: `Unknown profile "${from}".` }
  if (to === from) return { error: `"${from}" already has that name.` }
  if (!isValidProfileName(to)) {
    return {
      error: `Invalid profile name "${to}" (use letters, digits, ".", "_", "-"; max 64 chars).`,
    }
  }
  if (file.profiles[to]) {
    return {
      error:
        `A profile named "${to}" already exists. Delete it first or pick ` +
        `another name — renaming onto it would drop its endpoint and key.`,
    }
  }
  // Rebuilt in place rather than delete+append so the renamed profile keeps its
  // position in the file and the diff stays one entry wide.
  const profiles: Record<string, ProviderProfile> = {}
  for (const [key, profile] of Object.entries(file.profiles)) {
    if (key === from) {
      profiles[to] = { ...existing, name: to, updatedAt: now }
      continue
    }
    profiles[key] = profile
  }
  const wasActive = file.active === from
  return {
    file: {
      version: 1,
      profiles,
      ...(file.active !== undefined
        ? { active: wasActive ? to : file.active }
        : {}),
    },
    wasActive,
  }
}

export function renameProfile(
  from: string,
  to: string,
): { renamed: true; wasActive: boolean } | { error: string } {
  const planned = planProfileRename(
    loadProfilesFile(),
    from,
    to,
    new Date().toISOString(),
  )
  if ('error' in planned) return planned
  saveProfilesFile(planned.file)
  return { renamed: true, wasActive: planned.wasActive }
}

/**
 * Compute the settings.env patch that activates a profile: every managed key
 * explicitly cleared (undefined → deletion under updateSettingsForSource's
 * merge), then the profile's own keys overlaid.
 */
export function buildActivationEnvPatch(
  profile: ProviderProfile,
): Record<string, string | undefined> {
  const patch: Record<string, string | undefined> = {}
  for (const key of ALL_PROFILE_ENV_KEYS) {
    patch[key] = undefined
  }
  for (const [key, value] of Object.entries(profile.env)) {
    patch[key] = value
  }
  return patch
}

/**
 * Compute the `settings.modelSettings` patch that activates a profile.
 *
 * Same whole-shape idiom as buildActivationEnvPatch, and for the same reason:
 * updateSettingsForSource deep-merges, so a patch naming only the slots this
 * profile configured would leave the previous provider's other slots — and its
 * other AXIS within a shared slot — steering the new one. Every slot is
 * therefore named, and within a restored slot both axes are, `undefined`
 * meaning deletion under that merge.
 *
 * **A profile with no stored settings clears the slots rather than leaving
 * them.** This is the decision worth stating outright, because both answers
 * lose something. Leaving them is the bug: the values were seeded from the
 * *previous* provider's model family, so a 2.38.3-era profile would keep
 * inheriting DeepSeek's `max`/1M row onto GPT models. Clearing them means an
 * old profile activates onto occ's family defaults for the models it just
 * restored — which is what `getTierDefaults` computes from those very models,
 * and what `/logout` already does for the same reason. The deciding argument
 * is neither of those, though: clearing makes activation depend only on the
 * profile. An outcome that differed by whether the profile happened to predate
 * this field would be a worse rough edge than the one being closed, because
 * nothing on screen says which kind of profile you have.
 *
 * `/provider save <name>` over the old name records the live values and the
 * profile stops being one of the old kind.
 */
export function buildActivationModelSettingsPatch(
  profile: ProviderProfile,
): Record<ModelSettingsSlot, ProfileTierSettings | undefined> {
  // Sanitized again on the way out, not only on the way in at capture. The
  // registry is a 0600 JSON file a user can edit and loadProfilesFile() casts
  // it without validating, so this is the one point where a hand-written value
  // would reach the settings schema.
  const settings = sanitizeProfileModelSettings(profile.modelSettings)
  const patch = {} as Record<ModelSettingsSlot, ProfileTierSettings | undefined>
  for (const slot of MODEL_SETTINGS_SLOTS) {
    const stored = settings?.[slot]
    patch[slot] =
      stored?.effort !== undefined || stored?.contextTokens !== undefined
        ? { effort: stored.effort, contextTokens: stored.contextTokens }
        : undefined
  }
  return patch
}
