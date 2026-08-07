// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * Ensure that any model codenames introduced here are also added to
 * scripts/excluded-strings.txt to avoid leaking them. Wrap any codename string
 * literals with process.env.USER_TYPE === 'ant' for Bun to remove the codenames
 * during dead code elimination
 */
import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import { wantsTierWideContext } from './tierWideContext.js'
import { resolveAntModel, getAntModelOverrideConfig } from './antModels.js'
import {
  getSubscriptionType,
  isClaudeAISubscriber,
  isMaxSubscriber,
  isProSubscriber,
  isTeamPremiumSubscriber,
} from '../auth/auth.js'
import {
  has1mContext,
  is1mContextDisabled,
  modelSupports1M,
} from '../session/context.js'
import { isEnvTruthy } from '../config/envUtils.js'
import { getModelStrings, resolveOverriddenModel } from './modelStrings.js'
import { formatModelPricing, getOpus46CostTier } from './modelCost.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import {
  getAPIProvider,
  isDirectAnthropicApi,
  isThirdPartyModelCatalog,
} from './providers.js'
import { LIGHTNING_BOLT } from '../../constants/figures.js'
import { isModelAllowed } from './modelAllowlist.js'
import { type ModelAlias, isModelAlias } from './aliases.js'
import { capitalize } from '../text/stringUtils.js'
import {
  type ChatGPTCodexModelTier,
  isChatGPTAuthMode,
  resolveChatGPTCodexModelForTier,
} from './chatgptModels.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null

const OPENAI_DEFAULT_MODEL_ENV_BY_TIER: Record<ChatGPTCodexModelTier, string> =
  {
    opus: 'OPENAI_DEFAULT_OPUS_MODEL',
    sonnet: 'OPENAI_DEFAULT_SONNET_MODEL',
    haiku: 'OPENAI_DEFAULT_HAIKU_MODEL',
  }

function getOpenAIModelForTier(
  provider: ReturnType<typeof getAPIProvider>,
  tier: ChatGPTCodexModelTier,
): ModelName | undefined {
  if (provider !== 'openai') return undefined

  return resolveChatGPTCodexModelForTier({
    tier,
    isChatGPTAuth: isChatGPTAuthMode(),
    tierOverride: process.env[OPENAI_DEFAULT_MODEL_ENV_BY_TIER[tier]],
  })
}

/**
 * The user's per-tier model override for the active provider, or undefined.
 *
 * Every non-OpenAI provider spelling lives here instead of being open-coded in
 * each getDefault*Model(). The provider-setup wizard writes all four
 * GROK_DEFAULT_<TIER>_MODEL keys (specs.ts, `tierEnv('GROK')`), but only Fable
 * ever read one back — so a Grok user's Opus/Sonnet/Haiku choices were dead
 * config and the picker offered Anthropic model names in their place. OpenAI
 * keeps its own lookup above because its override has to go through the
 * ChatGPT/Codex tier resolution first.
 */
function getProviderTierModel(
  provider: ReturnType<typeof getAPIProvider>,
  tier: 'HAIKU' | 'SONNET' | 'OPUS' | 'FABLE',
): ModelName | undefined {
  const prefix =
    provider === 'gemini' ? 'GEMINI' : provider === 'grok' ? 'GROK' : undefined
  if (!prefix) return undefined
  return process.env[`${prefix}_DEFAULT_${tier}_MODEL`] || undefined
}

export function getSmallFastModel(): ModelName {
  const provider = getAPIProvider()
  if (provider === 'openai' && isChatGPTAuthMode()) {
    const chatGPTModel = resolveChatGPTCodexModelForTier({
      tier: 'haiku',
      isChatGPTAuth: true,
      tierOverride: process.env.OPENAI_DEFAULT_HAIKU_MODEL,
      taskOverride: process.env.OPENAI_SMALL_FAST_MODEL,
    })
    if (chatGPTModel) return chatGPTModel
  }
  // Provider-specific small fast model
  if (provider === 'openai' && process.env.OPENAI_SMALL_FAST_MODEL) {
    return process.env.OPENAI_SMALL_FAST_MODEL
  }
  if (provider === 'gemini' && process.env.GEMINI_SMALL_FAST_MODEL) {
    return process.env.GEMINI_SMALL_FAST_MODEL
  }
  // Anthropic-specific or fallback
  return process.env.ANTHROPIC_SMALL_FAST_MODEL || getDefaultHaikuModel()
}

