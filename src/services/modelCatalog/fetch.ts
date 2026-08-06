/**
 * Per-provider model-list fetchers.
 *
 * Every path here is best-effort: missing credentials, a network error, a
 * non-2xx status or an unparseable body all resolve to `null`. Nothing is
 * written to stderr and nothing is surfaced to the user — this only ever adds
 * options to the model picker, so failing quietly is the correct behavior.
 *
 * Provider clients are pulled in with dynamic `import()` so that neither the
 * OpenAI SDK nor the auth chain lands in the startup module graph: the whole
 * module is itself only reached from the delayed background refresh.
 */

import { OAUTH_BETA_HEADER } from 'src/constants/oauth.js'
import { getProxyFetchOptions } from 'src/utils/network/proxy.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import { isChatGPTAuthMode } from 'src/utils/model/chatgptModels.js'
import { resolveProviderBaseURL } from './cache.js'
import {
  ANTHROPIC_VERSION,
  joinVersionedPath,
  PAGE_LIMIT,
  parseAnthropicModelsResponse,
  parseGeminiModelsResponse,
} from './parse.js'
import type { CatalogModel } from './types.js'

// The parsers moved to ./parse.js so the login setup UI can reuse them without
// dragging this module's proxy/cache/auth surface into the components graph.
// Re-exported here because the existing tests and callers import them from
// this module.
export { parseAnthropicModelsResponse, parseGeminiModelsResponse }

export type ModelCatalogFetchOptions = {
  signal?: AbortSignal
  /** Injected in tests; production uses the global fetch. */
  fetchImpl?: typeof fetch
}

async function fetchJSON(
  url: string,
  headers: Record<string, string>,
  options: ModelCatalogFetchOptions,
): Promise<unknown | null> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(url, {
    method: 'GET',
    headers,
    ...(options.signal ? { signal: options.signal } : {}),
    ...getProxyFetchOptions({ forAnthropicAPI: false }),
  })
  if (!response.ok) {
    logForDebugging(`[ModelCatalog] ${url} returned ${response.status}`)
    return null
  }
  return (await response.json()) as unknown
}

/**
 * Auth headers for the Anthropic model list, or null when nothing usable is
 * configured. API key wins: service-key OAuth tokens lack the profile scope
 * and would 403, matching what `src/services/api/bootstrap.ts` does.
 *
 * Kept pure and exported so tests can cover it without installing a
 * process-global mock of `src/utils/auth/auth.ts` (see CLAUDE.md on
 * mock.module pollution) — the real credentials are read by the caller.
 */
export function buildAnthropicAuthHeaders(credentials: {
  apiKey?: string | null
  oauthToken?: string | null
  hasProfileScope?: boolean
}): Record<string, string> | null {
  const base: Record<string, string> = {
    'anthropic-version': ANTHROPIC_VERSION,
    accept: 'application/json',
  }
  if (credentials.apiKey) {
    return { ...base, 'x-api-key': credentials.apiKey }
  }
  if (credentials.oauthToken && credentials.hasProfileScope) {
    return {
      ...base,
      authorization: `Bearer ${credentials.oauthToken}`,
      'anthropic-beta': OAUTH_BETA_HEADER,
    }
  }
  return null
}

async function fetchAnthropicModels(
  baseURL: string,
  options: ModelCatalogFetchOptions,
): Promise<CatalogModel[] | null> {
  const { getAnthropicApiKey, getClaudeAIOAuthTokens, hasProfileScope } =
    await import('src/utils/auth/auth.js')

  const headers = buildAnthropicAuthHeaders({
    apiKey: getAnthropicApiKey(),
    oauthToken: getClaudeAIOAuthTokens()?.accessToken,
    hasProfileScope: hasProfileScope(),
  })
  if (!headers) {
    logForDebugging('[ModelCatalog] Anthropic: no usable credentials')
    return null
  }

  const url = `${joinVersionedPath(baseURL, 'models')}?limit=${PAGE_LIMIT}`
  return parseAnthropicModelsResponse(await fetchJSON(url, headers, options))
}

/**
 * OpenAI-compatible `/models` via the shared client factory, so base URL,
 * org/project headers, proxy and mTLS settings all match the real request
 * path. Covers xAI/Grok too — its API is OpenAI-compatible.
 */
async function fetchOpenAICompatibleModels(
  provider: 'openai' | 'grok',
  options: ModelCatalogFetchOptions,
): Promise<CatalogModel[] | null> {
  if (provider === 'openai') {
    // The Codex backend behind ChatGPT subscription auth serves no /models
    // endpoint; the picker uses the curated CHATGPT_CODEX_MODEL_OPTIONS list.
    if (isChatGPTAuthMode()) {
      logForDebugging('[ModelCatalog] OpenAI: skipped (ChatGPT auth mode)')
      return null
    }
    if (!process.env.OPENAI_API_KEY) {
      logForDebugging('[ModelCatalog] OpenAI: no API key')
      return null
    }
  } else if (!process.env.GROK_API_KEY && !process.env.XAI_API_KEY) {
    logForDebugging('[ModelCatalog] Grok: no API key')
    return null
  }

  const client =
    provider === 'openai'
      ? (await import('src/services/api/openai/client.js')).getOpenAIClient({
          maxRetries: 0,
          ...(options.fetchImpl ? { fetchOverride: options.fetchImpl } : {}),
        })
      : (await import('src/services/api/grok/client.js')).getGrokClient({
          maxRetries: 0,
          ...(options.fetchImpl ? { fetchOverride: options.fetchImpl } : {}),
        })

  const page = await client.models.list({
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return page.data.map(model => ({
    id: model.id,
    ...(typeof model.created === 'number' && Number.isFinite(model.created)
      ? { created: model.created }
      : {}),
  }))
}

async function fetchGeminiModels(
  baseURL: string,
  options: ModelCatalogFetchOptions,
): Promise<CatalogModel[] | null> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    logForDebugging('[ModelCatalog] Gemini: no API key')
    return null
  }
  // GEMINI_BASE_URL already carries the version segment (…/v1beta).
  const url = `${baseURL}/models?pageSize=${PAGE_LIMIT}`
  return parseGeminiModelsResponse(
    await fetchJSON(
      url,
      { 'x-goog-api-key': apiKey, accept: 'application/json' },
      options,
    ),
  )
}

/**
 * Fetch the upstream model list for one provider. Never throws and never
 * writes to stderr; returns null whenever the catalog cannot be produced.
 */
export async function fetchProviderModels(
  provider: string,
  options: ModelCatalogFetchOptions = {},
): Promise<CatalogModel[] | null> {
  const baseURL = resolveProviderBaseURL(provider)
  if (baseURL === null) {
    logForDebugging(`[ModelCatalog] ${provider}: no model-list endpoint`)
    return null
  }
  try {
    switch (provider) {
      case 'firstParty':
        return await fetchAnthropicModels(baseURL, options)
      case 'openai':
      case 'grok':
        return await fetchOpenAICompatibleModels(provider, options)
      case 'gemini':
        return await fetchGeminiModels(baseURL, options)
      default:
        return null
    }
  } catch (error) {
    logForDebugging(`[ModelCatalog] ${provider} fetch failed: ${error}`)
    return null
  }
}
