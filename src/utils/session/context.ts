// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { CONTEXT_1M_BETA_HEADER } from '../../constants/betas.js'
import {
  getExplicitTierContextTokens,
  getTierDefaultContextTokens,
} from '../model/tierSettings.js'
import { getGlobalConfig } from '../config/config.js'
import { isEnvTruthy } from '../config/envUtils.js'
import { getCanonicalName } from '../model/model.js'
import { resolveAntModel } from '../model/antModels.js'
import {
  CHATGPT_CODEX_MAX_OUTPUT_TOKENS,
  getChatGPTModelContextWindow,
} from '../model/chatgptModels.js'
import { getChinaProviderContextWindow } from '../model/chinaLlmProviders.js'
import { getDeepSeekContextWindow } from '../model/deepseekFamily.js'
import { getModelCapability } from '../model/modelCapabilities.js'

// Model context window size (200k tokens for all models right now)
export /** At or above this, a window needs the 1M capability to be honoured. */
const CONTEXT_1M_THRESHOLD = 1_000_000

const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

// Maximum output tokens for compact operations
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// Default max output tokens
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

// Capped default for slot-reservation optimization. BQ p99 output = 4,911
// tokens, so 32k/64k defaults over-reserve 8-16× slot capacity. With the cap
// enabled, <1% of requests hit the limit; those get one clean retry at 64k
// (see query.ts max_output_tokens_escalate). Cap is applied in
// claude.ts:getMaxOutputTokensForModel to avoid the growthbook→betas→context
// import cycle.
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

/**
 * Check if 1M context is disabled via environment variable.
 * Used by C4E admins to disable 1M context for HIPAA compliance.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT)
}

export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return /\[1m\]/i.test(model)
}

// @[MODEL LAUNCH]: Update this pattern if the new model supports 1M context
export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  const canonical = getCanonicalName(model)
  return (
    canonical.includes('claude-sonnet-4') ||
    canonical.includes('opus-4-6') ||
    canonical.includes('opus-4-7') ||
    canonical.includes('opus-5') ||
    canonical.includes('sonnet-5') ||
    canonical.includes('fable-5')
  )
}

export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  // Allow override via environment variable.
  // This takes precedence over all other context window resolution, including 1M detection.
  // It is the single knob for third-party models whose real window differs from the 200k
  // fallback (a 128k GLM would otherwise never trigger auto-compact before the endpoint
  // rejects with prompt-too-long; a 1M DeepSeek would compact 5× too early). Flows through
  // every downstream consumer: auto-compact thresholds, predictive compact, blocking limit,
  // statusline ctx:% and /context.
  if (process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
    const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
    if (!isNaN(override) && override > 0) {
      return override
    }
  }

  // [1m] suffix — explicit client-side opt-in, respected over all detection
  // An EXPLICIT per-tier setting sits directly under the env override: the user
  // said what they want, so it beats every detection heuristic below.
  //
  // The family DEFAULT deliberately does not go here — it would return a value
  // for every model and short-circuit China-preset windows, ChatGPT windows and
  // the /v1/models capability lookup, all of which know more than a default
  // does. It is applied at the bottom instead, in place of the flat 200k.
  const explicitTierTokens = getExplicitTierContextTokens(model)
  if (explicitTierTokens !== undefined) {
    // Clamped by capability: widening the local accounting to 1M on a model
    // that cannot do it would stop auto-compact from ever firing and turn a
    // compaction into a hard prompt-too-long at the real limit.
    if (
      explicitTierTokens < CONTEXT_1M_THRESHOLD ||
      has1mContext(model) ||
      modelSupports1M(model)
    ) {
      return explicitTierTokens
    }
  }

  if (has1mContext(model)) {
    return 1_000_000
  }

  // DeepSeek V4 is a 1M-context family; the 200k third-party fallback would
  // compact five times too early. Placed above the preset lookup so
  // CLAUDE_CODE_DISABLE_1M_CONTEXT is honoured here too — that flag is the
  // opt-out for a deployment actually serving a smaller window.
  const deepseekWindow = getDeepSeekContextWindow(model)
  if (deepseekWindow !== undefined) {
    return is1mContextDisabled() ? MODEL_CONTEXT_WINDOW_DEFAULT : deepseekWindow
  }

  // China-preset models, looked up per model rather than pinned globally.
  // One API key exposes the provider's whole catalog and those catalogs mix
  // windows, so the login flow no longer writes CLAUDE_CODE_MAX_CONTEXT_TOKENS
  // for them — without this the 200k fallback would compact a 1M DeepSeek five
  // times too early. This is detection, not a second override: the env var
  // above still wins.
  const chinaPresetWindow = getChinaProviderContextWindow(model)
  if (chinaPresetWindow !== undefined) {
    return chinaPresetWindow
  }

  // GPT-5.6 family: OAuth/Codex ≈ 272k; API key path ≈ 1.05M (model card).
  // Used for UI %, auto-compact thresholds, and local budgeting — not sent
  // as a request field (Codex Responses does not take max_input_tokens).
  const chatgptContextWindow = getChatGPTModelContextWindow(model)
  if (chatgptContextWindow !== undefined) {
    if (
      is1mContextDisabled() &&
      chatgptContextWindow > MODEL_CONTEXT_WINDOW_DEFAULT
    ) {
      // Family default in place of the flat 200k fallback: a DeepSeek or GPT model
      // that reached here still gets a sane window instead of the generic guess.
      //
      // Clamped the same way as the explicit arm above. A Claude id that never went
      // through apply1mContextOptIn carries no `[1m]`, so betas.ts sends no
      // context-1m header and the API still cuts off at 200k — reporting 1M here
      // would leave auto-compact idle right up to a hard prompt-too-long.
      const familyDefault = getTierDefaultContextTokens(model)
      if (familyDefault >= CONTEXT_1M_THRESHOLD && !has1mContext(model)) {
        return MODEL_CONTEXT_WINDOW_DEFAULT
      }
      return familyDefault
    }
    return chatgptContextWindow
  }

  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    if (
      cap.max_input_tokens > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return cap.max_input_tokens
  }

  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) {
    return 1_000_000
  }
  if (getSonnet1mExpTreatmentEnabled(model)) {
    return 1_000_000
  }
  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model)
    if (antModel?.contextWindow) {
      return antModel.contextWindow
    }
  }
  return MODEL_CONTEXT_WINDOW_DEFAULT
}

export function getSonnet1mExpTreatmentEnabled(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  // Only applies to sonnet 4.6 without an explicit [1m] suffix
  if (has1mContext(model)) {
    return false
  }
  if (!getCanonicalName(model).includes('sonnet-4-6')) {
    return false
  }
  return getGlobalConfig().clientDataCache?.['coral_reef_sonnet'] === 'true'
}

/**
 * Calculate context window usage percentage from token usage data.
 * Returns used and remaining percentages, or null values if no usage data.
 */