export function isNonCustomOpusModel(model: ModelName): boolean {
  return (
    model === getModelStrings().opus40 ||
    model === getModelStrings().opus41 ||
    model === getModelStrings().opus45 ||
    model === getModelStrings().opus46 ||
    model === getModelStrings().opus47 ||
    model === getModelStrings().opus5
  )
}

/**
 * Helper to get the model from /model (including via /config), the --model flag, environment variable,
 * or the saved settings. The returned value can be a model alias if that's what the user specified.
 * Undefined if the user didn't configure anything, in which case we fall back to
 * the default (null).
 *
 * Priority order within this function:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. ANTHROPIC_MODEL environment variable
 * 4. Settings (from user's saved settings)
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined

  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) {
    specifiedModel = modelOverride
  } else {
    const settings = getSettings_DEPRECATED() || {}
    specifiedModel = process.env.ANTHROPIC_MODEL || settings.model || undefined
  }

  // Ignore the user-specified model if it's not in the availableModels allowlist.
  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined
  }

  return specifiedModel
}

/**
 * Per-model 1M-context opt-in. CLAUDE_CODE_1M_CONTEXT_MODELS is a
 * comma-separated list of model names or substrings (case-insensitive); when
 * the resolved main-loop model matches one, the '[1m]' suffix is appended so
 * the existing suffix path applies end to end (1M context window + the 1M beta
 * header), exactly as if the user had picked `sonnet[1m]` by hand. Models that
 * already carry the suffix are left untouched. Exported for unit tests.
 */
export function apply1mContextOptIn(
  model: ModelName,
  optInList: string | undefined = process.env.CLAUDE_CODE_1M_CONTEXT_MODELS,
): ModelName {
  if (/\[1m\]/i.test(model)) return model
  // Per-tier configuration is the second source of the opt-in. Asking for a 1M
  // window in /model-settings has to produce the `[1m]` suffix, because that
  // suffix is what makes betas.ts send context-1m-2025-08-07. Widening only the
  // local accounting would leave the API rejecting at 200k while auto-compact
  // still believed it had 800k of headroom.
  if (wantsTierWideContext(model)) return `${model}[1m]`
  if (!optInList) return model
  const lower = model.toLowerCase()
  const matched = optInList
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .some(needle => lower.includes(needle))
  return matched ? `${model}[1m]` : model
}

/**
 * Get the main loop model to use for the current session.
 *
 * Model Selection Priority Order:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. ANTHROPIC_MODEL environment variable
 * 4. Settings (from user's saved settings)
 * 5. Built-in default
 *
 * @returns The resolved model name to use
 */
export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return apply1mContextOptIn(parseUserSpecifiedModel(model))
  }
  return apply1mContextOptIn(getDefaultMainLoopModel())
}

export function getBestModel(): ModelName {
  return getDefaultOpusModel()
}

/**
 * Resolve the provider's primary model from its env var (e.g. OPENAI_MODEL).
 * Returns undefined for providers that don't have a primary-model env var
 * (Bedrock, Vertex, Foundry, firstParty).
 */
function getProviderPrimaryModel(): ModelName | undefined {
  const provider = getAPIProvider()
  if (provider === 'openai') return process.env.OPENAI_MODEL
  if (provider === 'gemini') return process.env.GEMINI_MODEL
  if (provider === 'grok') return process.env.GROK_MODEL
  return undefined
}

// @[MODEL LAUNCH]: Update the default Opus model (3P providers may lag so keep defaults unchanged).
export function getDefaultOpusModel(): ModelName {
  const provider = getAPIProvider()
  const openAIModel = getOpenAIModelForTier(provider, 'opus')
  if (openAIModel) return openAIModel
  // Gemini / Grok per-tier override
  const providerTierModel = getProviderTierModel(provider, 'OPUS')
  if (providerTierModel) return providerTierModel
  // Anthropic-specific override (for first-party and other 3P providers)
  if (process.env.ANTHROPIC_DEFAULT_OPUS_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  }
  // 3P providers: if user set a primary model (e.g. OPENAI_MODEL=glm-5.1),
  // fall back to it instead of a hardcoded Anthropic model. This prevents
  // sideQuery / background tasks from sending requests to Anthropic's API
  // when the user configured a third-party provider.
  const primaryModel = getProviderPrimaryModel()
  if (primaryModel) return primaryModel
  if (provider !== 'firstParty') {
    return getModelStrings().opus5
  }
  return getModelStrings().opus5
}

