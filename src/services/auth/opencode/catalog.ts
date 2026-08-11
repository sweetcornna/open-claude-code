/**
 * What models an OpenCode credential can actually reach.
 *
 * Two sources, deliberately ordered:
 *
 *   1. `GET {console}/api/config` — the ENTITLEMENT answer. It is per-org and
 *      only OAuth credentials have one, but it is the only source that knows
 *      about enterprise deployments serving their own providers. sst/opencode
 *      treats a 404 here as "no remote config", not as an error, and so do we.
 *   2. `GET {base}/models` — the CATALOG answer. Public on both inference bases
 *      (verified: 200 with no credential — 61 models on Zen, 25 on Go),
 *      OpenAI-shaped, and identical for everyone on that product.
 *
 * The public list is the fallback rather than the primary because an org whose
 * plan excludes a model would otherwise be offered it and fail at first use.
 * It is still the right answer for a plain Zen API key, which has no console
 * account behind it to ask.
 *
 * The base URL is an ARGUMENT rather than a constant because Zen and Go are
 * different endpoints with different catalogs; asking Zen on behalf of a Go
 * session offers 61 models where the subscription serves 25. What is NOT
 * per-product is the entitlement answer: `/api/config` describes the account,
 * and whether it narrows to the product being configured is unverified. Should
 * it turn out to answer with the account's full Zen catalog for a Go session,
 * the fix belongs here — but inventing an intersection against a table occ
 * ships would silently hide models a real deployment does serve.
 */

import type { CatalogModel } from 'src/services/modelCatalog/types.js'
import { opencodeAuthHeaders, type OpencodeCredential } from './oauth.js'

type JsonRecord = Record<string, unknown>

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined
}

/**
 * Models from the org's entitlement config.
 *
 * `/api/config` returns `{ config: { provider: { <providerID>: { models: {
 * <modelID>: { name?, … } } } } } }`. Every provider in it is reachable
 * through the same credential, so the ids are flattened into one list — occ
 * has a single model axis, not opencode's provider×model pair.
 *
 * Returns null (not an empty list) when the console has nothing to say, so the
 * caller can tell "no remote config" apart from "entitled to nothing".
 */
async function fetchEntitlementModels(
  credential: OpencodeCredential,
  signal?: AbortSignal,
): Promise<CatalogModel[] | null> {
  if (credential.kind !== 'oauth' || !credential.server) return null
  const response = await fetch(`${credential.server}/api/config`, {
    headers: { accept: 'application/json', ...opencodeAuthHeaders(credential) },
    ...(signal ? { signal } : {}),
  })
  if (response.status === 404) return null
  if (!response.ok) return null

  const body = record(await response.json().catch(() => undefined))
  const providers = record(record(body?.config)?.provider)
  if (!providers) return null

  const models: CatalogModel[] = []
  const seen = new Set<string>()
  for (const provider of Object.values(providers)) {
    const entry = record(provider)
    const catalog = record(entry?.models)
    if (!catalog) continue
    for (const [modelId, config] of Object.entries(catalog)) {
      // `id` overrides the key when the org remaps a model onto another
      // checkpoint; the key is the display identity, `id` is what goes on the
      // wire, and occ sends the id.
      const id = asString(record(config)?.id) ?? modelId
      if (seen.has(id)) continue
      seen.add(id)
      const displayName = asString(record(config)?.name)
      models.push({ id, ...(displayName ? { displayName } : {}) })
    }
  }
  return models.length > 0 ? models : null
}

/** The public catalog of one inference base, OpenAI `/models` shape. */
export async function fetchZenModels(
  baseUrl: string,
  credential?: OpencodeCredential,
  signal?: AbortSignal,
): Promise<CatalogModel[] | null> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      accept: 'application/json',
      ...(credential ? opencodeAuthHeaders(credential) : {}),
    },
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) return null

  const body = record(await response.json().catch(() => undefined))
  const data = Array.isArray(body?.data) ? body.data : undefined
  if (!data) return null

  const models: CatalogModel[] = []
  for (const item of data) {
    const id = asString(record(item)?.id)
    if (!id) continue
    const created = record(item)?.created
    models.push({
      id,
      ...(typeof created === 'number' ? { created } : {}),
    })
  }
  return models.length > 0 ? models : null
}

/**
 * The model list to show for a credential: entitlement first, the product's
 * public catalog as the fallback.
 *
 * `baseUrl` is required rather than defaulted: the caller always knows which
 * product it is configuring, and a default would let a Go session fall back to
 * Zen's 61 models without anyone writing that down.
 */
export async function fetchOpencodeModels(
  credential: OpencodeCredential | null,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<CatalogModel[] | null> {
  if (credential) {
    const entitled = await fetchEntitlementModels(credential, signal).catch(
      () => null,
    )
    if (entitled) return entitled
  }
  return fetchZenModels(baseUrl, credential ?? undefined, signal).catch(
    () => null,
  )
}
