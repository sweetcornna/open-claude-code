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
import { OPENCODE_MODEL_DISABLED_TYPE } from './inferenceErrors.js'
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
 * The whole answer `/api/config` gives about an account.
 *
 * Not just the model list any more, and that omission is what made Console
 * sign-in unusable: the response also names the endpoint those models live
 * behind and the headers a request to it must carry, and occ was sending the
 * OAuth token to a constant instead. Measured against the live console with a
 * real access token (2026-08-11) — the same account, side by side:
 *
 *   POST {config.provider.opencode.api}/chat/completions  200, real completion
 *   POST https://opencode.ai/zen/v1/chat/completions      401 AuthError
 *
 * sst/opencode reads it the same way (`packages/core/src/plugin/provider/
 * opencode.ts`: `provider.api = { …, url: item.api }` plus
 * `Object.assign(provider.request.headers, item.options?.headers)`).
 */
type OpencodeConsoleConfig = {
  /** `provider.opencode.api` + `provider.opencode.options.headers`. */
  inference?: { api: string; headers?: Record<string, string> }
  /** The org's entitlement models, flattened across providers. */
  models: CatalogModel[] | null
}

/**
 * Models from one provider entry.
 *
 * `/api/config` returns `{ config: { provider: { <providerID>: { models: {
 * <modelID>: { name?, … } } } } } }`. Every provider in it is reachable
 * through the same credential, so the ids are flattened into one list — occ
 * has a single model axis, not opencode's provider×model pair.
 */
function collectModels(
  entry: JsonRecord | undefined,
  into: CatalogModel[],
  seen: Set<string>,
): void {
  const catalog = record(entry?.models)
  if (!catalog) return
  for (const [modelId, config] of Object.entries(catalog)) {
    // `id` overrides the key when the org remaps a model onto another
    // checkpoint; the key is the display identity, `id` is what goes on the
    // wire, and occ sends the id.
    const id = asString(record(config)?.id) ?? modelId
    if (seen.has(id)) continue
    seen.add(id)
    const displayName = asString(record(config)?.name)
    into.push({ id, ...(displayName ? { displayName } : {}) })
  }
}

/** String-valued entries of `options.headers`, and nothing else. */
function readHeaders(entry: JsonRecord | undefined): Record<string, string> {
  const declared = record(record(entry?.options)?.headers)
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(declared ?? {})) {
    const text = asString(value)
    if (text) headers[name] = text
  }
  return headers
}

/**
 * Read the account's config, or nothing.
 *
 * Returns null when the console has nothing to say, so the caller can tell "no
 * remote config" apart from "entitled to nothing". 404 is that case rather than
 * an error, matching sst/opencode.
 *
 * The inference entry is taken from the `opencode` provider, falling back to a
 * lone provider under another name — an enterprise console serving one
 * self-named provider is the deployment that fallback exists for. Nothing is
 * invented: with no `api` field there is no inference plane, and the caller
 * keeps whatever endpoint it already had.
 */
