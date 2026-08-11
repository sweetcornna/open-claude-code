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
  captureProfile,
  getMergedProviderEnv,
  isValidProfileName,
  loadProfilesFile,
  saveProfilesFile,
  type ProviderProfile,
} from './profiles.js'
import { resolveModelSelector, type AggregatedModel } from './aggregate.js'
import type { ProfileModelType } from './envKeys.js'

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
    notes: params.notes,
    existing: file.profiles[params.name],
  })
  file.profiles[params.name] = profile
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
  const envPatch = buildActivationEnvPatch(profile)
  const previousManagedEnv = {
    ...(getSettingsForSource('userSettings')?.env ?? {}),
  }
  const { error } = updateSettingsForSource('userSettings', {
    modelType: profile.modelType,
    env: envPatch,
  } as unknown as Parameters<typeof updateSettingsForSource>[1])
  if (error) return { error: `Failed to save settings: ${error.message}` }

  // settings.env is occ-owned, but process.env is shared with the parent shell.
  // Clear only values still owned by the settings layer we just replaced;
  // shell values and later manual overrides must survive the profile switch.
  for (const [key, value] of Object.entries(envPatch)) {
    if (value !== undefined) {
      process.env[key] = value
      continue
    }
    const current = process.env[key]
    if (current !== undefined && current === previousManagedEnv[key]) {
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
