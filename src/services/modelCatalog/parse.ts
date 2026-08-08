/**
 * Pure response parsers for the provider model-list endpoints.
 *
 * Split out of ./fetch.ts so ./fetchExplicit.ts can reuse them. fetch.ts
 * statically pulls in the proxy stack, the catalog cache and chatgptModels;
 * fetchExplicit.ts is imported *statically* by the login setup UI and must
 * stay a leaf or the components graph grows an edge into all of that (see the
 * note at the top of fetchExplicit.ts, and `bun run check:cycles`).
 *
 * Everything here is total: any shape that isn't recognized yields null or is
 * skipped. Nothing throws.
 */

import { buildProviderResourceURL } from 'src/utils/network/providerUrl.js'
import type { CatalogModel } from './types.js'

/** Anthropic requires an explicit API version on every request. */
export const ANTHROPIC_VERSION = '2023-06-01'
export const PAGE_LIMIT = 200

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
export function joinVersionedPath(
  baseURL: string,
  path: string,
  query: Record<string, string | number | undefined> = {},
): string {
  return buildProviderResourceURL(baseURL, 'anthropic', `v1/${path}`, query)
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
