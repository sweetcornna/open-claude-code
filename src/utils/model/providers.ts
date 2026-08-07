import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isDeepSeekAnthropicWireActive } from './deepseekWire.js'
import { getInitialSettings } from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import { isEnvTruthy } from '../config/envUtils.js'

export type APIProvider =
  | 'firstParty'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'openai'
  | 'gemini'
  | 'grok'

export function getAPIProvider(
  settings: Pick<SettingsJson, 'modelType'> = getInitialSettings(),
): APIProvider {
  // DeepSeek is configured through the OPENAI_* keys, but its
  // Anthropic-compatible endpoint is a strictly better fit: occ's own wire
  // format (no lossy round-trip), native thinking blocks, and a server-side
  // web_search that the first-party search adapter already knows how to ask
  // for. Checked before modelType because that key says 'openai' for exactly
  // these users — see deepseekWire.ts for the full rationale and the
  // CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE=0 escape hatch.
  if (isDeepSeekAnthropicWireActive()) return 'firstParty'

  const modelType = settings.modelType
  if (modelType === 'openai') return 'openai'
  if (modelType === 'gemini') return 'gemini'
  if (modelType === 'grok') return 'grok'

  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) return 'bedrock'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) return 'vertex'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) return 'foundry'

  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)) return 'openai'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI)) return 'gemini'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_GROK)) return 'grok'

  return 'firstParty'
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Whether the models this session can reach belong to somebody other than
 * Anthropic.
 *
 * This is NOT the same question as `getAPIProvider() !== 'firstParty'`, even
 * though the codebase spelled it that way roughly forty times. That one asks
 * "which wire format and client do we use". Since the DeepSeek Anthropic-wire
 * routing landed, the two answers diverge for one configuration: DeepSeek
 * speaks the Anthropic Messages protocol, so the provider is `firstParty`
 * while every model behind it is a DeepSeek checkpoint.
 *
 * Everything that is really asking "is this Anthropic's own catalog" — the
 * `/model` list, $/Mtok pricing suffixes, Anthropic-only beta headers, the
 * legacy-model migrations, Fast mode, the bootstrap fetch — must ask this,
 * not the wire question. Reading the wire answer is what made a DeepSeek
 * session offer "Opus 5 · $5/$25 per Mtok".
 *
 * The rule this encodes: before the wire change a DeepSeek session was
 * `provider === 'openai'`, and the wire change must not switch on a single
 * Anthropic-only behaviour that was off then. The deliberate exceptions are
 * the wire format itself, native thinking blocks, prompt caching and the
 * server-side web-search adapter — all verified against the real endpoint.
 */
export function isThirdPartyModelCatalog(): boolean {
  return getAPIProvider() !== 'firstParty' || isDeepSeekAnthropicWireActive()
}

/**
 * Whether an id like `claude-opus-5` denotes Anthropic's Opus 5 in this
 * session.
 *
 * Three questions get confused around here. Keep them apart:
 *
 *   getAPIProvider()           — which wire format and client
 *   isThirdPartyModelCatalog() — whose catalog and whose rate card
 *   servesAnthropicModels()    — whether Claude model ids mean what they say
 *
 * Bedrock, Vertex and Foundry answer "third party" to the second question —
 * separate billing, different beta support — but YES to this one: they serve
 * real Claude checkpoints, so `us.anthropic.claude-opus-5-v1` is Opus 5 and
 * naming it that is correct.
 *
 * OpenAI-compatible endpoints, Gemini, Grok and the DeepSeek Anthropic wire
 * answer no, and this is not hypothetical: ALL_MODEL_CONFIGS maps every tier
 * onto the SAME `claude-*` strings for those providers, so a tier the user has
 * not configured resolves to a literal `claude-fable-5`. DeepSeek silently
 * remaps that to its own checkpoint; everyone else 404s. Calling it "Fable 5"
 * then tells the user — and, through the system prompt, the model itself —
 * that Anthropic's Fable is answering when it is not.
 */
export function servesAnthropicModels(): boolean {
  const provider = getAPIProvider()
  if (provider === 'openai' || provider === 'gemini' || provider === 'grok') {
    return false
  }
  return !isDeepSeekAnthropicWireActive()
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 *
 * NOTE: "unset" means "the Anthropic endpoint was not overridden", which is NOT
 * the same thing as "this session talks to Anthropic". A user who selects a
 * third-party provider through settings.modelType ('openai' / 'gemini' / 'grok')
 * normally leaves ANTHROPIC_BASE_URL alone, so this returns true for them too.
 * It is only a base-URL check and must always be paired with a provider check —
 * use isDirectAnthropicApi() rather than calling this on its own.
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}

/**
 * Whether this session talks directly to the Anthropic first-party API — the
 * selected provider is Anthropic *and* the endpoint has not been pointed at a
 * proxy or gateway.
 *
 * Both halves are required. isFirstPartyAnthropicBaseUrl() alone is true for
 * anyone who never set ANTHROPIC_BASE_URL, including users on a third-party
 * provider chosen via settings.modelType, and getAPIProvider() alone is true
 * for gateway users proxying Anthropic traffic through a custom base URL.
 */
export function isDirectAnthropicApi(
  settings: Pick<SettingsJson, 'modelType'> = getInitialSettings(),
): boolean {
  return (
    getAPIProvider(settings) === 'firstParty' && isFirstPartyAnthropicBaseUrl()
  )
}
