import OpenAI from 'openai'
import { openaiAdapter } from 'src/services/providerUsage/adapters/openai.js'
import { updateProviderBuckets } from 'src/services/providerUsage/store.js'
import { getProxyFetchOptions } from 'src/utils/network/proxy.js'
import {
  normalizeProviderBaseURL,
  splitProviderBaseURL,
} from 'src/utils/network/providerUrl.js'
import { clampOpenAIMaxRetries } from './retry.js'

/**
 * Environment variables:
 *
 * OPENAI_API_KEY: Required. API key for the OpenAI-compatible endpoint.
 * OPENAI_BASE_URL: Recommended. Base URL for the endpoint (e.g. http://localhost:11434/v1).
 * OPENAI_ORG_ID: Optional. Organization ID.
 * OPENAI_PROJECT_ID: Optional. Project ID.
 */

let cachedClient:
  | {
      apiKey: string
      baseURL: string | undefined
      maxRetries: number
      client: OpenAI
    }
  | undefined

/**
 * Wrap a fetch so that every response's rate-limit headers are fed into the
 * provider usage store. Errors in parsing must never break the request.
 *
 * The cast to `typeof fetch` is safe: OpenAI SDK only calls the function form,
 * not the static `preconnect` method that Bun/Node's `fetch` type declares.
 */
function wrapFetchForUsage(base: typeof fetch): typeof fetch {
  const wrapped = async (
    ...args: Parameters<typeof fetch>
  ): Promise<Response> => {
    const res = await base(...args)
    try {
      updateProviderBuckets('openai', openaiAdapter.parseHeaders(res.headers))
    } catch {
      // Ignore — usage tracking must not affect the request path.
    }
    return res
  }
  return wrapped as unknown as typeof fetch
}

export function getOpenAIClient(options?: {
  maxRetries?: number
  fetchOverride?: typeof fetch
  source?: string
  apiKeyOverride?: string
  baseURLOverride?: string
}): OpenAI {
  const hasConnectionOverride =
    options?.apiKeyOverride !== undefined ||
    options?.baseURLOverride !== undefined
  const apiKey = options?.apiKeyOverride ?? process.env.OPENAI_API_KEY ?? ''
  const configuredBaseURL =
    options?.baseURLOverride ?? process.env.OPENAI_BASE_URL
  const baseURL = configuredBaseURL?.trim()
    ? normalizeProviderBaseURL(configuredBaseURL, 'openai')
    : undefined
  const connection = baseURL
    ? splitProviderBaseURL(baseURL, 'openai')
    : undefined
  const maxRetries = clampOpenAIMaxRetries(options?.maxRetries ?? 0, 0)
  if (
    cachedClient &&
    !hasConnectionOverride &&
    cachedClient.apiKey === apiKey &&
    cachedClient.baseURL === baseURL &&
    cachedClient.maxRetries === maxRetries
  ) {
    return cachedClient.client
  }

  const baseFetch = options?.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const wrappedFetch = wrapFetchForUsage(baseFetch)

  const client = new OpenAI({
    apiKey,
    ...(connection && connection),
    maxRetries,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    ...(process.env.OPENAI_ORG_ID && {
      organization: process.env.OPENAI_ORG_ID,
    }),
    ...(process.env.OPENAI_PROJECT_ID && {
      project: process.env.OPENAI_PROJECT_ID,
    }),
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: false }),
    fetch: wrappedFetch,
  })

  if (!options?.fetchOverride && !hasConnectionOverride) {
    cachedClient = { apiKey, baseURL, maxRetries, client }
  }

  return client
}

/** Clear the cached client (useful when env vars change). */
export function clearOpenAIClientCache(): void {
  cachedClient = undefined
}
