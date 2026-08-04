/**
 * The account-plane reset half of logout.
 *
 * Split out of logout.tsx on purpose: this is the part with observable rules
 * (which keys go, what survives), and logout.tsx itself drags in telemetry,
 * secure storage and the OAuth stack the moment it is imported.
 *
 * Logout used to keep every third-party endpoint and key on the theory that
 * they are "configuration, not login state". That made `/logout` a no-op for
 * anyone not on Claude OAuth: the next launch went straight back out to the
 * same endpoint with the same key, in whichever mode (OAuth or API) had been
 * configured. An explicit logout resets the account.
 */

import {
  ALL_PROFILE_ENV_KEYS,
  loadProfilesFile,
  saveProfilesFile,
} from '../../services/providerProfiles/profiles.js'
import { saveGlobalConfig } from '../../utils/config/config.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

/**
 * Credential-bearing keys cleared on top of the provider-profile set.
 * `CLAUDE_CODE_OAUTH_TOKEN` belongs to no `/provider` family, but leaving it in
 * settings.env means the next launch is still logged in.
 */
const EXTRA_LOGOUT_ENV_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN'] as const

/** Every env key logout removes from settings, global config, and the process. */
export const LOGOUT_ENV_KEYS: readonly string[] = [
  ...new Set([...ALL_PROFILE_ENV_KEYS, ...EXTRA_LOGOUT_ENV_KEYS]),
]

/**
 * Drop every provider endpoint/key/model override written by `/login` or
 * `/provider use`, put `modelType` back to unset, and stop the live process
 * from seeing the values.
 *
 * Saved provider profiles are NOT touched — they are an explicit user snapshot
 * living a layer above settings (see providerProfiles/profiles.ts), so
 * `/provider use <name>` still restores a setup after logout. Only the *active*
 * pointer is dropped, because nothing is active any more.
 */
export function resetProviderConfiguration(): void {
  const envPatch: Record<string, string | undefined> = {}
  for (const key of LOGOUT_ENV_KEYS) {
    envPatch[key] = undefined
    delete process.env[key]
  }

  updateSettingsForSource('userSettings', {
    modelType: undefined,
    env: envPatch,
  } as unknown as Parameters<typeof updateSettingsForSource>[1])

  // ~/.occ.json carries its own env layer, applied on every launch
  // (applySafeConfigEnvironmentVariables). Provider keys parked there would
  // survive a settings.json reset otherwise.
  saveGlobalConfig(current => {
    if (!current.env) return current
    const env = { ...current.env }
    for (const key of LOGOUT_ENV_KEYS) delete env[key]
    return { ...current, env }
  })

  const profiles = loadProfilesFile()
  if (profiles.active !== undefined) {
    delete profiles.active
    saveProfilesFile(profiles)
  }
}
