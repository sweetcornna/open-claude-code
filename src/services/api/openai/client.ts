import OpenAI from 'openai'
import { openaiAdapter } from 'src/services/providerUsage/adapters/openai.js'
import { updateProviderBuckets } from 'src/services/providerUsage/store.js'
import { getProxyFetchOptions } from 'src/utils/network/proxy.js'
import { splitProviderBaseURL } from 'src/utils/network/providerUrl.js'
import {
  applyOpencodeWire,
  isOpencodeSessionActive,
} from 'src/utils/model/opencodeWire.js'
import { ensureOpencodeCredential } from '../opencodeCredential.js'
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
      connectionKey: string | undefined
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

/**
 * Attach the live OpenCode credential to each request.
 *
 * Not done at construction, because construction is synchronous and the
 * credential is not: it comes from a 0600 file whose OAuth pair is refreshed
 * roughly hourly. Baking one into the client would mean the first request of a
 * fresh login goes out with no key at all (the mirror had nothing to publish
 * yet) and every request after the first hour goes out with a dead one — and
 * this client is cached for the life of the process, so nothing would rebuild
 * it. A request is exactly the right granularity: it is already async, and it
 * is the moment at which "which token is valid" has an answer.
 *
 * Installed only for OpenCode sessions, so every other endpoint keeps the
 * fetch it had.
 */
function wrapFetchForOpencodeAuth(base: typeof fetch): typeof fetch {
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const auth = await ensureOpencodeCredential()
    if (!auth) return base(input, init)
    const headers = new Headers(init?.headers)
    for (const [name, value] of Object.entries(auth)) {
      headers.set(name, value)
    }
    return base(input, { ...init, headers })
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
  // Republish OPENCODE_* onto the OPENAI_* keys read three lines down. The
  // synchronous half of the mirror only — it uses whichever token is already
  // cached, and the wrapper below is what guarantees the request carries a live
  // one. Placed here rather than at the call sites for the reason the DeepSeek
  // lane learned the hard way: chasing every path that mutates provider env is
  // whack-a-mole, and applying it where the client is built makes a request
  // impossible to construct from an unapplied mirror.
  applyOpencodeWire()

  const hasConnectionOverride =
    options?.apiKeyOverride !== undefined ||
    options?.baseURLOverride !== undefined
  const apiKey = options?.apiKeyOverride ?? process.env.OPENAI_API_KEY ?? ''
  const configuredBaseURL =
    options?.baseURLOverride ?? process.env.OPENAI_BASE_URL
  // Derive the SDK connection once. In particular, `/chat/completions` means
  // the root route while a bare origin means `/v1`; normalizing once here and
  // again inside split used to erase that distinction.
  const connection = configuredBaseURL?.trim()
    ? splitProviderBaseURL(configuredBaseURL, 'openai')
    : undefined
  const connectionKey = connection
    ? JSON.stringify({
        baseURL: connection.baseURL,
        defaultQuery: connection.defaultQuery ?? null,
      })
    : undefined
  const maxRetries = clampOpenAIMaxRetries(options?.maxRetries ?? 0, 0)
  if (
    cachedClient &&
    !hasConnectionOverride &&
    cachedClient.apiKey === apiKey &&
    cachedClient.connectionKey === connectionKey &&
    cachedClient.maxRetries === maxRetries
  ) {
    return cachedClient.client
  }

  const baseFetch = options?.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const wrappedFetch = wrapFetchForUsage(
    isOpencodeSessionActive() ? wrapFetchForOpencodeAuth(baseFetch) : baseFetch,
  )

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
    cachedClient = { apiKey, connectionKey, maxRetries, client }
  }

  return client
}

/** Clear the cached client (useful when env vars change). */
export function clearOpenAIClientCache(): void {
  cachedClient = undefined
}
