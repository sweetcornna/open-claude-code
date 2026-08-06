/**
 * Explicit-credential model-list fetch for the login setup forms.
 *
 * Deliberately a separate leaf from ./fetch.ts: that module (dynamically)
 * imports the auth chain for the Anthropic fetcher, and the setup UI imports
 * this one statically — routing it through fetch.ts closes an import cycle
 * from the components graph back into auth and trips the check:cycles
 * ratchet. This file may only depend on the OpenAI client, the proxy stack
 * (both dynamic imports), the pure parsers in ./parse.js, telemetry, and the
 * catalog types.
 *
 * The distinction that justifies the whole file: ./fetch.ts reads credentials
 * out of process.env and the auth chain, which is exactly what the setup forms
 * do NOT have yet — the whole point is to validate a base URL and key the user
 * just typed, before anything is written to settings.
 *
 * Same error contract as ./fetch.ts: never throws, never writes to stderr;
 * failures resolve to `null` with a user-readable reason via `onError`.
 */

import { logForDebugging } from 'src/utils/telemetry/debug.js'
import {
  ANTHROPIC_VERSION,
  joinVersionedPath,
  PAGE_LIMIT,
  parseAnthropicModelsResponse,
  parseGeminiModelsResponse,
} from './parse.js'
import type { CatalogModel } from './types.js'