export async function fetchOpencodeConsoleConfig(
  credential: OpencodeCredential,
  signal?: AbortSignal,
): Promise<OpencodeConsoleConfig | null> {
  if (credential.kind !== 'oauth' || !credential.server) return null
  const response = await fetch(`${credential.server}/api/config`, {
    headers: { accept: 'application/json', ...opencodeAuthHeaders(credential) },
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) return null

  const body = record(await response.json().catch(() => undefined))
  const providers = record(record(body?.config)?.provider)
  if (!providers) return null

  const entries = Object.entries(providers)
  const models: CatalogModel[] = []
  const seen = new Set<string>()
  for (const [, provider] of entries) {
    collectModels(record(provider), models, seen)
  }

  const named = record(providers.opencode)
  const sole = entries.length === 1 ? record(entries[0]?.[1]) : undefined
  const inferenceEntry = named ?? sole
  const api = asString(inferenceEntry?.api)
  const headers = inferenceEntry ? readHeaders(inferenceEntry) : {}

  return {
    ...(api
      ? {
          inference: {
            api,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
          },
        }
      : {}),
    models: models.length > 0 ? models : null,
  }
}

/**
 * Whether a credential is actually accepted by the product it was issued for.
 *
 * The Console sign-in had no such check and structurally could not have one:
 * every request it makes either needs no credential or forgives a bad one.
 * `GET {base}/models` is PUBLIC on both products (verified: 200 with no
 * credential at all), `fetchAccount` absorbs its own failures on purpose, and
 * `/api/config` treats 404 as "no remote config". So a sign-in could complete,
 * write settings, and open a model picker full of real ids without the token
 * ever having been exercised against the endpoint it just configured. The first
 * time it was exercised was the user's first prompt, arriving as
 * `API Error [OpenAI]: Invalid API key` — which reads as a broken provider
 * rather than a failed login, and leaves no obvious way back.
 *
 * The probe is a chat completion with an EMPTY `messages` array, and that shape
 * is the point: the gateway authenticates BEFORE it validates the body, so a
 * rejected credential answers 401 `AuthError` while an accepted one falls
 * through to the upstream's complaint about the empty body — no inference runs
 * and nothing is billed. All three directions verified against the live service
 * (2026-08-10): no bearer → 401 `Missing API key.`, garbage bearer → 401
 * `Invalid API key.`, and Zen's free `Bearer public` → 400 `Input required:
 * specify "prompt" or "messages"`.
 *
 * Only `AuthError` counts as a rejection. The gateway answers an unknown model
 * id with `ModelError` and — verified — still stamps it 401, so classifying on
 * the status would reject a perfectly good account whenever occ guessed the
 * probe model wrong. A transport failure is not a rejection either: the device
 * flow reached the console seconds earlier, so a throw here is a flaky network
 * rather than a verdict, and blocking a login on it would be a worse failure
 * than the one this exists to prevent.
 *
 * `baseUrl` must be the endpoint the session will ACTUALLY use, which for a
 * Console login is the one `/api/config` named rather than a product constant.
 * Probing Zen for a Console token was the shape of the original bug: the same
 * token answers 200 on the console's inference plane and 401 on Zen, so the
 * check either passed the wrong endpoint or failed a working account.
 */
export type OpencodeAccessCheck = { ok: true } | { ok: false; reason: string }

export async function verifyOpencodeAccess(
  credential: OpencodeCredential,
  baseUrl: string,
  /** A model id this product serves — the probe needs one to get past
   * `ModelError` and reach the credential verdict. */
  model: string,
  signal?: AbortSignal,
): Promise<OpencodeAccessCheck> {
  let response: Response
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...opencodeAuthHeaders(credential),
      },
      body: JSON.stringify({ model, messages: [] }),
      ...(signal ? { signal } : {}),
    })
  } catch {
    return { ok: true }
  }
  if (response.ok) return { ok: true }

  const body = record(await response.json().catch(() => undefined))
  const error = record(body?.error)
  // The Console plane can refuse the MODEL while accepting the credential, and
  // it does so with a 403 that the status-only branch below would read as a
  // rejection. Measured: `/api/config` lists every id as active, so the probe
  // model is picked from a list that cannot say which ones the org may use —
  // rejecting the login for it would block a working account over a model
  // choice occ made.
  if (asString(error?.type) === OPENCODE_MODEL_DISABLED_TYPE) {
    return { ok: true }
  }
  if (asString(error?.type) === 'AuthError') {
    return { ok: false, reason: asString(error?.message) ?? 'Invalid API key.' }
  }
  // A 401 with no readable body is still a rejection; anything else (400 from
  // the empty body, ModelError, a 5xx) says the credential got through.
  if (response.status === 401 && !error) {
    return { ok: false, reason: `HTTP ${response.status}` }
  }
  return { ok: true }
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
    const config = await fetchOpencodeConsoleConfig(credential, signal).catch(
      () => null,
    )
    if (config?.models) return config.models
  }
  return fetchZenModels(baseUrl, credential ?? undefined, signal).catch(
    () => null,
  )
}
