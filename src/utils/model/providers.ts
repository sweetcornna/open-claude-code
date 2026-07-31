import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { getInitialSettings } from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import { isEnvTruthy } from '../envUtils.js'

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
