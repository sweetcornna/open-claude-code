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
import type { ProfileModelType } from './envKeys.js'

export { getMergedProviderEnv }

function currentProfileModelType():
  | { modelType: ProfileModelType }
  | { error: string } {
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
