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
import type { CatalogModel } from './types.js'

export type ModelCatalogFetchOptions = {
  signal?: AbortSignal
  /** Injected in tests; production uses the global fetch. */
  fetchImpl?: typeof fetch
}

/** Anthropic requires an explicit API version on every request. */
const ANTHROPIC_VERSION = '2023-06-01'
const PAGE_LIMIT = 200

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Anthropic reports ISO-8601 `created_at`; OpenAI reports unix `created`. */
function toUnixSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  }
  return undefined
}

/**
 * A base URL may or may not already carry the version segment: the default
 * Anthropic endpoint does not, while gateways commonly configure
 * `ANTHROPIC_BASE_URL=https://gw.example.com/v1`.
 */
function joinVersionedPath(baseURL: string, path: string): string {
  return /\/v1$/.test(baseURL) ? `${baseURL}/${path}` : `${baseURL}/v1/${path}`
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

/** Parse an Anthropic `GET /v1/models` body. Null when the shape is wrong. */
export function parseAnthropicModelsResponse(
  body: unknown,
): CatalogModel[] | null {
  const data = asRecord(body)?.data
  if (!Array.isArray(data)) return null
  return data.flatMap(item => {
    const model = asRecord(item)
    const id = asString(model?.id)
    if (!id) return []
    const displayName = asString(model?.display_name)
    const created = toUnixSeconds(model?.created_at)
    return [
      {
        id,
        ...(displayName ? { displayName } : {}),
        ...(created !== undefined ? { created } : {}),
      },
    ]
  })
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

/** Parse a Gemini `GET v1beta/models` body. Null when the shape is wrong. */
export function parseGeminiModelsResponse(
  body: unknown,
): CatalogModel[] | null {
  const models = asRecord(body)?.models
  if (!Array.isArray(models)) return null
  return models.flatMap(item => {
    const model = asRecord(item)
    const name = asString(model?.name)
    if (!name) return []
    // Only generation models can drive the main loop; the same list also
    // carries embedding and answer-attribution endpoints.
    const methods = model?.supportedGenerationMethods
    if (Array.isArray(methods) && !methods.includes('generateContent')) {
      return []
    }
    const id = name.replace(/^models\//, '')
    if (!id) return []
    const displayName = asString(model?.displayName)
    return [{ id, ...(displayName ? { displayName } : {}) }]
  })
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
