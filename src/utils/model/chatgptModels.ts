export type ChatGPTCodexModelOption = {
  value: string
  label: string
  description: string
}

/** Default ChatGPT/Codex model (newest frontier). */
export const CHATGPT_CODEX_DEFAULT_MODEL = 'gpt-5.6-sol'
export const CHATGPT_CODEX_BALANCED_MODEL = 'gpt-5.6-terra'
/** Fast/small default for lighter tasks. */
export const CHATGPT_CODEX_FAST_MODEL = 'gpt-5.6-luna'

export const CHATGPT_CODEX_MODELS_BY_TIER = {
  opus: CHATGPT_CODEX_DEFAULT_MODEL,
  sonnet: CHATGPT_CODEX_BALANCED_MODEL,
  haiku: CHATGPT_CODEX_FAST_MODEL,
} as const

export type ChatGPTCodexModelTier = keyof typeof CHATGPT_CODEX_MODELS_BY_TIER

/** Resolve one occ capability tier without coupling the policy to settings. */
export function resolveChatGPTCodexModelForTier(params: {
  tier: ChatGPTCodexModelTier
  isChatGPTAuth: boolean
  tierOverride?: string
  taskOverride?: string
}): string | undefined {
  return (
    params.taskOverride ??
    params.tierOverride ??
    (params.isChatGPTAuth
      ? CHATGPT_CODEX_MODELS_BY_TIER[params.tier]
      : undefined)
  )
}

/**
 * ChatGPT OAuth / Codex subscription practical context window.
 * Codex with ChatGPT login is product-limited to ~272k (not the full API 1.05M).
 */
export const CHATGPT_OAUTH_CONTEXT_WINDOW = 272_000

/**
 * GPT-5.6 family context window on the OpenAI API model card (API key path).
 * Long-context pricing applies above 272k input tokens.
 */
export const CHATGPT_API_CONTEXT_WINDOW = 1_050_000

/** @deprecated Use CHATGPT_OAUTH_CONTEXT_WINDOW or CHATGPT_API_CONTEXT_WINDOW. */
export const CHATGPT_CODEX_CONTEXT_WINDOW = CHATGPT_OAUTH_CONTEXT_WINDOW

/** Official GPT-5.6 family max output tokens (OpenAI model card). */
export const CHATGPT_CODEX_MAX_OUTPUT_TOKENS = 128_000

/**
 * ChatGPT OAuth / Codex model picker options.
 * Newest GPT-5.6 family first; previous generation models retained for
 * users still on those ids.
 */
export const CHATGPT_CODEX_MODEL_OPTIONS: ChatGPTCodexModelOption[] = [
  {
    value: 'gpt-5.6-sol',
    label: 'gpt-5.6-sol',
    description:
      'Strongest capability for complex coding, computer use, and research',
  },
  {
    value: 'gpt-5.6-terra',
    label: 'gpt-5.6-terra',
    description:
      'Balanced for everyday work, competitive with GPT-5.5 at lower cost',
  },
  {
    value: 'gpt-5.6-luna',
    label: 'gpt-5.6-luna',
    description: 'Fast and affordable, with the lowest cost',
  },
  {
    value: 'gpt-5.5',
    label: 'GPT-5.5',
    description:
      'Frontier model for complex coding, research, and real-world work',
  },
  {
    value: 'gpt-5.4',
    label: 'GPT-5.4',
    description:
      'Strong model for everyday coding; retires 2026-08-31, use gpt-5.6-terra',
  },
  {
    value: 'gpt-5.4-mini',
    label: 'GPT-5.4-Mini',
    description: 'Small, fast model; retires 2026-08-31, use gpt-5.6-luna',
  },
  {
    value: 'gpt-5.3-codex',
    label: 'GPT-5.3-Codex',
    description: 'Coding-optimized model; deprecated on ChatGPT sign-in',
  },
  {
    value: 'gpt-5.3-codex-spark',
    label: 'GPT-5.3-Codex-Spark',
    description: 'Research preview for real-time coding, ChatGPT Pro only',
  },
  {
    value: 'gpt-5.2',
    label: 'GPT-5.2',
    description:
      'Optimized for professional work; deprecated on ChatGPT sign-in',
  },
]

export function isChatGPTAuthMode(): boolean {
  return process.env.OPENAI_AUTH_MODE === 'chatgpt'
}

function normalizeChatGPTModelId(model: string): string {
  return model.toLowerCase().replace(/\[1m\]$/i, '')
}

/**
 * Whether this is a GPT-5.6 family model id (Sol/Terra/Luna or bare `gpt-5.6`).
 */
export function isGpt56FamilyModel(model: string): boolean {
  const normalized = normalizeChatGPTModelId(model)
  return normalized === 'gpt-5.6' || normalized.startsWith('gpt-5.6-')
}

/**
 * Whether this model id belongs to OpenAI's Codex lineage — ids containing
 * 'codex' (gpt-5.3-codex, codex-mini-latest) or the GPT-5 generation
 * (gpt-5, gpt-5.x, gpt-5.x-<variant>).
 *
 * These models are Responses-API-first: OpenAI serves them on `/responses`
 * with first-class reasoning, and Chat Completions support is secondary or
 * absent. Used by the OpenAI wire-protocol resolution to default such models
 * to 'responses'. Deliberately does NOT match gpt-4o/gpt-4.1 (Chat
 * Completions era) or lookalikes such as 'gpt-55'.
 */
export function isCodexFamilyModel(model: string): boolean {
  const normalized = normalizeChatGPTModelId(model)
  if (normalized.includes('codex')) return true
  return /^gpt-5(\.\d+)?(-|$)/.test(normalized)
}

export function isChatGPTCodexReasoningModel(model: string): boolean {
  const normalized = normalizeChatGPTModelId(model)
  return (
    isGpt56FamilyModel(model) ||
    CHATGPT_CODEX_MODEL_OPTIONS.some(
      option => option.value.toLowerCase() === normalized,
    )
  )
}

/**
 * Context window for GPT-5.6 models used by occ for local budgeting
 * (status bar %, auto-compact thresholds). Not sent as a request field.
 *
 * - ChatGPT OAuth / Codex backend: 272k (subscription product limit)
 * - API key / OpenAI-compatible using gpt-5.6-*: 1.05M (model card)
 */
export function getChatGPTModelContextWindow(
  model: string,
): number | undefined {
  if (!isGpt56FamilyModel(model)) {
    return undefined
  }
  return isChatGPTAuthMode()
    ? CHATGPT_OAUTH_CONTEXT_WINDOW
    : CHATGPT_API_CONTEXT_WINDOW
}
