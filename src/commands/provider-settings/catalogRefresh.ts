/**
 * Re-read one saved profile's `/models` endpoint into `profile.models`.
 *
 * Goes through `modelCatalog/fetchExplicit.ts`, not `fetch.ts`: the latter
 * reads credentials out of `process.env` and the auth chain, which is exactly
 * what a NON-active profile does not have. Refreshing the relay you are not
 * currently talking to has to work, or the aggregated list could only ever be
 * assembled one provider at a time.
 *
 * Writes through `updateProfileCatalog`, never `captureProfile`: a catalog
 * refresh must not re-snapshot the live session's credentials onto a profile
 * that merely happens to be highlighted in the panel.
 *
 * Nothing here enumerates providers. The wire comes from what the profile
 * recorded and the endpoint from the profile's own `*_BASE_URL`, so a family
 * added later (OpenCode was, mid-review) is refreshable without an edit — and
 * when its endpoint has no model list, the failure is the endpoint's 404
 * rather than a hard-coded "unsupported provider".
 */

import { resolveProviderBaseURL } from 'src/services/modelCatalog/cache.js'
import {
  fetchAnthropicCompatibleModelsWith,
  fetchGeminiModelsWith,
  fetchOpenAICompatibleModelsWith,
} from 'src/services/modelCatalog/fetchExplicit.js'
import type { CatalogModel } from 'src/services/modelCatalog/types.js'
import {
  loadProfilesFile,
  updateProfileCatalog,
  type ProviderProfile,
} from 'src/services/providerProfiles/profiles.js'
import {
  profileCredentialKey,
  profileEndpoint,
  profileEnvKeys,
} from './state.js'

/** The three model-list request shapes occ knows how to make. */
type CatalogWire = 'anthropic' | 'openai' | 'gemini'

/**
 * Endpoint-default lookup for the `modelType` values that name one of the
 * providers `resolveProviderBaseURL` has a default for. A profile whose family
 * is absent here simply has to carry its own `*_BASE_URL`, which is the case
 * for every family that is not one of occ's four built-in wires.
 */
const CATALOG_PROVIDER: Record<string, string> = {
  anthropic: 'firstParty',
  openai: 'openai',
  gemini: 'gemini',
  grok: 'grok',
}

/**
 * Which request shape to make for this profile.
 *
 * A saved `*_WIRE_API` wins: a family that records its lane (OpenCode pins
 * `messages` | `responses` | `chat`) knows better than its `modelType`, which
 * for those profiles only names the credential family. Everything that is not
 * Anthropic-shaped or Gemini-shaped is asked the OpenAI-compatible way, which
 * is what the overwhelming majority of `/models` endpoints serve.
 */
export function catalogWireForProfile(profile: ProviderProfile): CatalogWire {
  if (profile.modelType === 'gemini') return 'gemini'
  const env = profile.env ?? {}
  for (const key of profileEnvKeys(profile)) {
    if (!key.endsWith('_WIRE_API')) continue
    const lane = env[key]?.trim().toLowerCase()
    if (lane === 'messages') return 'anthropic'
    if (lane === 'chat' || lane === 'responses') return 'openai'
  }
  return profile.modelType === 'anthropic' ? 'anthropic' : 'openai'
}

type RefreshOptions = {
  signal?: AbortSignal
  /** Injected in tests; production uses the global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * The endpoint to ask, or null when the profile names none and its family has
 * no built-in default.
 */
export function catalogBaseURLForProfile(
  profile: ProviderProfile,
): string | null {
  const provider = CATALOG_PROVIDER[profile.modelType]
  // resolveProviderBaseURL reads the family's own *_BASE_URL out of the env it
  // is handed and falls back to the public default, so it already covers both
  // halves for the four built-in wires.
  if (provider) return resolveProviderBaseURL(provider, profile.env)
  return profileEndpoint(profile) ?? null
}

export async function refreshProfileCatalog(
  name: string,
  options: RefreshOptions = {},
): Promise<{ models: CatalogModel[] } | { error: string }> {
  const file = loadProfilesFile()
  const profile = file.profiles?.[name]
  if (!profile) return { error: `Unknown profile "${name}".` }

  const credentialKey = profileCredentialKey(profile)
  const apiKey = credentialKey ? profile.env[credentialKey] : undefined
  if (!apiKey) {
    return {
      error:
        `Profile "${name}" saves no API key, so its model list cannot be ` +
        `read on its own. Providers whose credential is a refreshed OAuth ` +
        `token deliberately keep it out of the profile.`,
    }
  }

  const baseURL = catalogBaseURLForProfile(profile)
  if (baseURL === null) {
    return {
      error:
        `Profile "${name}" records no endpoint, so there is nothing to ask ` +
        `for a model list.`,
    }
  }

  // fetchExplicit reports the reason through a callback and still resolves to
  // null, so the reason has to be captured here to reach the user.
  let reason: string | undefined
  const params = {
    baseURL,
    apiKey,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    onError: (message: string) => {
      reason = message
    },
  }

  const wire = catalogWireForProfile(profile)
  const models =
    wire === 'anthropic'
      ? await fetchAnthropicCompatibleModelsWith(params)
      : wire === 'gemini'
        ? await fetchGeminiModelsWith(params)
        : await fetchOpenAICompatibleModelsWith(params)

  if (!models) {
    return {
      error:
        `Could not read the model list for "${name}": ` +
        `${reason ?? 'the request failed'}.`,
    }
  }

  const updated = updateProfileCatalog(name, { models })
  if ('error' in updated) return updated
  return { models }
}