/**
 * Fable is the top capability tier — above Opus, at its own pricing tier.
 * Unlike the other tiers it has no ChatGPT/Codex counterpart, so there is no
 * getOpenAIModelForTier() lookup here: OpenAI users configure it through the
 * same OPENAI_DEFAULT_FABLE_MODEL / primary-model path as any other 3P provider.
 */
export function getDefaultFableModel(): ModelName {
  const provider = getAPIProvider()
  // Provider-specific override first, then the Anthropic-named one (which 3P
  // providers also honor for backward compatibility).
  const providerOverride =
    provider === 'openai'
      ? process.env.OPENAI_DEFAULT_FABLE_MODEL
      : getProviderTierModel(provider, 'FABLE')
  if (providerOverride) return providerOverride
  if (process.env.ANTHROPIC_DEFAULT_FABLE_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_FABLE_MODEL
  }
  // 3P providers: fall back to the user's primary model rather than sending an
  // Anthropic model name to a third-party endpoint (same rule as Opus/Sonnet).
  const primaryModel = getProviderPrimaryModel()
  if (primaryModel) return primaryModel
  return getModelStrings().fable5
}

// @[MODEL LAUNCH]: Update the default Sonnet model (3P providers may lag so keep defaults unchanged).
export function getDefaultSonnetModel(): ModelName {
  const provider = getAPIProvider()
  const openAIModel = getOpenAIModelForTier(provider, 'sonnet')
  if (openAIModel) return openAIModel
  // Gemini / Grok per-tier override
  const providerTierModel = getProviderTierModel(provider, 'SONNET')
  if (providerTierModel) return providerTierModel
  // Anthropic-specific override (for first-party and other 3P providers)
  if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  }
  // 3P providers: fall back to user's primary model instead of a hardcoded
  // Anthropic model name. Prevents background API calls from being routed to
  // Anthropic when the user configured a third-party endpoint.
  const primaryModel = getProviderPrimaryModel()
  if (primaryModel) return primaryModel
  if (provider !== 'firstParty') {
    return getModelStrings().sonnet5
  }
  return getModelStrings().sonnet5
}

// @[MODEL LAUNCH]: Update the default Haiku model (3P providers may lag so keep defaults unchanged).
export function getDefaultHaikuModel(): ModelName {
  const provider = getAPIProvider()
  const openAIModel = getOpenAIModelForTier(provider, 'haiku')
  if (openAIModel) return openAIModel
  // Gemini / Grok per-tier override
  const providerTierModel = getProviderTierModel(provider, 'HAIKU')
  if (providerTierModel) return providerTierModel
  // Anthropic-specific override (for first-party and other 3P providers)
  if (process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  }
  // 3P providers: fall back to user's primary model instead of a hardcoded
  // Anthropic model name.
  const primaryModel = getProviderPrimaryModel()
  if (primaryModel) return primaryModel

  // Haiku 4.5 is available on all platforms (first-party, Foundry, Bedrock, Vertex)
  return getModelStrings().haiku45
}

/**
 * Get the model to use for runtime, depending on the runtime context.
 * @param params Subset of the runtime context to determine the model to use.
 * @returns The model to use
 */
export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): ModelName {
  const { permissionMode, mainLoopModel, exceeds200kTokens = false } = params

  // opusplan uses Opus in plan mode without [1m] suffix.
  if (
    getUserSpecifiedModelSetting() === 'opusplan' &&
    permissionMode === 'plan' &&
    !exceeds200kTokens
  ) {
    return getDefaultOpusModel()
  }

  // sonnetplan by default
  if (getUserSpecifiedModelSetting() === 'haiku' && permissionMode === 'plan') {
    return getDefaultSonnetModel()
  }

  return mainLoopModel
}

/**
 * Get the default main loop model setting.
 *
 * This handles the built-in default:
 * - Opus for Max and Team Premium users
 * - Sonnet 4.6 for all other users (including Team Standard, Pro, Enterprise)
 *
 * @returns The default model setting to use
 */
