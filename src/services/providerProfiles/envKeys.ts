export type ProfileModelType = 'anthropic' | 'openai' | 'gemini' | 'grok'

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
}

// Deduped union: CLAUDE_CODE_MAX_CONTEXT_TOKENS is managed by every family
// (context window is provider-independent), so the flat() union repeats it.
export const ALL_PROFILE_ENV_KEYS: readonly string[] = [
  ...new Set(Object.values(PROFILE_ENV_KEYS).flat()),
]
