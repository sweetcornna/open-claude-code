// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getInitialMainLoopModel } from '../../bootstrap/state.js'
import {
  isClaudeAISubscriber,
  isMaxSubscriber,
  isTeamPremiumSubscriber,
} from '../auth/auth.js'
import { getModelStrings } from './modelStrings.js'
import { getAntModels } from './antModels.js'
import {
  COST_TIER_3_15,
  COST_TIER_10_50,
  COST_HAIKU_35,
  COST_HAIKU_45,
  formatModelPricing,
} from './modelCost.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { checkOpus1mAccess, checkSonnet1mAccess } from './check1mAccess.js'
import { getAPIProvider, isThirdPartyModelCatalog } from './providers.js'
import { isDeepSeekAnthropicWireActive } from './deepseekWire.js'
import { type ModelTier } from './modelTier.js'
import { capitalize } from '../text/stringUtils.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  getCanonicalName,
  getClaudeAiUserDefaultModelDescription,
  getDefaultSonnetModel,
  getDefaultOpusModel,
  getDefaultHaikuModel,
  getDefaultFableModel,
  getDefaultMainLoopModelSetting,
  getMarketingNameForModel,
  getUserSpecifiedModelSetting,
  isOpus1mMergeEnabled,
  getOpusPricingSuffix,
  renderDefaultModelSetting,
  type ModelSetting,
} from './model.js'
import { has1mContext } from '../session/context.js'
import { getGlobalConfig } from '../config/config.js'
import {
  catalogKeyForProvider,
  getCachedModelCatalog,
} from '../../services/modelCatalog/cache.js'
import { mergeCatalogModelOptions } from '../../services/modelCatalog/merge.js'
import { findChinaProviderByBaseURL } from './chinaLlmProviders.js'
import {
  ANTIGRAVITY_MODEL_OPTIONS,
  isAntigravityAuthMode,
} from './antigravityModels.js'
import {
  CHATGPT_CODEX_DEFAULT_MODEL,
  CHATGPT_CODEX_MODEL_OPTIONS,
  isChatGPTAuthMode,
} from './chatgptModels.js'

// @[MODEL LAUNCH]: Update all the available and default model option strings below.

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
}

