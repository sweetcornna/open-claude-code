// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { CONTEXT_1M_BETA_HEADER } from '../../constants/betas.js'
import {
  getExplicitTierContextTokens,
  getTierDefaultContextTokens,
} from '../model/tierSettings.js'
import { getGlobalConfig } from '../config/config.js'
import { isEnvTruthy } from '../config/envUtils.js'
import {
  getCanonicalName,
  getMainLoopModelSettingsSlot,
} from '../model/model.js'
import { resolveAntModel } from '../model/antModels.js'
import {
  CHATGPT_CODEX_MAX_OUTPUT_TOKENS,
  getChatGPTModelContextWindow,
} from '../model/chatgptModels.js'
import { getChinaProviderContextWindow } from '../model/chinaLlmProviders.js'
import { getDeepSeekContextWindow } from '../model/deepseekFamily.js'
import { getModelCapability } from '../model/modelCapabilities.js'
import { getProviderFamily } from '../model/tierDefaults.js'
import type {
  ModelSettingsSlot,
  SessionModelSettingsOverrides,
} from '../model/modelTier.js'

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

/**
 * Whether `claude-opus-5` on this session denotes a checkpoint out of
 * Anthropic's own catalog, judged from the id alone.
 *
 * Deliberately the id and not `servesAnthropicModels()`. The question the
 * ceiling below asks is "does this string name a model whose servable windows
 * we know", and that is a property of the name: an OpenAI-compatible session
 * whose unconfigured tier resolved to a literal `claude-sonnet-5` is going to
 * 404, not to be served a secret 512k window, so treating it as the Anthropic
 * model it is named after costs nothing and keeps this function off the
 * provider-resolution chain that `getContextWindowForModel` sits upstream of.
 */
function isAnthropicCatalogId(model: string): boolean {
  return getCanonicalName(model).toLowerCase().includes('claude')
}

/**
 * The largest window Anthropic will actually serve for this exact model string.
 *
 * Anthropic serves two windows and nothing between them: 200k, and 1M behind
 * the `context-1m` beta header. The header is produced by the `[1m]` suffix
 * (`betas.ts`), which `apply1mContextOptIn` appends precisely when the
 * configured window reaches 1M — so a request for 1M on a 1M-capable model is
 * self-fulfilling and belongs in the ceiling, while a request for anything
 * strictly between the two rungs can never be honoured by anybody.
 *
 * `requested` is therefore part of the question, not just the thing being
 * measured.
 */
function anthropicServableWindow(
  model: string,
  requested: number,
  betas?: string[],
): number {
  if (has1mContext(model)) return CONTEXT_1M_THRESHOLD
  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) {
    return CONTEXT_1M_THRESHOLD
  }
  // Asking for 1M on a capable model IS the opt-in: apply1mContextOptIn turns
  // the id into `…[1m]` on the way out of getMainLoopModel, so the header goes
  // with the request that this accounting describes.
  if (requested >= CONTEXT_1M_THRESHOLD && modelSupports1M(model)) {
    return CONTEXT_1M_THRESHOLD
  }
  return MODEL_CONTEXT_WINDOW_DEFAULT
}

/**
 * A user-configured window, reduced to what the endpoint can actually serve.
 *
 * This is the general correction that `modelSettings.<tier>.contextTokens`
 * shipped without. Before it, the only guard was an equality-flavoured check at
 * exactly 1M, which left a silent 200k–1M band: `claude-opus-5` configured to
 * 372k reported 372k locally, sent no beta header, and had auto-compact aiming
 * at ~352k while the API rejected at 200k — a hard `prompt is too long` where a
 * compaction should have happened.
 *
 * Configuring a SMALLER window than the model serves is a budget, not a
 * capability claim, and is left alone: 128k on a 1M model just compacts sooner.
 *
 * Nothing is clamped for a model whose real window nobody here can know. A
 * third-party id has no beta header to forget and no capability table that has
 * heard of the checkpoint, and the user who pointed at that endpoint knows its
 * window better than occ does; clamping them is how "set the max context for
 * this tier" silently did nothing on every provider whose 1M model is not
 * called Claude. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is the correction there.
 */
export function clampConfiguredContextWindow(
  model: string,
  tokens: number,
  betas?: string[],
): number {
  if (!isAnthropicCatalogId(model)) return tokens
  return Math.min(tokens, anthropicServableWindow(model, tokens, betas))
}

/**
 * Whether an explicitly configured window would actually be honoured for a
 * model — i.e. whether `/model-settings <tier> context <n>` and the `/model`
 * picker should offer it at all.
 *
 * Exactly "the clamp would leave this number alone", so the rungs the picker
 * offers and the number accounting uses can never disagree. On a bare Claude id
 * that means 128k and 200k are offered, 272k and 512k are not (they are the
 * band nobody serves) and 1M is, because picking it produces the `[1m]` suffix.
 * On `claude-opus-5[1m]` every rung is offered — a smaller budget is a valid
 * choice on a 1M model.
 */
