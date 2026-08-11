/**
 * Provider families a profile can be saved as.
 *
 * Must stay in lockstep with `settings.modelType`'s zod enum: activateProfile()
 * writes this value straight into settings, and a value that enum rejects is
 * not merely ignored — parseSettingsFileUncached drops the WHOLE file, making
 * every other setting in it invisible.
 *
 * `opencode` has to be a member in its own right rather than being folded onto
 * the lane it happens to speak. Folding it is not a cosmetic simplification: an
 * OpenCode session's lane keys (the ANTHROPIC_ and OPENAI_ families) hold
 * values the wire mirror put in process.env, and the credential among them is
 * an OAuth access token with about an hour to live. Capturing under the lane's
 * family therefore wrote that token into provider-profiles.json — stale within
 * the hour, and a secret on disk that this design exists to keep off disk.
 * Capturing under `opencode`
 * snapshots the OPENCODE_* keys the user actually configured, and the live
 * token stays where it belongs: the 0600 file the credential layer refreshes.
 */
export type ProfileModelType =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'grok'
  | 'opencode'

// The two intents — "family a profile can be saved as" and "family whose env
// keys activation clears" — were briefly separate types while OpenCode could
// not be persisted as a modelType. They are the same set again, and a second
// name for an identical union is one more thing to keep in sync for no gain.

const PROFILE_MODEL_TIERS = ['HAIKU', 'SONNET', 'OPUS', 'FABLE'] as const
const PROFILE_MODEL_TIER_KEYS = [
  'MODEL',
  'MODEL_NAME',
  'MODEL_DESCRIPTION',
  'MODEL_SUPPORTED_CAPABILITIES',
] as const

function tierProfileEnvKeys(providerPrefix: string): readonly string[] {
  return PROFILE_MODEL_TIERS.flatMap(tier =>
    PROFILE_MODEL_TIER_KEYS.map(
      key => `${providerPrefix}_DEFAULT_${tier}_${key}`,
    ),
  )
}

/**
 * Env keys a profile may manage, per provider family. Activation clears the
 * union of ALL families before applying the target profile's env, so keys
 * from a previously active provider can never leak into the new one.
 *
 * That "clear the union first" rule is why a missing key is a real bug and not
 * just an omission: a knob absent from this table survives a profile switch and
 * keeps steering the new provider.
 */
export const PROFILE_ENV_KEYS: Record<ProfileModelType, readonly string[]> = {
  anthropic: [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    ...tierProfileEnvKeys('ANTHROPIC'),
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
    'CLAUDE_CODE_1M_CONTEXT_MODELS',
    'CLAUDE_CODE_PROMPT_CACHING_1H',
  ],
  openai: [
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    ...tierProfileEnvKeys('OPENAI'),
    'OPENAI_AUTH_MODE',
    'OPENAI_WIRE_API',
    'OPENAI_ENABLE_THINKING',
    'OPENAI_MAX_TOKENS',
    'OPENAI_ORG_ID',
    'OPENAI_PROJECT_ID',
    'OPENAI_PROMPT_CACHE_KEY',
    'OPENAI_VERBOSITY',
    'OPENAI_REASONING_SUMMARY',
    'OPENAI_REQUEST_MAX_RETRIES',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  ],
  gemini: [
    'GEMINI_API_KEY',
    'GEMINI_AUTH_MODE',
    'GEMINI_BASE_URL',
    'ANTIGRAVITY_BASE_URL',
    'GEMINI_MODEL',
    ...tierProfileEnvKeys('GEMINI'),
    'GEMINI_MAX_TOKENS',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  ],
  grok: [
    'GROK_API_KEY',
    'XAI_API_KEY',
    'GROK_MODEL',
    'GROK_MODEL_MAP',
    ...tierProfileEnvKeys('GROK'),
    'GROK_BASE_URL',
    'GROK_MAX_TOKENS',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  ],
  // OpenCode. `OPENCODE_BASE_URL` is in the list because it is what selects the
  // product — Zen or Go — so a profile without it would restore a session onto
  // the other one's endpoint and bill the wrong balance.
  // `OPENCODE_API_KEY` is the only credential that lives in env
  // here — the OAuth pair is a 0600 file the credential layer refreshes hourly,
  // and a copy of it in settings.json would be stale within the hour and a
  // secret in a config file at the same time.
  //
  // Only the `_MODEL` tier keys, not the `_NAME`/`_DESCRIPTION`/
  // `_SUPPORTED_CAPABILITIES` trio the other families carry: the mirror in
  // opencodeWire.ts copies the model id onto the lane's own tier key and the
  // metadata is then read from THAT key, so an OPENCODE_-prefixed copy would be
  // written by nothing and read by nothing.
  opencode: [
    'OPENCODE_AUTH_MODE',
    'OPENCODE_BASE_URL',
    // Which inference plane the session was configured for. In the list for the
    // same reason the base URL is: restoring a profile without it turns a
    // Console session back into a Zen one, whose lane rules point `claude-*` at
    // a `/messages` path the console answers with 404.
    'OPENCODE_INFERENCE_PLANE',
    'OPENCODE_MODEL',
    'OPENCODE_WIRE_API',
    'OPENCODE_API_KEY',
    ...PROFILE_MODEL_TIERS.map(tier => `OPENCODE_DEFAULT_${tier}_MODEL`),
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  ],
}

// Deduped union: CLAUDE_CODE_MAX_CONTEXT_TOKENS is managed by every family
// (context window is provider-independent), so the flat() union repeats it.
export const ALL_PROFILE_ENV_KEYS: readonly string[] = [
  ...new Set(Object.values(PROFILE_ENV_KEYS).flat()),
]
