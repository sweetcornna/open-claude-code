/**
 * Provider profiles — cc-switch-style named provider configurations.
 *
 * A profile snapshots "which provider am I talking to and how" (modelType +
 * the provider-managed env keys). Activation is a whole-shape write, not a
 * patch: every managed key is first cleared, then the profile's keys are
 * applied — so switching never leaves another provider's endpoint or key
 * behind (the failure mode single-slot editing had). A Claude-OAuth profile
 * is simply `modelType: 'anthropic'` with empty env, which clears all
 * third-party overrides and falls back to OAuth.
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
import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'

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

export type ProfileModelType = 'anthropic' | 'openai' | 'gemini' | 'grok'

export type ProviderProfile = {
  name: string
  modelType: ProfileModelType
  /** Provider-managed env keys to write into settings.env on activation. */
  env: Record<string, string>
  notes?: string
  createdAt: string
  updatedAt: string
}

export type ProviderProfilesFile = {
  version: 1
  active?: string
  profiles: Record<string, ProviderProfile>
}

/**
 * Env keys a profile may manage, per provider family. Activation clears the
 * union of ALL families before applying the target profile's env, so keys
 * from a previously active provider can never leak into the new one.
 */
export const PROFILE_ENV_KEYS: Record<ProfileModelType, readonly string[]> = {
  anthropic: [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
    'CLAUDE_CODE_1M_CONTEXT_MODELS',
    'CLAUDE_CODE_PROMPT_CACHING_1H',
  ],
  openai: [
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'OPENAI_DEFAULT_HAIKU_MODEL',
    'OPENAI_DEFAULT_SONNET_MODEL',
    'OPENAI_DEFAULT_OPUS_MODEL',
    'OPENAI_DEFAULT_FABLE_MODEL',
    'OPENAI_AUTH_MODE',
    'OPENAI_WIRE_API',
    'OPENAI_ENABLE_THINKING',
    'OPENAI_MAX_TOKENS',
    'OPENAI_ORG_ID',
    'OPENAI_PROJECT_ID',
    'OPENAI_PROMPT_CACHE_KEY',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  ],
  gemini: [
    'GEMINI_API_KEY',
    'GEMINI_AUTH_MODE',
    'GEMINI_BASE_URL',
    'GEMINI_MODEL',
    'GEMINI_DEFAULT_HAIKU_MODEL',
    'GEMINI_DEFAULT_SONNET_MODEL',
    'GEMINI_DEFAULT_OPUS_MODEL',
    'GEMINI_DEFAULT_FABLE_MODEL',
    'GEMINI_MAX_TOKENS',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  ],
  grok: [
    'GROK_API_KEY',
    'XAI_API_KEY',
    'GROK_MODEL',
    'GROK_DEFAULT_FABLE_MODEL',
    'GROK_BASE_URL',
    'GROK_MAX_TOKENS',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  ],
}

// Deduped union: CLAUDE_CODE_MAX_CONTEXT_TOKENS is managed by every family
// (context window is provider-independent), so the flat() union repeats it.
export const ALL_PROFILE_ENV_KEYS: readonly string[] = [
  ...new Set(Object.values(PROFILE_ENV_KEYS).flat()),
]

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
  existing?: ProviderProfile
}): ProviderProfile {
  const env: Record<string, string> = {}
  for (const key of PROFILE_ENV_KEYS[params.modelType]) {
    const value = params.mergedEnv[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  const now = new Date().toISOString()
  return {
    name: params.name,
    modelType: params.modelType,
    env,
    ...(params.notes ? { notes: params.notes } : {}),
    createdAt: params.existing?.createdAt ?? now,
    updatedAt: now,
  }
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