export function supportsContextWindow(
  model: string,
  tokens: number,
  betas?: string[],
): boolean {
  return clampConfiguredContextWindow(model, tokens, betas) === tokens
}

/** Where the window occ is accounting with came from. */
export type ContextWindowSource =
  /** CLAUDE_CODE_MAX_CONTEXT_TOKENS */
  | 'env'
  /** in-session `/model-settings` edit, not yet persisted */
  | 'session'
  /** settings.modelSettings.<slot>.contextTokens */
  | 'settings'
  /** the `[1m]` opt-in on the model string */
  | 'suffix'
  | 'deepseek'
  | 'china-preset'
  | 'chatgpt'
  /** the /v1/models capability cache */
  | 'capability'
  /** the caller passed the context-1m beta header */
  | 'beta'
  | 'experiment'
  | 'ant'
  /** the provider-family factory default — the bottom of the chain */
  | 'family-default'

export type ResolvedContextWindow = {
  /** What occ accounts with. */
  window: number
  /** What the winning source asked for, before any clamp. */
  configured: number
  source: ContextWindowSource
  /** Set when `window < configured` because the model cannot serve more. */
  cappedBy: 'model' | null
}

function unclamped(
  window: number,
  source: ContextWindowSource,
): ResolvedContextWindow {
  return { window, configured: window, source, cappedBy: null }
}

function configuredWindow(
  model: string,
  tokens: number,
  source: 'session' | 'settings',
  betas: string[] | undefined,
): ResolvedContextWindow {
  const window = clampConfiguredContextWindow(model, tokens, betas)
  return {
    window,
    configured: tokens,
    source,
    cappedBy: window < tokens ? 'model' : null,
  }
}

/**
 * The full context-window decision, with provenance.
 *
 * `getContextWindowForModel` is this function's `.window`. The extra fields
 * exist so the UI can say WHY a number is what it is — specifically so a window
 * that got capped is visible instead of silently shrinking, which is the whole
 * failure mode `clampConfiguredContextWindow` fixes.
 */
export function resolveContextWindow(
  model: string,
  betas?: string[],
  settingsSlotOverride?: ModelSettingsSlot,
  sessionOverrides?: SessionModelSettingsOverrides,
): ResolvedContextWindow {
  // Allow override via environment variable.
  // This takes precedence over all other context window resolution, including 1M detection.
  // It is the single knob for third-party models whose real window differs from the 200k
  // fallback (a 128k GLM would otherwise never trigger auto-compact before the endpoint
  // rejects with prompt-too-long; a 1M DeepSeek would compact 5× too early). Flows through
  // every downstream consumer: auto-compact thresholds, predictive compact, blocking limit,
  // statusline ctx:% and /context.
  //
  // Deliberately NOT clamped, unlike the two configured arms below. Upstream
  // gates its equivalent behind DISABLE_COMPACT / a non-`claude-` model name;
  // occ documents this variable as the highest-priority correction that works
  // for every user, and third-party endpoint users rely on it. A gate here
  // would break existing setups silently, which is worse than the case it
  // would catch (someone forcing a window Anthropic will not serve, having
  // typed the number themselves this run).
  if (process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
    const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
    if (!isNaN(override) && override > 0) {
      return unclamped(override, 'env')
    }
  }

  // An EXPLICIT per-tier setting sits directly under the env override: the user
  // said what they want, so it beats every detection heuristic below — up to
  // what the endpoint will serve, which is what the clamp enforces.
  //
  // The family DEFAULT deliberately does not go here — it would return a value
  // for every model and short-circuit China-preset windows, ChatGPT windows and
  // the /v1/models capability lookup, all of which know more than a default
  // does. It is applied at the bottom instead, in place of the flat 200k.
  const settingsSlot =
    settingsSlotOverride ?? getMainLoopModelSettingsSlot(model)
  const sessionTokens = settingsSlot
    ? sessionOverrides?.[settingsSlot]?.contextTokens
    : undefined
  if (sessionTokens !== undefined) {
    return configuredWindow(model, sessionTokens, 'session', betas)
  }
  const explicitTierTokens = getExplicitTierContextTokens(model, settingsSlot)
  if (explicitTierTokens !== undefined) {
    return configuredWindow(model, explicitTierTokens, 'settings', betas)
  }

  return detectContextWindow(model, betas, settingsSlot)
}

/**
 * Everything below the configured arms: what the model's window is when nobody
 * has said otherwise. This is the "native window" the clamp measures against.
 */
