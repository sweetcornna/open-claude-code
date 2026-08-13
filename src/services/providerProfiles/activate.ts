/**
 * Profile activation & capture — the side-effectful half of provider
 * profiles. Pure data shapes live in ./profiles.ts; this module owns the
 * settings/process.env/client-cache orchestration, mirroring the exact write
 * idiom ConsoleOAuthFlow uses so both paths stay behaviorally identical.
 */

import { clearOpenAIClientCache } from 'src/services/api/openai/client.js'
import { clearGrokClientCache } from 'src/services/api/grok/client.js'
import { applyConfigEnvironmentVariables } from 'src/utils/config/managedEnv.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { isOpencodeSessionActive } from 'src/utils/model/opencodeWire.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from 'src/utils/settings/settings.js'
import {
  buildActivationEnvPatch,
  buildActivationModelSettingsPatch,
  captureProfile,
  getMergedProviderEnv,
  isValidProfileName,
  loadProfilesFile,
  saveProfilesFile,
  type ProviderProfile,
} from './profiles.js'
import { resolveModelSelector, type AggregatedModel } from './aggregate.js'
import { SESSION_KIND_ENV_KEYS, type ProfileModelType } from './envKeys.js'

export { getMergedProviderEnv }

function currentProfileModelType():
  | { modelType: ProfileModelType }
  | { error: string } {
  // Asked BEFORE getAPIProvider(), which answers a different question. That one
  // reports the wire protocol, and for OpenCode the wire is whatever lane the
  // configured model implies — 'firstParty' on /messages, 'openai' otherwise.
  // Saving under that answer captures the lane's ANTHROPIC_*/OPENAI_* keys,
  // which on an OpenCode session hold values the mirror wrote, including an
  // access token that expires within the hour. The profile has to record what
  // the user configured (the OPENCODE_* keys), not what the mirror derived.
  if (isOpencodeSessionActive()) return { modelType: 'opencode' }

  // Persisted modelType answers provider ownership; getAPIProvider answers the
  // wire protocol. DeepSeek's default Anthropic-compatible lane reports
  // firstParty even though the user configured and must snapshot OPENAI_* keys.
  const persistedModelType = getSettingsForSource('userSettings')?.modelType
  if (persistedModelType) return { modelType: persistedModelType }

  const provider = getAPIProvider()
  switch (provider) {
    case 'firstParty':
      return { modelType: 'anthropic' }
    case 'openai':
    case 'gemini':
    case 'grok':
      return { modelType: provider }
    default:
      return {
        error:
          `Provider "${provider}" is env-only (cloud toolchain credentials) ` +
          `and cannot be saved as a profile.`,
      }
  }
}

export function saveCurrentAsProfile(params: {
  name: string
  notes?: string
  aggregate?: boolean
  setActive?: boolean
}): { profile: ProviderProfile } | { error: string } {
  if (!isValidProfileName(params.name)) {
    return {
      error: `Invalid profile name "${params.name}" (use letters, digits, ".", "_", "-"; max 64 chars).`,
    }
  }
  const typed = currentProfileModelType()
  if ('error' in typed) return typed

  const file = loadProfilesFile()
  const profile = captureProfile({
    name: params.name,
    modelType: typed.modelType,
    mergedEnv: getMergedProviderEnv(),
    // `userSettings` only, matching tierSettings.ts: project and policy layers
    // are not this user's choice to snapshot, and activation writes back into
    // userSettings, so capturing a merged value would promote someone else's
    // layer into the user's own settings.json on the next switch.
    modelSettings: getSettingsForSource('userSettings')?.modelSettings,
    notes: params.notes,
    aggregate: params.aggregate,
    existing: file.profiles[params.name],
  })
  file.profiles[params.name] = profile
  if (params.setActive) file.active = params.name
  saveProfilesFile(file)
  return { profile }
}