export function calculateContextPercentages(
  currentUsage: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null }
  }

  const totalInputTokens =
    currentUsage.input_tokens +
    currentUsage.cache_creation_input_tokens +
    currentUsage.cache_read_input_tokens

  // Treat zero input tokens the same as no usage data — avoids flashing
  // "ctx:0%" when a third-party API omits usage from message_start.
  if (totalInputTokens === 0) {
    return { used: null, remaining: null }
  }

  const usedPercentage = Math.round(
    (totalInputTokens / contextWindowSize) * 100,
  )
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage))

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  }
}

/**
 * Returns the model's default and upper limit for max output tokens.
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  let defaultTokens: number
  let upperLimit: number

  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model.toLowerCase())
    if (antModel) {
      defaultTokens = antModel.defaultMaxTokens ?? MAX_OUTPUT_TOKENS_DEFAULT
      upperLimit = antModel.upperMaxTokensLimit ?? MAX_OUTPUT_TOKENS_UPPER_LIMIT
      return { default: defaultTokens, upperLimit }
    }
  }

  const m = getCanonicalName(model)

  // GPT-5.6 family: official 128k max output (OpenAI model card).
  if (getChatGPTModelContextWindow(model) !== undefined) {
    defaultTokens = 32_000
    upperLimit = CHATGPT_CODEX_MAX_OUTPUT_TOKENS
  } else if (m.includes('opus-4-7')) {
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('opus-4-6')) {
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('sonnet-4-6')) {
    defaultTokens = 32_000
    upperLimit = 128_000
  } else if (
    m.includes('opus-4-5') ||
    m.includes('sonnet-4') ||
    m.includes('haiku-4')
  ) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else if (m.includes('opus-4-1') || m.includes('opus-4')) {
    defaultTokens = 32_000
    upperLimit = 32_000
  } else if (m.includes('claude-3-opus')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('claude-3-sonnet')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('claude-3-haiku')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('3-5-sonnet') || m.includes('3-5-haiku')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('3-7-sonnet')) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else {
    defaultTokens = MAX_OUTPUT_TOKENS_DEFAULT
    upperLimit = MAX_OUTPUT_TOKENS_UPPER_LIMIT
  }

  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    upperLimit = cap.max_tokens
    defaultTokens = Math.min(defaultTokens, upperLimit)
  }

  return { default: defaultTokens, upperLimit }
}

/**
 * Returns the max thinking budget tokens for a given model. The max
 * thinking tokens should be strictly less than the max output tokens.
 *
 * Deprecated since newer models use adaptive thinking rather than a
 * strict thinking token budget.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}