export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  // Ants default to defaultModel from flag config, or Opus 1M if not configured
  if (process.env.USER_TYPE === 'ant') {
    return (
      (getAntModelOverrideConfig()?.defaultModel as string) ??
      getDefaultOpusModel() + '[1m]'
    )
  }

  // Max users get Opus as default
  if (isMaxSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // Team Premium gets Opus (same as Max)
  if (isTeamPremiumSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // PAYG (1P and 3P), Enterprise, Team Standard, and Pro get Sonnet as default
  // Note that PAYG (3P) may default to an older Sonnet model
  return getDefaultSonnetModel()
}

/**
 * Synchronous operation to get the default main loop model to use
 * (bypassing any user-specified values).
 */
export function getDefaultMainLoopModel(): ModelName {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

// @[MODEL LAUNCH]: Add a canonical name mapping for the new model below.
/**
 * Pure string-match that strips date/provider suffixes from a first-party model
 * name. Input must already be a 1P-format ID (e.g. 'claude-3-7-sonnet-20250219',
 * 'us.anthropic.claude-opus-4-6-v1:0'). Does not touch settings, so safe at
 * module top-level (see MODEL_COSTS in modelCost.ts).
 */
export function firstPartyNameToCanonical(name: ModelName): ModelShortName {
  name = name.toLowerCase()
  // Fable has no version-number segment, so the generic regex at the bottom
  // would truncate it to 'claude-fable' and every canonical-name comparison
  // (pricing, capabilities, marketing name) would miss.
  if (name.includes('claude-fable-5')) {
    return 'claude-fable-5'
  }
  // Claude 5 family: no minor-version segment, so the generic regex below
  // would truncate to 'claude-opus' / 'claude-sonnet'. The 4-x checks that
  // follow cannot match these (they all require a '-4' segment).
  if (name.includes('claude-opus-5')) {
    return 'claude-opus-5'
  }
  if (name.includes('claude-sonnet-5')) {
    return 'claude-sonnet-5'
  }
  // Special cases for Claude 4+ models to differentiate versions
  // Order matters: check more specific versions first (4-5 before 4)
  if (name.includes('claude-opus-4-7')) {
    return 'claude-opus-4-7'
  }
  if (name.includes('claude-opus-4-6')) {
    return 'claude-opus-4-6'
  }
  if (name.includes('claude-opus-4-5')) {
    return 'claude-opus-4-5'
  }
  if (name.includes('claude-opus-4-1')) {
    return 'claude-opus-4-1'
  }
  if (name.includes('claude-opus-4')) {
    return 'claude-opus-4'
  }
  if (name.includes('claude-sonnet-4-6')) {
    return 'claude-sonnet-4-6'
  }
  if (name.includes('claude-sonnet-4-5')) {
    return 'claude-sonnet-4-5'
  }
  if (name.includes('claude-sonnet-4')) {
    return 'claude-sonnet-4'
  }
  if (name.includes('claude-haiku-4-5')) {
    return 'claude-haiku-4-5'
  }
  // Claude 3.x models use a different naming scheme (claude-3-{family})
  if (name.includes('claude-3-7-sonnet')) {
    return 'claude-3-7-sonnet'
  }
  if (name.includes('claude-3-5-sonnet')) {
    return 'claude-3-5-sonnet'
  }
  if (name.includes('claude-3-5-haiku')) {
    return 'claude-3-5-haiku'
  }
  if (name.includes('claude-3-opus')) {
    return 'claude-3-opus'
  }
  if (name.includes('claude-3-sonnet')) {
    return 'claude-3-sonnet'
  }
  if (name.includes('claude-3-haiku')) {
    return 'claude-3-haiku'
  }
  const match = name.match(/(claude-(\d+-\d+-)?\w+)/)
  if (match && match[1]) {
    return match[1]
  }
  // Fall back to the original name if no pattern matches
  return name
}

/**
 * Maps a full model string to a shorter canonical version that's unified across 1P and 3P providers.
 * For example, 'claude-3-5-haiku-20241022' and 'us.anthropic.claude-3-5-haiku-20241022-v1:0'
 * would both be mapped to 'claude-3-5-haiku'.
 * @param fullModelName The full model name (e.g., 'claude-3-5-haiku-20241022')
 * @returns The short name (e.g., 'claude-3-5-haiku') if found, or the original name if no mapping exists
 */
export function getCanonicalName(fullModelName: ModelName): ModelShortName {
  // Resolve overridden model IDs (e.g. Bedrock ARNs) back to canonical names.
  // resolved is always a 1P-format ID, so firstPartyNameToCanonical can handle it.
  return firstPartyNameToCanonical(resolveOverriddenModel(fullModelName))
}

// @[MODEL LAUNCH]: Update the default model description strings shown to users.
export function getClaudeAiUserDefaultModelDescription(
  fastMode = false,
): string {
  if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
    if (isOpus1mMergeEnabled()) {
      return `Opus 5 with 1M context · Most capable for complex work${fastMode ? getOpusPricingSuffix(true) : ''}`
    }
    return `Opus 5 · Most capable for complex work${fastMode ? getOpusPricingSuffix(true) : ''}`
  }
  return 'Sonnet 5 · Best for everyday tasks'
}

export function renderDefaultModelSetting(
  setting: ModelName | ModelAlias,
): string {
  if (setting === 'opusplan') {
    return 'Opus 5 in plan mode, else Sonnet 5'
  }
  return renderModelName(parseUserSpecifiedModel(setting))
}

export function getOpusPricingSuffix(fastMode: boolean): string {
  // Anthropic's rate card only describes Anthropic's models — see
  // isThirdPartyModelCatalog for why the wire question is the wrong one here.
  if (isThirdPartyModelCatalog()) return ''
  const pricing = formatModelPricing(getOpus46CostTier(fastMode))
  const fastModeIndicator = fastMode ? ` (${LIGHTNING_BOLT})` : ''
  return ` ·${fastModeIndicator} ${pricing}`
}

export function isOpus1mMergeEnabled(): boolean {
  if (is1mContextDisabled() || isProSubscriber() || !isDirectAnthropicApi()) {
    return false
  }
  // Fail closed when a subscriber's subscription type is unknown. The VS Code
  // config-loading subprocess can have OAuth tokens with valid scopes but no
  // subscriptionType field (stale or partial refresh). Without this guard,
  // isProSubscriber() returns false for such users and the merge leaks
  // opus[1m] into the model dropdown — the API then rejects it with a
  // misleading "rate limit reached" error.
  if (isClaudeAISubscriber() && getSubscriptionType() === null) {
    return false
  }
  return true
}

export function renderModelSetting(setting: ModelName | ModelAlias): string {
  if (setting === 'opusplan') {
    return 'Opus Plan'
  }
  if (isModelAlias(setting)) {
    return capitalize(setting)
  }
  return renderModelName(setting)
}

// @[MODEL LAUNCH]: Add display name cases for the new model (base + [1m] variant if applicable).
/**
 * Returns a human-readable display name for known public models, or null
 * if the model is not recognized as a public model.
 */
export function getPublicModelDisplayName(model: ModelName): string | null {
  switch (model) {
    case getModelStrings().fable5:
      return 'Fable 5'
    case getModelStrings().fable5 + '[1m]':
      return 'Fable 5 (1M context)'
    case getModelStrings().opus5:
      return 'Opus 5'
    case getModelStrings().opus5 + '[1m]':
      return 'Opus 5 (1M context)'
    case getModelStrings().sonnet5:
      return 'Sonnet 5'
    case getModelStrings().sonnet5 + '[1m]':
      return 'Sonnet 5 (1M context)'
    case getModelStrings().opus47:
      return 'Opus 4.7'
    case getModelStrings().opus47 + '[1m]':
      return 'Opus 4.7 (1M context)'
    case getModelStrings().opus46:
      return 'Opus 4.6'
    case getModelStrings().opus46 + '[1m]':
      return 'Opus 4.6 (1M context)'
    case getModelStrings().opus45:
      return 'Opus 4.5'
    case getModelStrings().opus41:
      return 'Opus 4.1'
    case getModelStrings().opus40:
      return 'Opus 4'
    case getModelStrings().sonnet46 + '[1m]':
      return 'Sonnet 4.6 (1M context)'
    case getModelStrings().sonnet46:
      return 'Sonnet 4.6'
    case getModelStrings().sonnet45 + '[1m]':
      return 'Sonnet 4.5 (1M context)'
    case getModelStrings().sonnet45:
      return 'Sonnet 4.5'
    case getModelStrings().sonnet40:
      return 'Sonnet 4'
    case getModelStrings().sonnet40 + '[1m]':
      return 'Sonnet 4 (1M context)'
    case getModelStrings().sonnet37:
      return 'Sonnet 3.7'
    case getModelStrings().sonnet35:
      return 'Sonnet 3.5'
    case getModelStrings().haiku45:
      return 'Haiku 4.5'
    case getModelStrings().haiku35:
      return 'Haiku 3.5'
    default:
      return null
  }
}

function maskModelCodename(baseName: string): string {
  // Mask only the first dash-separated segment (the codename), preserve the rest
  // e.g. capybara-v2-fast → cap*****-v2-fast
  const [codename = '', ...rest] = baseName.split('-')
  const masked =
    codename.slice(0, 3) + '*'.repeat(Math.max(0, codename.length - 3))
  return [masked, ...rest].join('-')
}

export function renderModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return publicName
  }
  if (process.env.USER_TYPE === 'ant') {
    const resolved = parseUserSpecifiedModel(model)
    const antModel = resolveAntModel(model)
    if (antModel) {
      const baseName = antModel.model.replace(/\[1m\]$/i, '')
      const masked = maskModelCodename(baseName)
      const suffix = has1mContext(resolved) ? '[1m]' : ''
      return masked + suffix
    }
    if (resolved !== model) {
      return `${model} (${resolved})`
    }
    return resolved
  }
  return model
}

