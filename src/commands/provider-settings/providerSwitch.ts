/**
 * Performing a provider FAMILY switch — the side-effectful half of
 * ./providerFamilies.ts, which explains what the axis is and why it is not the
 * same thing as activating a profile.
 *
 * The behaviour is carried over from `/provider` unchanged, including the
 * early return: a family that cannot answer yet is still selected (so the next
 * `/login` writes into the right place) and reported with the variables it is
 * waiting for.
 */

import { getMergedProviderEnv } from 'src/services/providerProfiles/profiles.js'
import { applyConfigEnvironmentVariables } from 'src/utils/config/managedEnv.js'
import { updateSettingsForSource } from 'src/utils/settings/settings.js'
import {
  describeMissingProviderEnv,
  missingProviderEnv,
  type ProviderFamily,
} from './providerFamilies.js'

/**
 * Families stored in settings.json; the rest are env-only cloud toolchains.
 *
 * Also the exact set `settings.modelType` accepts — a value outside it is not
 * merely ignored, it makes parseSettingsFileUncached drop the WHOLE file — so
 * this doubles as the type guard on every write below.
 */
type SettingsFamily = 'anthropic' | 'openai' | 'gemini' | 'grok'

const SETTINGS_FAMILIES = new Set<string>([
  'anthropic',
  'openai',
  'gemini',
  'grok',
])

function isSettingsFamily(
  provider: ProviderFamily,
): provider is SettingsFamily {
  return SETTINGS_FAMILIES.has(provider)
}

const CLOUD_ENV_VAR: Record<string, string> = {
  bedrock: 'CLAUDE_CODE_USE_BEDROCK',
  vertex: 'CLAUDE_CODE_USE_VERTEX',
  foundry: 'CLAUDE_CODE_USE_FOUNDRY',
}

const PROVIDER_SELECTION_ENV = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
] as const

/**
 * Select a provider family.
 *
 * A family that is not ready is still selected and then reported: `/login` and
 * the setup wizard write into the family `settings.modelType` names, so
 * choosing first and configuring second is the documented order.
 */
export function switchProviderFamily(provider: ProviderFamily): string {
  const missing = missingProviderEnv(provider, getMergedProviderEnv())
  // Only the settings-backed families can report anything missing; the guard
  // is what proves that to the compiler at the one write that needs it.
  if (missing.length > 0 && isSettingsFamily(provider)) {
    updateSettingsForSource('userSettings', { modelType: provider })
    return describeMissingProviderEnv(provider, missing)
  }

  if (isSettingsFamily(provider)) {
    // Clear any cloud provider env vars to avoid conflicts
    for (const key of PROVIDER_SELECTION_ENV) delete process.env[key]
    updateSettingsForSource('userSettings', { modelType: provider })
    // Ensure settings.env gets applied to process.env
    applyConfigEnvironmentVariables()
    return `API provider set to ${provider}.`
  }

  // Cloud providers are env-only, but a previously persisted `modelType` must
  // still be cleared: getAPIProvider() reads modelType BEFORE any env var, so
  // leaving `modelType: 'openai'` in place would keep routing every request to
  // OpenAI while this command reported a switch to Bedrock.
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GROK
  updateSettingsForSource('userSettings', { modelType: undefined })
  const envVar = CLOUD_ENV_VAR[provider]
  if (envVar) process.env[envVar] = '1'
  applyConfigEnvironmentVariables()
  return `API provider set to ${provider} (via environment variable).`
}

/** Fall back to whatever the environment says. */
export function clearProviderFamily(): string {
  updateSettingsForSource('userSettings', { modelType: undefined })
  // Also clear all provider-specific env vars to prevent conflicts
  for (const key of PROVIDER_SELECTION_ENV) delete process.env[key]
  return 'API provider cleared (will use environment variables).'
}