function detectContextWindow(
  model: string,
  betas: string[] | undefined,
  settingsSlot: ModelSettingsSlot | undefined,
): ResolvedContextWindow {
  // [1m] suffix — explicit client-side opt-in, respected over all detection
  if (has1mContext(model)) {
    return unclamped(CONTEXT_1M_THRESHOLD, 'suffix')
  }

  // DeepSeek V4 is a 1M-context family; the 200k third-party fallback would
  // compact five times too early. Placed above the preset lookup so
  // CLAUDE_CODE_DISABLE_1M_CONTEXT is honoured here too — that flag is the
  // opt-out for a deployment actually serving a smaller window.
  const deepseekWindow = getDeepSeekContextWindow(model)
  if (deepseekWindow !== undefined) {
    return unclamped(
      is1mContextDisabled() ? MODEL_CONTEXT_WINDOW_DEFAULT : deepseekWindow,
      'deepseek',
    )
  }

  // China-preset models, looked up per model rather than pinned globally.
  // One API key exposes the provider's whole catalog and those catalogs mix
  // windows, so the login flow no longer writes CLAUDE_CODE_MAX_CONTEXT_TOKENS
  // for them — without this the 200k fallback would compact a 1M DeepSeek five
  // times too early. This is detection, not a second override: the env var
  // above still wins.
  const chinaPresetWindow = getChinaProviderContextWindow(model)
  if (chinaPresetWindow !== undefined) {
    return unclamped(chinaPresetWindow, 'china-preset')
  }

  // The provider may advertise a larger physical GPT window, but occ's factory
  // default is the conservative 272k budget. A per-tier or env override above can
  // opt into more; without one, UI accounting and auto-compact must follow the
  // same default the setup form shows.
  if (getChatGPTModelContextWindow(model) !== undefined) {
    return unclamped(
      getTierDefaultContextTokens(model, settingsSlot),
      'chatgpt',
    )
  }

  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    if (
      cap.max_input_tokens > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return unclamped(MODEL_CONTEXT_WINDOW_DEFAULT, 'capability')
    }
    return unclamped(cap.max_input_tokens, 'capability')
  }

  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) {
    return unclamped(CONTEXT_1M_THRESHOLD, 'beta')
  }
  if (getSonnet1mExpTreatmentEnabled(model)) {
    return unclamped(CONTEXT_1M_THRESHOLD, 'experiment')
  }
  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model)
    if (antModel?.contextWindow) {
      return unclamped(antModel.contextWindow, 'ant')
    }
  }

  const familyDefault = getTierDefaultContextTokens(model, settingsSlot)
  if (
    familyDefault >= CONTEXT_1M_THRESHOLD &&
    isAnthropicCatalogId(model) &&
    !has1mContext(model)
  ) {
    // Opus/Fable default to 1M, but without the `[1m]` suffix no beta header
    // goes out and the API still cuts off at 200k. Same clamp as the configured
    // arms, on the factory default — so this is not a user mistake and never
    // produces a notice.
    return {
      window: MODEL_CONTEXT_WINDOW_DEFAULT,
      configured: familyDefault,
      source: 'family-default',
      cappedBy: 'model',
    }
  }
  return unclamped(familyDefault, 'family-default')
}

export function getContextWindowForModel(
  model: string,
  betas?: string[],
  settingsSlotOverride?: ModelSettingsSlot,
  sessionOverrides?: SessionModelSettingsOverrides,
): number {
  return resolveContextWindow(
    model,
    betas,
    settingsSlotOverride,
    sessionOverrides,
  ).window
}

/**
 * A user-configured window that got reduced, for the startup notice.
 *
 * Only the two arms the user typed into (`settings`, `session`) qualify: the
 * factory-default clamp above is occ's own choice and warning about it would
 * fire for every Opus session on day one.
 */
export function getConfiguredContextWindowCap(
  model: string,
  betas?: string[],
  settingsSlotOverride?: ModelSettingsSlot,
  sessionOverrides?: SessionModelSettingsOverrides,
): { configured: number; window: number } | null {
  const resolved = resolveContextWindow(
    model,
    betas,
    settingsSlotOverride,
    sessionOverrides,
  )
  if (resolved.cappedBy !== 'model') return null
  if (resolved.source !== 'settings' && resolved.source !== 'session') {
    return null
  }
  return { configured: resolved.configured, window: resolved.window }
}

/**
 * Whether the window occ is using for this model is a pure guess.
 *
 * True only when every detection arm declined AND the id belongs to no family
 * occ has a table for — i.e. the 200k is the "anything else" fallback rather
 * than a fact. Upstream shows a similar notice; occ's differs in that it does
 * NOT fire when the user has already answered the question with
 * CLAUDE_CODE_MAX_CONTEXT_TOKENS or a per-tier setting, both of which win
 * outright and therefore change `source` away from `family-default`.
 */
export function isAssumedContextWindow(
  model: string,
  betas?: string[],
  settingsSlotOverride?: ModelSettingsSlot,
  sessionOverrides?: SessionModelSettingsOverrides,
): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_NOTICE)) {
    return false
  }
  const resolved = resolveContextWindow(
    model,
    betas,
    settingsSlotOverride,
    sessionOverrides,
  )
  return (
    resolved.source === 'family-default' && getProviderFamily(model) === 'other'
  )
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