/**
 * Returns a safe author name for public display (e.g., in git commit trailers).
 * Returns "Claude {ModelName}" for publicly known models, or "Claude ({model})"
 * for unknown/internal models so the exact model name is preserved.
 *
 * @param model The full model name
 * @returns "Claude {ModelName}" for public models, or "Claude ({model})" for non-public models
 */
export function getPublicModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return `Claude ${publicName}`
  }
  return `Claude (${model})`
}

/**
 * Returns a full model name for use in this session, possibly after resolving
 * a model alias.
 *
 * This function intentionally does not support version numbers to align with
 * the model switcher.
 *
 * Supports [1m] suffix on any model alias (e.g., haiku[1m], sonnet[1m]) to enable
 * 1M context window without requiring each variant to be in MODEL_ALIASES.
 *
 * @param modelInput The model alias or name provided by the user.
 */
export function parseUserSpecifiedModel(
  modelInput: ModelName | ModelAlias,
): ModelName {
  const modelInputTrimmed = modelInput.trim()
  const normalizedModel = modelInputTrimmed.toLowerCase()

  const has1mTag = has1mContext(normalizedModel)
  const modelString = has1mTag
    ? normalizedModel.replace(/\[1m]$/i, '').trim()
    : normalizedModel

  if (isModelAlias(modelString)) {
    switch (modelString) {
      case 'opusplan':
        return getDefaultSonnetModel() + (has1mTag ? '[1m]' : '') // Sonnet is default, Opus in plan mode
      case 'sonnet':
        return getDefaultSonnetModel() + (has1mTag ? '[1m]' : '')
      case 'haiku':
        return getDefaultHaikuModel() + (has1mTag ? '[1m]' : '')
      case 'opus':
        return getDefaultOpusModel() + (has1mTag ? '[1m]' : '')
      case 'fable':
        return getDefaultFableModel() + (has1mTag ? '[1m]' : '')
      case 'best':
        return getBestModel()
      default:
    }
  }

  // Opus 4/4.1 are no longer available on the first-party API (same as
  // Claude.ai) — silently remap to the current Opus default. The 'opus'
  // alias resolves to the current default Opus (4.7), so the only users
  // on these explicit strings pinned them in settings/env/--model/SDK
  // before 4.5 launched. 3P providers may not yet have 4.6/4.7 capacity,
  // so pass through unchanged.
  if (
    !isThirdPartyModelCatalog() &&
    isLegacyOpusFirstParty(modelString) &&
    isLegacyModelRemapEnabled()
  ) {
    return getDefaultOpusModel() + (has1mTag ? '[1m]' : '')
  }

  if (process.env.USER_TYPE === 'ant') {
    const has1mAntTag = has1mContext(normalizedModel)
    const baseAntModel = normalizedModel.replace(/\[1m]$/i, '').trim()

    const antModel = resolveAntModel(baseAntModel)
    if (antModel) {
      const suffix = has1mAntTag ? '[1m]' : ''
      return antModel.model + suffix
    }

    // Fall through to the alias string if we cannot load the config. The API calls
    // will fail with this string, but we should hear about it through feedback and
    // can tell the user to restart/wait for flag cache refresh to get the latest values.
  }

  // Preserve original case for custom model names (e.g., Azure Foundry deployment IDs)
  // Only strip [1m] suffix if present, maintaining case of the base model
  if (has1mTag) {
    return modelInputTrimmed.replace(/\[1m\]$/i, '').trim() + '[1m]'
  }
  return modelInputTrimmed
}

