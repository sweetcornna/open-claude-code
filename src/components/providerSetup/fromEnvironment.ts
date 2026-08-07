/**
 * Reopen the model step for the provider the session is already using.
 *
 * The wizard normally arrives from a login flow that just collected the
 * endpoint and key. Changing which model a tier resolves to shouldn't require
 * repeating that — the credentials are already configured, and re-typing an API
 * key to edit an unrelated field is the kind of friction that stops people from
 * touching the setting at all. Everything here is read back out of the same env
 * keys the wizard writes, so there is no second source of truth. The two
 * non-env fields — max context and thinking effort — come back from
 * `settings.modelSettings`, where the wizard now persists them per tier.
 */

import {
  buildCatalogKey,
  getCachedModelCatalog,
} from 'src/services/modelCatalog/cache.js'
import type { CatalogModel } from 'src/services/modelCatalog/types.js'
import { findChinaProviderByBaseURL } from 'src/utils/model/chinaLlmProviders.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { getSettingsForSource } from 'src/utils/settings/settings.js'
import { PROVIDER_SETUP_SPECS, type ProviderSetupKind } from './specs.js'
import type { ProviderModelSetupStatus } from './state.js'
import { prefillTierFields } from './tierPersistence.js'

/**
 * Which spec describes the session's current provider, or undefined when there
 * is nothing to configure.
 *
 * `undefined` is the honest answer for a plain first-party session: its tiers
 * resolve through the built-in Claude table, and there are no
 * `*_DEFAULT_*_MODEL` keys for the user to point anywhere.
 */
export function currentProviderSetupKind(
  env: NodeJS.ProcessEnv = process.env,
): ProviderSetupKind | undefined {
  switch (getAPIProvider()) {
    case 'openai':
      // A China preset is an OpenAI-compatible endpoint; the base URL is what
      // distinguishes it, and it brings its own curated model table.
      return findChinaProviderByBaseURL(env.OPENAI_BASE_URL)
        ? 'china'
        : 'openai'
    case 'gemini':
      return 'gemini'
    case 'grok':
      return 'grok'
    case 'firstParty':
      // settings.modelType 'anthropic' reads as firstParty; a custom endpoint is
      // the thing that makes it configurable.
      return env.ANTHROPIC_BASE_URL?.trim() ? 'anthropic' : undefined
    default:
      // bedrock / vertex / foundry configure models through their own consoles.
      return undefined
  }
}

/**
 * The models to offer. A China preset ships its own table; every other provider
 * gets whatever the background catalog refresh last read from its `/models`
 * endpoint, so reopening the setting is instant and offline.
 */
function catalogFor(
  kind: ProviderSetupKind,
  env: NodeJS.ProcessEnv,
): CatalogModel[] | null {
  if (kind === 'china') {
    const preset = findChinaProviderByBaseURL(env.OPENAI_BASE_URL)
    return (
      preset?.models.map(model => ({
        id: model.id,
        displayName: model.label,
      })) ?? null
    )
  }
  const spec = PROVIDER_SETUP_SPECS[kind]
  const baseURL = env[spec.env.baseUrl]?.trim() || spec.defaultBaseUrl
  // The catalog is keyed by the provider name the fetcher uses, which calls the
  // Anthropic-compatible path 'firstParty'.
  const providerKey = kind === 'anthropic' ? 'firstParty' : kind
  const cached = getCachedModelCatalog(buildCatalogKey(providerKey, baseURL))
  const preset = spec.presetModels?.() ?? []
  if (!cached) return preset.length > 0 ? preset : null
  return [
    ...cached,
    ...preset.filter(extra => !cached.some(model => model.id === extra.id)),
  ]
}

/**
 * Build the model step for the current provider, prefilled from env, or
 * undefined when the session has no configurable tiers.
 */
export function buildModelStepFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ProviderModelSetupStatus | undefined {
  const kind = currentProviderSetupKind(env)
  if (!kind) return undefined
  const spec = PROVIDER_SETUP_SPECS[kind]
  const models = catalogFor(kind, env)
  const preset =
    kind === 'china'
      ? findChinaProviderByBaseURL(env.OPENAI_BASE_URL)
      : undefined

  const base = {
    state: 'provider_model_setup' as const,
    kind,
    baseUrl: env[spec.env.baseUrl] ?? '',
    apiKey: env[spec.env.apiKey] ?? '',
    ...(preset ? { providerLabel: preset.label } : {}),
    model: env[spec.env.model] ?? '',
    ...prefillTierFields(
      getSettingsForSource('userSettings')?.modelSettings,
      env,
    ),
    haikuModel: env[spec.env.tiers.haiku_model] ?? '',
    sonnetModel: env[spec.env.tiers.sonnet_model] ?? '',
    opusModel: env[spec.env.tiers.opus_model] ?? '',
    fableModel: env[spec.env.tiers.fable_model] ?? '',
    activeField:
      spec.defaultModelField === 'omitted'
        ? ('haiku_model' as const)
        : ('model' as const),
  }

  if (!models || models.length === 0) {
    // Only reachable for a provider occ has no built-in table for (Gemini,
    // Grok) whose background catalog refresh has not run yet.
    return {
      ...base,
      entryMode: 'manual',
      fetchError: 'no cached model list for this endpoint yet',
    }
  }
  // Unlike a fresh login, values are NOT dropped when the catalog does not list
  // them: the user configured them deliberately and the cache may simply be
  // stale. They are added to the options instead, further down in the wizard.
  return { ...base, entryMode: 'catalog', models }
}