export function getDefaultOptionForUser(fastMode = false): ModelOption {
  if (process.env.USER_TYPE === 'ant') {
    const currentModel = renderDefaultModelSetting(
      getDefaultMainLoopModelSetting(),
    )
    return {
      value: null,
      label: 'Default (recommended)',
      description: `Use the default model for Ants (currently ${currentModel})`,
      descriptionForModel: `Default model (currently ${currentModel})`,
    }
  }

  // Subscribers
  if (isClaudeAISubscriber()) {
    return {
      value: null,
      label: 'Default (recommended)',
      description: getClaudeAiUserDefaultModelDescription(fastMode),
    }
  }

  // PAYG
  const is3P = isThirdPartyModelCatalog()
  return {
    value: null,
    label: 'Default (recommended)',
    description: `Use the default model (currently ${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
  }
}

/**
 * Env prefixes to read a tier's model/name/description from, most specific
 * first.
 *
 * Two entries only happen under the DeepSeek Anthropic wire: that routing
 * mirrors `OPENAI_DEFAULT_*_MODEL` onto the `ANTHROPIC_*` keys, but the mirror
 * runs from the CLI init path, so any consumer that builds this list without
 * having gone through it still needs the OPENAI_* originals — otherwise the
 * picker falls back to Anthropic's built-in list, which is exactly the bug
 * this pair of prefixes exists to prevent.
 */
function tierEnvPrefixes(): readonly string[] {
  const provider = getAPIProvider()
  if (provider === 'openai') return ['OPENAI']
  if (provider === 'gemini') return ['GEMINI']
  if (provider === 'grok') return ['GROK']
  if (isDeepSeekAnthropicWireActive()) return ['ANTHROPIC', 'OPENAI']
  return ['ANTHROPIC']
}

function tierEnv(
  tier: Uppercase<ModelTier>,
  suffix: string,
): string | undefined {
  for (const prefix of tierEnvPrefixes()) {
    const value = process.env[`${prefix}_DEFAULT_${tier}_MODEL${suffix}`]
    if (value) return value
  }
  return undefined
}

/**
 * The picker row for a tier the user pinned to their own model id.
 *
 * One function rather than the four copy-pasted ones this replaces: they
 * differed only in the tier word, and every provider added to the codebase had
 * to be threaded through all four (Grok never was).
 *
 * The row's value is the tier ALIAS, not the concrete id — that is what makes
 * `/model` and the per-tier settings in `settings.modelSettings` agree about
 * which knob the highlighted row belongs to.
 */
function getCustomTierOption(tier: ModelTier): ModelOption | undefined {
  if (!isThirdPartyModelCatalog()) return undefined
  const upper = tier.toUpperCase() as Uppercase<ModelTier>
  const model = tierEnv(upper, '')
  if (!model) return undefined

  const label = capitalize(tier)
  const is1m = has1mContext(model)
  const nameEnv = tierEnv(upper, '_NAME')
  const descEnv = tierEnv(upper, '_DESCRIPTION')
  return {
    value: tier,
    label: nameEnv ?? model,
    description:
      descEnv ?? `Custom ${label} model${is1m ? ' (1M context)' : ''}`,
    descriptionForModel: `${descEnv ?? `Custom ${label} model${is1m ? ' with 1M context' : ''}`} (${model})`,
  }
}

// @[MODEL LAUNCH]: Update or add model option functions (getSonnetXXOption, getOpusXXOption, etc.)
// with the new model's label and description. These appear in the /model picker.
function getSonnet5Option(): ModelOption {
  const is3P = isThirdPartyModelCatalog()
  return {
    value: is3P ? getModelStrings().sonnet5 : 'sonnet',
    label: 'Sonnet',
    description: `Sonnet 5 · Best for everyday tasks${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel:
      'Sonnet 5 - best for everyday tasks. Generally recommended for most coding tasks',
  }
}

function getOpus5Option(fastMode = false): ModelOption {
  const is3P = isThirdPartyModelCatalog()
  return {
    value: is3P ? getModelStrings().opus5 : 'opus',
    label: 'Opus 5',
    description: `Opus 5 · Most capable for complex work${getOpusPricingSuffix(fastMode)}`,
    descriptionForModel: 'Opus 5 - most capable for complex work',
  }
}

export function getOpus46Option(fastMode = false): ModelOption {
  // Always use the canonical 4.6 model string (not the 'opus' alias, which
  // resolves via getDefaultOpusModel() to opus47 on firstParty). Users
  // selecting "Opus 4.6" must get 4.6 actually dispatched, not alias-routed
  // to 4.7. The same string is correct for 3P (getModelStrings maps per
  // provider).
  return {
    value: getModelStrings().opus46,
    label: 'Opus 4.6',
    description: `Opus 4.6 · Previous generation Opus${getOpusPricingSuffix(fastMode)}`,
    descriptionForModel: 'Opus 4.6 - previous generation Opus model',
  }
}

export function getSonnet5_1MOption(): ModelOption {
  const is3P = isThirdPartyModelCatalog()
  return {
    value: is3P ? getModelStrings().sonnet5 + '[1m]' : 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 5 for long sessions${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel:
      'Sonnet 5 with 1M context window - for long sessions with large codebases',
  }
}

export function getOpus5_1MOption(fastMode = false): ModelOption {
  const is3P = isThirdPartyModelCatalog()
  return {
    value: is3P ? getModelStrings().opus5 + '[1m]' : 'opus[1m]',
    label: 'Opus 5 (1M context)',
    description: `Opus 5 with 1M context${getOpusPricingSuffix(fastMode)}`,
    descriptionForModel:
      'Opus 5 with 1M context window - for long sessions with large codebases',
  }
}

/**
 * Opus 4.7 — the immediate predecessor. Always the canonical 4.7 string (never
 * the 'opus' alias, which now resolves to Opus 5 on firstParty), so picking it
 * actually dispatches 4.7. Same reasoning as getOpus46Option below.
 */
export function getOpus47_1MOption(fastMode = false): ModelOption {
  return {
    value: getModelStrings().opus47 + '[1m]',
    label: 'Opus 4.7 (1M context)',
    description: `Opus 4.7 with 1M context · Previous generation Opus${getOpusPricingSuffix(fastMode)}`,
    descriptionForModel:
      'Opus 4.7 with 1M context window - previous generation Opus model',
  }
}

export function getOpus46_1MOption(fastMode = false): ModelOption {
  return {
    value: getModelStrings().opus46 + '[1m]',
    label: 'Opus 4.6 (1M context)',
    description: `Opus 4.6 with 1M context${getOpusPricingSuffix(fastMode)}`,
    descriptionForModel:
      'Opus 4.6 with 1M context window - for long sessions with large codebases',
  }
}

export function getFable5Option(): ModelOption {
  const is3P = isThirdPartyModelCatalog()
  return {
    value: is3P ? getModelStrings().fable5 : 'fable',
    label: 'Fable',
    description: `Fable 5 · Highest capability for the hardest work${is3P ? '' : ` · ${formatModelPricing(COST_TIER_10_50)}`}`,
    descriptionForModel:
      'Fable 5 - highest capability tier, for the most demanding reasoning and long-horizon agentic work. Costs more than Opus; prefer Opus unless the task needs it.',
  }
}

export function getFable5_1MOption(): ModelOption {
  const is3P = isThirdPartyModelCatalog()
  return {
    value: is3P ? getModelStrings().fable5 + '[1m]' : 'fable[1m]',
    label: 'Fable (1M context)',
    description: `Fable 5 with 1M context${is3P ? '' : ` · ${formatModelPricing(COST_TIER_10_50)}`}`,
    descriptionForModel:
      'Fable 5 with 1M context window - highest capability tier for long sessions with large codebases',
  }
}

function getHaiku45Option(): ModelOption {
  const is3P = isThirdPartyModelCatalog()
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 4.5 · Fastest for quick answers${is3P ? '' : ` · ${formatModelPricing(COST_HAIKU_45)}`}`,
    descriptionForModel:
      'Haiku 4.5 - fastest for quick answers. Lower cost but less capable than Sonnet 5.',
  }
}

function getHaiku35Option(): ModelOption {
  const is3P = isThirdPartyModelCatalog()
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 3.5 for simple tasks${is3P ? '' : ` · ${formatModelPricing(COST_HAIKU_35)}`}`,
    descriptionForModel:
      'Haiku 3.5 - faster and lower cost, but less capable than Sonnet. Use for simple tasks.',
  }
}

function getHaikuOption(): ModelOption {
  // Return correct Haiku option based on provider
  const haikuModel = getDefaultHaikuModel()
  return haikuModel === getModelStrings().haiku45
    ? getHaiku45Option()
    : getHaiku35Option()
}

function getMaxOpusOption(fastMode = false): ModelOption {
  return {
    value: 'opus',
    label: 'Opus 5',
    description: `Opus 5 · Most capable for complex work${fastMode ? getOpusPricingSuffix(true) : ''}`,
  }
}

export function getMaxSonnet5_1MOption(): ModelOption {
  const is3P = isThirdPartyModelCatalog()
  const billingInfo = isClaudeAISubscriber() ? ' · Billed as extra usage' : ''
  return {
    value: 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 5 with 1M context${billingInfo}${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
  }
}

export function getMaxOpus5_1MOption(fastMode = false): ModelOption {
  const billingInfo = isClaudeAISubscriber() ? ' · Billed as extra usage' : ''
  return {
    value: 'opus[1m]',
    label: 'Opus 5 (1M context)',
    description: `Opus 5 with 1M context${billingInfo}${getOpusPricingSuffix(fastMode)}`,
  }
}

function getMergedOpus1MOption(fastMode = false): ModelOption {
  const is3P = isThirdPartyModelCatalog()
  return {
    value: is3P ? getModelStrings().opus5 + '[1m]' : 'opus[1m]',
    label: 'Opus 5 (1M context)',
    description: `Opus 5 with 1M context · Most capable for complex work${!is3P && fastMode ? getOpusPricingSuffix(fastMode) : ''}`,
    descriptionForModel:
      'Opus 5 with 1M context - most capable for complex work',
  }
}

const MaxSonnet5Option: ModelOption = {
  value: 'sonnet',
  label: 'Sonnet',
  description: 'Sonnet 5 · Best for everyday tasks',
}

const MaxHaiku45Option: ModelOption = {
  value: 'haiku',
  label: 'Haiku',
  description: 'Haiku 4.5 · Fastest for quick answers',
}

function getOpusPlanOption(): ModelOption {
  return {
    value: 'opusplan',
    label: 'Opus Plan Mode',
    description: 'Use Opus 5 in plan mode, Sonnet 5 otherwise',
  }
}

function getChatGPTCodexModelOptions(): ModelOption[] {
  return [
    {
      value: null,
      label: 'Default (recommended)',
      description: `Use the default ChatGPT Codex model (currently ${CHATGPT_CODEX_DEFAULT_MODEL})`,
      descriptionForModel: `Default ChatGPT Codex model (currently ${CHATGPT_CODEX_DEFAULT_MODEL})`,
    },
    ...CHATGPT_CODEX_MODEL_OPTIONS.map(model => ({
      value: model.value,
      label: model.label,
      description: model.description,
      descriptionForModel: `${model.description} (${model.value})`,
    })),
  ]
}

// @[MODEL LAUNCH]: Update the model picker lists below to include/reorder options for the new model.
// Each user tier (ant, Max/Team Premium, Pro/Team Standard/Enterprise, PAYG 1P, PAYG 3P) has its own list.
function getModelOptionsBase(fastMode = false): ModelOption[] {
  if (process.env.USER_TYPE === 'ant') {
    // Build options from antModels config
    const antModelOptions: ModelOption[] = getAntModels().map(m => ({
      value: m.alias,
      label: m.label,
      description: m.description ?? `[ANT-ONLY] ${m.label} (${m.model})`,
    }))

    return [
      getDefaultOptionForUser(),
      ...antModelOptions,
      getMergedOpus1MOption(fastMode),
      getFable5Option(),
      getFable5_1MOption(),
      getSonnet5Option(),
      getSonnet5_1MOption(),
      getHaiku45Option(),
    ]
  }

  if (getAPIProvider() === 'openai' && isChatGPTAuthMode()) {
    return getChatGPTCodexModelOptions()
  }

  // Subscriber lists describe what a Claude.ai plan entitles you to, so they
  // only make sense while the session is actually pointed at Anthropic. A user
  // who logged in with /login and then switched to a third-party provider can
  // reach exactly one catalog — the provider's — and listing Opus 5 at
  // Anthropic's rate card for them is the same bug as listing it for DeepSeek.
  if (isClaudeAISubscriber() && !isThirdPartyModelCatalog()) {
    if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
      // Max and Team Premium users: Default = Opus 5 1M (merged), plus Opus 4.7 1M
      const premiumOptions = [getDefaultOptionForUser(fastMode)]
      premiumOptions.push(getOpus47_1MOption(fastMode))

      // Fable sits above Opus in capability and price — listed after the Opus
      // entries so the descending-capability order still reads top-down without
      // making the priciest tier the first thing under "Default".
      premiumOptions.push(getFable5Option())
      premiumOptions.push(getFable5_1MOption())

      premiumOptions.push(MaxSonnet5Option)
      if (checkSonnet1mAccess()) {
        premiumOptions.push(getMaxSonnet5_1MOption())
      }

      premiumOptions.push(MaxHaiku45Option)
      return premiumOptions
    }

    // Pro/Team Standard/Enterprise users: Sonnet is default, show Opus 5 1M + Opus 4.7 1M
    const standardOptions = [getDefaultOptionForUser(fastMode)]

    if (isOpus1mMergeEnabled()) {
      standardOptions.push(getMergedOpus1MOption(fastMode))
    } else {
      standardOptions.push(getMaxOpusOption(fastMode))
      if (checkOpus1mAccess()) {
        standardOptions.push(getMaxOpus5_1MOption(fastMode))
      }
    }
    standardOptions.push(getOpus47_1MOption(fastMode))

    standardOptions.push(getFable5Option())
    standardOptions.push(getFable5_1MOption())

    if (checkSonnet1mAccess()) {
      standardOptions.push(getMaxSonnet5_1MOption())
    }

    standardOptions.push(MaxHaiku45Option)
    return standardOptions
  }

  // PAYG 1P API: Default (Sonnet) + Opus 5 1M + Opus 4.7 1M + Fable + Sonnet 1M + Haiku
  if (!isThirdPartyModelCatalog()) {
    const payg1POptions = [getDefaultOptionForUser(fastMode)]
    if (isOpus1mMergeEnabled()) {
      payg1POptions.push(getMergedOpus1MOption(fastMode))
    } else {
      payg1POptions.push(getOpus5Option(fastMode))
      if (checkOpus1mAccess()) {
        payg1POptions.push(getOpus5_1MOption(fastMode))
      }
    }
    payg1POptions.push(getOpus47_1MOption(fastMode))
    payg1POptions.push(getFable5Option())
    payg1POptions.push(getFable5_1MOption())
    if (checkSonnet1mAccess()) {
      payg1POptions.push(getSonnet5_1MOption())
    }
    payg1POptions.push(getHaiku45Option())
    return payg1POptions
  }

  // PAYG 3P: Default (Sonnet 5) + Sonnet (3P custom) or Sonnet 5/1M + Opus (3P custom) or Opus 5 1M/Opus 4.7 1M + Fable + Haiku
  const payg3pOptions = [getDefaultOptionForUser(fastMode)]

  const customSonnet = getCustomTierOption('sonnet')
  if (customSonnet !== undefined) {
    payg3pOptions.push(customSonnet)
  } else {
    // Explicit Sonnet entry so 3P users can pin it rather than ride "Default"
    payg3pOptions.push(getSonnet5Option())
    if (checkSonnet1mAccess()) {
      payg3pOptions.push(getSonnet5_1MOption())
    }
  }

  const customOpus = getCustomTierOption('opus')
  if (customOpus !== undefined) {
    payg3pOptions.push(customOpus)
  } else {
    // Add Opus 5 1M + Opus 4.7 1M (no redundant non-1M entries)
    payg3pOptions.push(getOpus5_1MOption(fastMode))
    payg3pOptions.push(getOpus47_1MOption(fastMode))
  }
  const customFable = getCustomTierOption('fable')
  if (customFable !== undefined) {
    payg3pOptions.push(customFable)
  } else {
    payg3pOptions.push(getFable5Option())
    payg3pOptions.push(getFable5_1MOption())
  }

  const customHaiku = getCustomTierOption('haiku')
  if (customHaiku !== undefined) {
    payg3pOptions.push(customHaiku)
  } else {
    payg3pOptions.push(getHaikuOption())
  }
  return payg3pOptions
}

// @[MODEL LAUNCH]: Add the new model ID to the appropriate family pattern below
// so the "newer version available" hint works correctly.
/**
 * Map a full model name to its family alias and the marketing name of the
 * version the alias currently resolves to. Used to detect when a user has
 * a specific older version pinned and a newer one is available.
 */
function getModelFamilyInfo(
  model: string,
): { alias: string; currentVersionName: string } | null {
  const canonical = getCanonicalName(model)

  // Sonnet family
  if (
    canonical.includes('claude-sonnet-5') ||
    canonical.includes('claude-sonnet-4-6') ||
    canonical.includes('claude-sonnet-4-5') ||
    canonical.includes('claude-sonnet-4-') ||
    canonical.includes('claude-3-7-sonnet') ||
    canonical.includes('claude-3-5-sonnet')
  ) {
    const currentName = getMarketingNameForModel(getDefaultSonnetModel())
    if (currentName) {
      return { alias: 'Sonnet', currentVersionName: currentName }
    }
  }

  // Opus family
  if (
    canonical.includes('claude-opus-5') ||
    canonical.includes('claude-opus-4')
  ) {
    const currentName = getMarketingNameForModel(getDefaultOpusModel())
    if (currentName) {
      return { alias: 'Opus', currentVersionName: currentName }
    }
  }

  // Fable family
  if (canonical.includes('claude-fable')) {
    const currentName = getMarketingNameForModel(getDefaultFableModel())
    if (currentName) {
      return { alias: 'Fable', currentVersionName: currentName }
    }
  }

  // Haiku family
  if (
    canonical.includes('claude-haiku') ||
    canonical.includes('claude-3-5-haiku')
  ) {
    const currentName = getMarketingNameForModel(getDefaultHaikuModel())
    if (currentName) {
      return { alias: 'Haiku', currentVersionName: currentName }
    }
  }

  return null
}

/**
 * Returns a ModelOption for a known Anthropic model with a human-readable
 * label, and an upgrade hint if a newer version is available via the alias.
 * Returns null if the model is not recognized.
 */
function getKnownModelOption(model: string): ModelOption | null {
  const marketingName = getMarketingNameForModel(model)
  if (!marketingName) return null

  const familyInfo = getModelFamilyInfo(model)
  if (!familyInfo) {
    return {
      value: model,
      label: marketingName,
      description: model,
    }
  }

  // Check if the alias currently resolves to a different (newer) version
  if (marketingName !== familyInfo.currentVersionName) {
    return {
      value: model,
      label: marketingName,
      description: `Newer version available · select ${familyInfo.alias} for ${familyInfo.currentVersionName}`,
    }
  }

  // Same version as the alias — just show the friendly name
  return {
    value: model,
    label: marketingName,
    description: model,
  }
}

export function getModelOptions(fastMode = false): ModelOption[] {
  let options = getModelOptionsBase(fastMode)

  // Add the custom model from the ANTHROPIC_CUSTOM_MODEL_OPTION env var
  const envCustomModel = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  if (
    envCustomModel &&
    !options.some(existing => existing.value === envCustomModel)
  ) {
    options.push({
      value: envCustomModel,
      label: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ?? envCustomModel,
      description:
        process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION ??
        `Custom model (${envCustomModel})`,
    })
  }

  // Append additional model options fetched during bootstrap
  for (const opt of getGlobalConfig().additionalModelOptionsCache ?? []) {
    if (!options.some(existing => existing.value === opt.value)) {
      options.push(opt)
    }
  }

  // Antigravity sessions surface the backend's own model ids here — the
  // model-catalog fetcher below can't discover them (the v1internal backend
  // has no key-authenticated /models endpoint for the startup refresh to hit).
  if (isAntigravityAuthMode()) {
    for (const opt of ANTIGRAVITY_MODEL_OPTIONS) {
      if (!options.some(existing => existing.value === opt.value)) {
        options.push({
          value: opt.value,
          label: opt.label,
          description: `${opt.description} · ${opt.contextWindow} context`,
        })
      }
    }
  }

  // A configured China-preset endpoint offers its whole catalog: one API key,
  // every model. These come from the curated table rather than the endpoint's
  // /models answer, so they carry labels, pricing and context windows, and they
  // are here the moment login finishes — the background catalog refresh below
  // only lands later, and would list bare ids.
  // DeepSeek is one of these presets and is also the one provider whose
  // getAPIProvider() now answers 'firstParty' (its Anthropic-compatible wire),
  // so this cannot be a plain provider === 'openai' test any more — the whole
  // curated catalog would vanish from the picker for exactly one provider.
  const chinaPreset = findChinaProviderByBaseURL(process.env.OPENAI_BASE_URL)
  if (
    chinaPreset &&
    (getAPIProvider() === 'openai' || isDeepSeekAnthropicWireActive())
  ) {
    for (const model of chinaPreset.models) {
      if (options.some(existing => existing.value === model.id)) continue
      const price =
        model.inputPricePerMTok === 0 && model.outputPricePerMTok === 0
          ? 'Free'
          : `¥${model.inputPricePerMTok}/¥${model.outputPricePerMTok} per Mtok`
      options.push({
        value: model.id,
        label: model.label,
        description: `${price} · ${model.contextWindow} context`,
      })
    }
  }

  // Append whatever the background model-catalog refresh last read from the
  // active provider's /models endpoint (src/services/modelCatalog/). Built-ins
  // above keep their exact order and stay first — this only ever adds ids the
  // hand-maintained table above does not know about yet. Reads a disk cache
  // only; no network call happens on this path.
  options = mergeCatalogModelOptions(
    options,
    getCachedModelCatalog(catalogKeyForProvider(getAPIProvider())),
  )

  // Add custom model from either the current model value or the initial one
  // if it is not already in the options.
  let customModel: ModelSetting = null
  const currentMainLoopModel = getUserSpecifiedModelSetting()
  const initialMainLoopModel = getInitialMainLoopModel()
  if (currentMainLoopModel !== undefined && currentMainLoopModel !== null) {
    customModel = currentMainLoopModel
  } else if (initialMainLoopModel !== null) {
    customModel = initialMainLoopModel
  }
  if (customModel === null || options.some(opt => opt.value === customModel)) {
    return filterModelOptionsByAllowlist(options)
  } else if (customModel === 'opusplan') {
    return filterModelOptionsByAllowlist([...options, getOpusPlanOption()])
  } else if (customModel === 'opus' && !isThirdPartyModelCatalog()) {
    return filterModelOptionsByAllowlist([
      ...options,
      getMaxOpusOption(fastMode),
    ])
  } else if (customModel === 'opus[1m]' && !isThirdPartyModelCatalog()) {
    return filterModelOptionsByAllowlist([
      ...options,
      getMergedOpus1MOption(fastMode),
    ])
  } else if (customModel === 'fable' && !isThirdPartyModelCatalog()) {
    return filterModelOptionsByAllowlist([...options, getFable5Option()])
  } else if (customModel === 'fable[1m]' && !isThirdPartyModelCatalog()) {
    return filterModelOptionsByAllowlist([...options, getFable5_1MOption()])
  } else {
    // Try to show a human-readable label for known Anthropic models, with an
    // upgrade hint if the alias now resolves to a newer version.
    const knownOption = getKnownModelOption(customModel)
    if (knownOption) {
      options.push(knownOption)
    } else {
      options.push({
        value: customModel,
        label: customModel,
        description: 'Custom model',
      })
    }
    return filterModelOptionsByAllowlist(options)
  }
}

/**
 * Filter model options by the availableModels allowlist.
 * Always preserves the "Default" option (value: null).
 */
function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getSettings_DEPRECATED() || {}
  if (!settings.availableModels) {
    return options // No restrictions
  }
  return options.filter(
    opt =>
      opt.value === null || (opt.value !== null && isModelAllowed(opt.value)),
  )
}