export type OpenAICompatibleModelsFetchOptions = {
  baseURL: string
  apiKey: string
  signal?: AbortSignal
  /** Injected in tests; production uses the global fetch. */
  fetchImpl?: typeof fetch
  /** Receives a user-readable reason while the function still returns null. */
  onError?: (reason: string) => void
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

/** Convert an OpenAI SDK/network failure into a short, user-readable reason. */
export function describeOpenAICompatibleModelsFetchError(
  error: unknown,
): string {
  const record = asRecord(error)
  const status =
    typeof record?.status === 'number' && Number.isFinite(record.status)
      ? record.status
      : undefined

  if (status === 401 || status === 403) {
    return `authentication failed (HTTP ${status})`
  }
  if (status === 404) {
    return 'the /models endpoint was not found (HTTP 404)'
  }
  if (status !== undefined) {
    return `the server returned HTTP ${status}`
  }

  if (record?.name === 'AbortError') return 'the request was canceled'

  const message =
    error instanceof Error
      ? error.message
      : typeof record?.message === 'string' && record.message.length > 0
        ? record.message
        : undefined

  // Node's fetch reports every transport failure as the bare string "fetch
  // failed" and hides the useful part (ECONNREFUSED, ENOTFOUND, a TLS error)
  // in `cause`. This reason is shown verbatim in the setup form's fallback
  // banner, where "fetch failed" tells the user nothing about whether the URL,
  // the port, or the network is wrong.
  const cause = asRecord(error)?.cause
  const causeMessage =
    cause instanceof Error
      ? cause.message
      : typeof asRecord(cause)?.message === 'string'
        ? (asRecord(cause)?.message as string)
        : undefined
  if (causeMessage && causeMessage !== message) {
    return message ? `${message} (${causeMessage})` : causeMessage
  }

  return message || 'an unknown error occurred'
}

/**
 * Fetch an OpenAI-compatible model list with credentials that have not been
 * saved to process.env yet. Never throws; failures resolve to null.
 */
export async function fetchOpenAICompatibleModelsWith({
  baseURL,
  apiKey,
  signal,
  fetchImpl,
  onError,
}: OpenAICompatibleModelsFetchOptions): Promise<CatalogModel[] | null> {
  const reportFailure = (reason: string): null => {
    logForDebugging(`[ModelCatalog] OpenAI explicit fetch failed: ${reason}`)
    try {
      onError?.(reason)
    } catch (error) {
      logForDebugging(
        `[ModelCatalog] OpenAI explicit error callback failed: ${error}`,
      )
    }
    return null
  }

  if (!baseURL.trim()) return reportFailure('the base URL is empty')
  if (!apiKey.trim()) return reportFailure('the API key is empty')

  try {
    new URL(baseURL)
  } catch {
    return reportFailure('the base URL is not a valid URL')
  }

  try {
    const { getOpenAIClient } = await import(
      'src/services/api/openai/client.js'
    )
    const client = getOpenAIClient({
      maxRetries: 0,
      apiKeyOverride: apiKey,
      baseURLOverride: baseURL,
      ...(fetchImpl ? { fetchOverride: fetchImpl } : {}),
    })
    const page = await client.models.list({ ...(signal ? { signal } : {}) })
    const models = page.data.flatMap(model => {
      if (!model.id) return []
      return [
        {
          id: model.id,
          ...(typeof model.created === 'number' &&
          Number.isFinite(model.created)
            ? { created: model.created }
            : {}),
        },
      ]
    })
    if (models.length === 0) {
      return reportFailure('the server returned an empty model list')
    }
    return models
  } catch (error) {
    return reportFailure(describeOpenAICompatibleModelsFetchError(error))
  }
}

/**
 * Shared preflight for the raw-fetch providers below. Mirrors the guards
 * `fetchOpenAICompatibleModelsWith` runs before touching the network, so all
 * three report the same reasons for the same user mistakes.
 */
function validateEndpoint(
  baseURL: string,
  apiKey: string,
  reportFailure: (reason: string) => null,
): 'ok' | null {
  if (!baseURL.trim()) return reportFailure('the base URL is empty')
  if (!apiKey.trim()) return reportFailure('the API key is empty')
  try {
    new URL(baseURL)
  } catch {
    return reportFailure('the base URL is not a valid URL')
  }
  return 'ok'
}

function makeFailureReporter(
  label: string,
  onError: ((reason: string) => void) | undefined,
): (reason: string) => null {
  return reason => {
    logForDebugging(`[ModelCatalog] ${label} explicit fetch failed: ${reason}`)
    try {
      onError?.(reason)
    } catch (error) {
      logForDebugging(
        `[ModelCatalog] ${label} explicit error callback failed: ${error}`,
      )
    }
    return null
  }
}

/**
 * GET the endpoint and parse it, translating every failure mode into the same
 * user-readable vocabulary the OpenAI path uses. The proxy stack is imported
 * dynamically to keep this module's static surface a leaf (see the file
 * header) — users behind a corporate proxy still need it honored here, since
 * this request runs before any settings exist to fall back on.
 */
async function fetchAndParse(
  url: string,
  headers: Record<string, string>,
  parse: (body: unknown) => CatalogModel[] | null,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch },
  reportFailure: (reason: string) => null,
): Promise<CatalogModel[] | null> {
  let proxyOptions: Record<string, unknown> = {}
  try {
    const { getProxyFetchOptions } = await import('src/utils/network/proxy.js')
    proxyOptions = getProxyFetchOptions({ forAnthropicAPI: false }) as Record<
      string,
      unknown
    >
  } catch {
    // No proxy configuration available — a direct request is still correct.
  }

  let response: Response
  try {
    const fetchImpl = options.fetchImpl ?? fetch
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      ...(options.signal ? { signal: options.signal } : {}),
      ...proxyOptions,
    })
  } catch (error) {
    return reportFailure(describeOpenAICompatibleModelsFetchError(error))
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return reportFailure(`authentication failed (HTTP ${response.status})`)
    }
    if (response.status === 404) {
      return reportFailure('the /models endpoint was not found (HTTP 404)')
    }
    return reportFailure(`the server returned HTTP ${response.status}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return reportFailure('the server returned a response that is not JSON')
  }

  const models = parse(body)
  if (!models) {
    return reportFailure('the model list was not in the expected format')
  }
  if (models.length === 0) {
    return reportFailure('the server returned an empty model list')
  }
  return models
}

/**
 * Fetch an Anthropic-compatible model list (`GET <base>/v1/models`) with
 * credentials that have not been saved yet. Never throws.
 */
export async function fetchAnthropicCompatibleModelsWith({
  baseURL,
  apiKey,
  signal,
  fetchImpl,
  onError,
}: OpenAICompatibleModelsFetchOptions): Promise<CatalogModel[] | null> {
  const reportFailure = makeFailureReporter('Anthropic', onError)
  if (!validateEndpoint(baseURL, apiKey, reportFailure)) return null

  const root = baseURL.replace(/\/+$/, '')
  return fetchAndParse(
    `${joinVersionedPath(root, 'models')}?limit=${PAGE_LIMIT}`,
    {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      accept: 'application/json',
    },
    parseAnthropicModelsResponse,
    { signal, fetchImpl },
    reportFailure,
  )
}

/**
 * Fetch a Gemini model list (`GET <base>/models`) with credentials that have
 * not been saved yet. Never throws.
 *
 * Unlike the Anthropic path there is no version-segment guessing: a Gemini
 * base URL always carries it already (…/v1beta), which is also what
 * GEMINI_BASE_URL is documented to hold.
 */
export async function fetchGeminiModelsWith({
  baseURL,
  apiKey,
  signal,
  fetchImpl,
  onError,
}: OpenAICompatibleModelsFetchOptions): Promise<CatalogModel[] | null> {
  const reportFailure = makeFailureReporter('Gemini', onError)
  if (!validateEndpoint(baseURL, apiKey, reportFailure)) return null

  const root = baseURL.replace(/\/+$/, '')
  return fetchAndParse(
    `${root}/models?pageSize=${PAGE_LIMIT}`,
    { 'x-goog-api-key': apiKey, accept: 'application/json' },
    parseGeminiModelsResponse,
    { signal, fetchImpl },
    reportFailure,
  )
}