/**
 * Resolves a skill's `model:` frontmatter against the current model, carrying
 * the `[1m]` suffix over when the target family supports it.
 *
 * A skill author writing `model: opus` means "use opus-class reasoning" — not
 * "downgrade to 200K". If the user is on opus[1m] at 230K tokens and invokes a
 * skill with `model: opus`, passing the bare alias through drops the effective
 * context window from 1M to 200K, which trips autocompact at 23% apparent usage
 * and surfaces "Context limit reached" even though nothing overflowed.
 *
 * We only carry [1m] when the target actually supports it (sonnet/opus). A skill
 * with `model: haiku` on a 1M session still downgrades — haiku has no 1M variant,
 * so the autocompact that follows is correct. Skills that already specify [1m]
 * are left untouched.
 */
export function resolveSkillModelOverride(
  skillModel: string,
  currentModel: string,
): string {
  if (has1mContext(skillModel) || !has1mContext(currentModel)) {
    return skillModel
  }
  // modelSupports1M matches on canonical IDs ('claude-opus-4-6', 'claude-sonnet-4');
  // a bare 'opus' alias falls through getCanonicalName unmatched. Resolve first.
  if (modelSupports1M(parseUserSpecifiedModel(skillModel))) {
    return skillModel + '[1m]'
  }
  return skillModel
}

