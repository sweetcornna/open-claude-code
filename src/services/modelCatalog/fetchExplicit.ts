/**
 * Explicit-credential model-list fetch for the login setup forms.
 *
 * Deliberately a separate leaf from ./fetch.ts: that module (dynamically)
 * imports the auth chain for the Anthropic fetcher, and the setup UI imports
 * this one statically — routing it through fetch.ts closes an import cycle
 * from the components graph back into auth and trips the check:cycles
 * ratchet. This file may only depend on the OpenAI client (dynamic import),
 * telemetry, and the catalog types.
 *
 * Same error contract as ./fetch.ts: never throws, never writes to stderr;
 * failures resolve to `null` with a user-readable reason via `onError`.
 */

import { logForDebugging } from 'src/utils/telemetry/debug.js'
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
