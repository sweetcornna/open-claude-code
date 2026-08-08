import OpenAI from 'openai'
import { getProxyFetchOptions } from 'src/utils/network/proxy.js'
import {
  normalizeProviderBaseURL,
  splitProviderBaseURL,
} from 'src/utils/network/providerUrl.js'
import { clampOpenAIMaxRetries } from '../openai/retry.js'

/**
 * Environment variables:
 *
 * GROK_API_KEY (or XAI_API_KEY): Required. API key for the xAI Grok endpoint.
 * GROK_BASE_URL: Optional. Defaults to https://api.x.ai/v1.
 */

const DEFAULT_BASE_URL = 'https://api.x.ai/v1'

let cachedClient:
  | {
      apiKey: string
      baseURL: string
      maxRetries: number
      client: OpenAI
    }
  | undefined

export function getGrokClient(options?: {
  maxRetries?: number
  fetchOverride?: typeof fetch
  source?: string
}): OpenAI {
  const apiKey = process.env.GROK_API_KEY || process.env.XAI_API_KEY || ''
  const baseURL = normalizeProviderBaseURL(
    process.env.GROK_BASE_URL || DEFAULT_BASE_URL,
    'openai',
  )
  const maxRetries = clampOpenAIMaxRetries(options?.maxRetries ?? 0, 0)
  if (
    cachedClient &&
    !options?.fetchOverride &&
    cachedClient.apiKey === apiKey &&
    cachedClient.baseURL === baseURL &&
    cachedClient.maxRetries === maxRetries
  ) {
    return cachedClient.client
  }
  const connection = splitProviderBaseURL(baseURL, 'openai')

  const client = new OpenAI({
    apiKey,
    ...connection,
    maxRetries,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: false }),
    ...(options?.fetchOverride && { fetch: options.fetchOverride }),
  })

  if (!options?.fetchOverride) {
    cachedClient = { apiKey, baseURL, maxRetries, client }
  }

  return client
}

export function clearGrokClientCache(): void {
  cachedClient = undefined
}
