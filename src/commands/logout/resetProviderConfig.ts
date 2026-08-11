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

/**
 * Every env key logout removes from settings, global config, and the process.
 *
 * Derived from ALL_PROFILE_ENV_KEYS, so a provider family added to the profile
 * table is logged out of for free — that is the point of deriving it. What it
 * cannot cover is credentials that are not env vars: the ChatGPT, Antigravity
 * and OpenCode tokens live in files, and removing those is async and therefore
 * logout.tsx's job, not this synchronous function's.
 */
export const LOGOUT_ENV_KEYS: readonly string[] = [
  ...new Set([...ALL_PROFILE_ENV_KEYS, ...EXTRA_LOGOUT_ENV_KEYS]),
]

/**
 * Drop every provider endpoint/key/model override written by `/login` or
 * `/provider use`, put `modelType` back to unset, and stop the live process
 * from seeing the values.
 *
 * `modelSettings` and the legacy flat `effortLevel` go too. Both look like
 * standalone preferences and are not: every value in them was either seeded by
 * the setup wizard from the *provider family* of the model behind each tier
 * (tierPersistence.ts) or tuned by the user against a model that this logout
 * just removed. Leaving them behind broke the next login in a way that was
 * invisible until much later — `buildModelStep` prefills the wizard's "Max
 * context tokens" and "Thinking effort" fields from whatever the five slots
 * agree on, and `buildTierSettings` skips seeding the new provider's family
 * defaults whenever anything is already configured. So logging out of DeepSeek
 * and configuring GPT handed every GPT tier DeepSeek's row — 1M context, `max`
 * effort — instead of 272k/`xhigh`, with the wizard showing those numbers as if
 * the user had chosen them.
 *
 * Saved provider profiles are NOT touched — they are an explicit user snapshot
 * living a layer above settings (see providerProfiles/profiles.ts), so
 * `/provider use <name>` still restores a setup after logout. Only the *active*
 * pointer is dropped, because nothing is active any more.
 *
 * Pinned web-search credentials are NOT touched either, and that is load-bearing
 * rather than incidental. LOGOUT_ENV_KEYS is derived from the provider-profile
 * table, and every search source used to read its key out of exactly those
 * variables — so this function was what silently dropped web search to the
 * keyless lane on every logout. The store (services/search/searchCredential
 * Store.ts) is a separate file this function has no reach into by construction,
 * which is the point: independence that depends on remembering to skip a key is
 * not independence. `/search-setting` removes them; logout says which were kept.
 */
export function resetProviderConfiguration(): void {
  const envPatch: Record<string, string | undefined> = {}
  for (const key of LOGOUT_ENV_KEYS) {
    envPatch[key] = undefined
    delete process.env[key]
  }

  updateSettingsForSource('userSettings', {
    modelType: undefined,
    modelSettings: undefined,
    effortLevel: undefined,
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
