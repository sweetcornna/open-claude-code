/**
 * The two wizard states, kept out of ConsoleOAuthFlow.tsx so the wizard can
 * name them without importing the component that renders it (and closing an
 * import cycle). ConsoleOAuthFlow folds both into its OAuthStatus union.
 */

import type { CatalogModel } from 'src/services/modelCatalog/types.js'
import type { OpenAIWireApi, ProviderSetupKind, TierField } from './specs.js'

export type EndpointField = 'base_url' | 'api_key'

export type ProviderModelField = 'model' | TierField | 'max_context' | 'effort'

export type ProviderEndpointSetupStatus = {
  state: 'provider_endpoint_setup'
  kind: ProviderSetupKind
  /** `fetching` renders the spinner and drives the model-list request. */
  phase: 'editing' | 'fetching'
  baseUrl: string
  apiKey: string
  /** OpenAI only. */
  wireApi?: OpenAIWireApi
  activeField: EndpointField
}

type ProviderModelSetupBase = {
  state: 'provider_model_setup'
  kind: ProviderSetupKind
  baseUrl: string
  apiKey: string
  wireApi?: OpenAIWireApi
  /** China presets only: shown in the heading, since the endpoint has no form. */
  providerLabel?: string
  model: string
  maxContext: string
  /** One of EFFORT_LEVELS, or '' for "each model's family default". */
  effort: string
  haikuModel: string
  sonnetModel: string
  opusModel: string
  fableModel: string
  activeField: ProviderModelField
}

/**
 * `catalog` means the endpoint answered GET /models and every model field is a
 * picker. `manual` is the fallback — the reason is shown so the user knows
 * whether to fix the endpoint or just type the model name.
 */
export type ProviderModelSetupStatus = ProviderModelSetupBase &
  (
    | {
        entryMode: 'catalog'
        models: CatalogModel[]
        /**
         * Set when the list did not come from the endpoint — occ's built-in
         * table stood in. The user needs to know the options are a guess at
         * what this server serves, not its own answer.
         */
        catalogNote?: string
      }
    | { entryMode: 'manual'; fetchError: string }
  )

export type ProviderSetupStatus =
  | ProviderEndpointSetupStatus
  | ProviderModelSetupStatus

/** Map a tier field onto its slot in the status object. */
export const TIER_STATUS_KEYS = {
  haiku_model: 'haikuModel',
  sonnet_model: 'sonnetModel',
  opus_model: 'opusModel',
  fable_model: 'fableModel',
} as const satisfies Record<TierField, keyof ProviderModelSetupBase>