const LEGACY_OPUS_FIRSTPARTY = [
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-opus-4-0',
  'claude-opus-4-1',
]

function isLegacyOpusFirstParty(model: string): boolean {
  return LEGACY_OPUS_FIRSTPARTY.includes(model)
}

/**
 * Opt-out for the legacy Opus 4.0/4.1 → current Opus remap.
 */
export function isLegacyModelRemapEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP)
}

export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    if (process.env.USER_TYPE === 'ant') {
      return `Default for Ants (${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})`
    } else if (isClaudeAISubscriber()) {
      return `Default (${getClaudeAiUserDefaultModelDescription()})`
    }
    return `Default (${getDefaultMainLoopModel()})`
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}

// @[MODEL LAUNCH]: Add a marketing name mapping for the new model below.
export function getMarketingNameForModel(modelId: string): string | undefined {
  if (getAPIProvider() === 'foundry') {
    // deployment ID is user-defined in Foundry, so it may have no relation to the actual model
    return undefined
  }

  const has1m = modelId.toLowerCase().includes('[1m]')
  const canonical = getCanonicalName(modelId)

  if (canonical.includes('claude-fable-5')) {
    return has1m ? 'Fable 5 (with 1M context)' : 'Fable 5'
  }
  if (canonical.includes('claude-opus-5')) {
    return has1m ? 'Opus 5 (with 1M context)' : 'Opus 5'
  }
  if (canonical.includes('claude-sonnet-5')) {
    return has1m ? 'Sonnet 5 (with 1M context)' : 'Sonnet 5'
  }
  if (canonical.includes('claude-opus-4-7')) {
    return has1m ? 'Opus 4.7 (with 1M context)' : 'Opus 4.7'
  }
  if (canonical.includes('claude-opus-4-6')) {
    return has1m ? 'Opus 4.6 (with 1M context)' : 'Opus 4.6'
  }
  if (canonical.includes('claude-opus-4-5')) {
    return 'Opus 4.5'
  }
  if (canonical.includes('claude-opus-4-1')) {
    return 'Opus 4.1'
  }
  if (canonical.includes('claude-opus-4')) {
    return 'Opus 4'
  }
  if (canonical.includes('claude-sonnet-4-6')) {
    return has1m ? 'Sonnet 4.6 (with 1M context)' : 'Sonnet 4.6'
  }
  if (canonical.includes('claude-sonnet-4-5')) {
    return has1m ? 'Sonnet 4.5 (with 1M context)' : 'Sonnet 4.5'
  }
  if (canonical.includes('claude-sonnet-4')) {
    return has1m ? 'Sonnet 4 (with 1M context)' : 'Sonnet 4'
  }
  if (canonical.includes('claude-3-7-sonnet')) {
    return 'Claude 3.7 Sonnet'
  }
  if (canonical.includes('claude-3-5-sonnet')) {
    return 'Claude 3.5 Sonnet'
  }
  if (canonical.includes('claude-haiku-4-5')) {
    return 'Haiku 4.5'
  }
  if (canonical.includes('claude-3-5-haiku')) {
    return 'Claude 3.5 Haiku'
  }

  return undefined
}

export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}