export function activateProfile(
  name: string,
): { profile: ProviderProfile } | { error: string } {
  const file = loadProfilesFile()
  const profile = file.profiles[name]
  if (!profile) {
    const known = Object.keys(file.profiles).sort().join(', ') || '(none)'
    return { error: `Unknown profile "${name}". Saved profiles: ${known}` }
  }

  // Note what this deliberately does not reach: credentials pinned for web
  // search. The patch below clears the union of EVERY family's env keys before
  // applying the target's, which is right for the account plane and was exactly
  // why merely switching profiles used to take the user's search key with it.
  // Those live in services/search/searchCredentialStore.ts instead — a separate
  // file, so the independence does not rely on this list staying correct.
  //
  // Nor does it reach the env overrides. `CLAUDE_CODE_EFFORT_LEVEL` and
  // `CLAUDE_CODE_MAX_CONTEXT_TOKENS` sit ABOVE the per-tier layer on purpose
  // (tierSettings.ts's header: they are the last-resort correction scripts and
  // CI rely on), and restoring a profile must not reorder that. So the context
  // key keeps moving with settings.env — it is in PROFILE_ENV_KEYS for every
  // family and therefore cleared-then-restored like any other managed key — and
  // the effort key is not managed at all: nothing in occ writes it, so a value
  // in the environment is the user's own and outranks whatever is restored
  // below, exactly as it did before.
  const envPatch = buildActivationEnvPatch(profile)
  const previousManagedEnv = {
    ...(getSettingsForSource('userSettings')?.env ?? {}),
  }
  // Env and per-tier settings go in ONE write. Two writes would mean two
  // settings-file rewrites and two cache resets for one logical switch, and a
  // failure between them would leave a session holding one provider's endpoint
  // and another's context window — the exact state this is closing.
  //
  // Global `effortLevel` is owned independently by `/effort`, not by a
  // provider profile. Activation therefore neither snapshots nor deletes it;
  // `/effort auto` is the explicit operation that exposes per-slot policy.
  const { error } = updateSettingsForSource('userSettings', {
    modelType: profile.modelType,
    env: envPatch,
    modelSettings: buildActivationModelSettingsPatch(profile),
  } as unknown as Parameters<typeof updateSettingsForSource>[1])
  if (error) return { error: `Failed to save settings: ${error.message}` }

  // settings.env is occ-owned, but process.env is shared with the parent shell.
  // Clear only values still owned by the settings layer we just replaced;
  // shell values and later manual overrides must survive the profile switch.
  //
  // Except the session-kind markers, which are reclaimed on sight. They have no
  // legitimate shell origin to protect and are read as mode switches on every
  // client build, so an orphaned one reroutes the session rather than merely
  // lingering — see SESSION_KIND_ENV_KEYS for the failure it produced.
  for (const [key, value] of Object.entries(envPatch)) {
    if (value !== undefined) {
      process.env[key] = value
      continue
    }
    const current = process.env[key]
    if (current === undefined) continue
    if (SESSION_KIND_ENV_KEYS.has(key) || current === previousManagedEnv[key]) {
      delete process.env[key]
    }
  }
  applyConfigEnvironmentVariables()
  // Cached clients hold pre-switch baseURL/key; force rebuild on next use.
  // The ChatGPT auth file is deliberately NOT removed on switch-away — the
  // profile clears OPENAI_AUTH_MODE, which makes the file inert, and keeping
  // it means switching back needs no re-login (cc-switch's
  // preserve_codex_official_auth_on_switch semantics).
  clearOpenAIClientCache()
  clearGrokClientCache()

  file.active = name
  saveProfilesFile(file)
  return { profile }
}

/**
 * Activate the profile that owns an aggregated model.
 *
 * This is the whole "cheap version" of multi-provider: selecting a model from
 * the union list switches the session to that model's provider. It delegates
 * to activateProfile() rather than reimplementing the switch — the whole-shape
 * env write plus client-cache clear is the part that is easy to get subtly
 * wrong, and there must be exactly one copy of it.
 *
 * The caller still owns "and now use this model id": the returned
 * AggregatedModel carries the id exactly as the provider serves it.
 */
export function activateProfileForModel(
  selector: string,
): { profile: ProviderProfile; model: AggregatedModel } | { error: string } {
  const resolved = resolveModelSelector(loadProfilesFile(), selector)
  if ('error' in resolved) return resolved
  // Second read inside activateProfile() is intentional: it keeps that
  // function's contract (name in, switch done) untouched for its other callers.
  const activated = activateProfile(resolved.model.profile)
  if ('error' in activated) return activated
  return { profile: activated.profile, model: resolved.model }
}

export function deleteProfile(
  name: string,
): { deleted: true } | { error: string } {
  const file = loadProfilesFile()
  if (!file.profiles[name]) {
    return { error: `Unknown profile "${name}".` }
  }
  delete file.profiles[name]
  if (file.active === name) delete file.active
  saveProfilesFile(file)
  return { deleted: true }
}

export function listProfiles(): {
  active?: string
  profiles: ProviderProfile[]
} {
  const file = loadProfilesFile()
  return {
    ...(file.active !== undefined ? { active: file.active } : {}),
    profiles: Object.values(file.profiles).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  }
}
