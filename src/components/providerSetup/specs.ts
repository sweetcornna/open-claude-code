/**
 * Per-provider description of the two-step endpoint setup.
 *
 * One wizard drives all four providers (ProviderSetupWizard.tsx); everything
 * that actually differs between them lives here as data. Before this table
 * each provider had its own hand-written form: the OpenAI one was a two-step
 * flow that fetched the upstream model list and let you pick from it, while
 * Anthropic-compatible / Gemini / Grok were flat forms where the model name
 * had to be typed from memory. Three of the four were also drifting — only one
 * of them validated the base URL, only one cleared its client cache on save.
 *
 * Adding a provider means adding an entry here and nothing else.
 */

import {
  fetchAnthropicCompatibleModelsWith,
  fetchGeminiModelsWith,
  fetchOpenAICompatibleModelsWith,
} from 'src/services/modelCatalog/fetchExplicit.js'
import type { CatalogModel } from 'src/services/modelCatalog/types.js'

export type ProviderSetupKind = 'openai' | 'anthropic' | 'gemini' | 'grok'

export type OpenAIWireApi = 'chat' | 'responses'

/** Optional per-tier model slots, in ascending capability order. */
export const TIER_FIELDS = [
  'haiku_model',
  'sonnet_model',
  'opus_model',
  'fable_model',
] as const

export type TierField = (typeof TIER_FIELDS)[number]

export const TIER_LABELS: Record<TierField, string> = {
  haiku_model: 'Haiku',
  sonnet_model: 'Sonnet',
  opus_model: 'Opus',
  fable_model: 'Fable',
}

/** The values the wizard collects, keyed the way the form addresses them. */
export type ProviderSetupValues = {
  model: string
  maxContext: string
} & Record<TierField, string>

export type ProviderSetupContext = {
  /** OpenAI only: which wire protocol the session will speak. */
  wireApi?: OpenAIWireApi
}

type ModelsFetchArgs = {
  baseURL: string
  apiKey: string
  signal?: AbortSignal
  onError?: (reason: string) => void
}

export type ProviderSetupSpec = {
  /** `modelType` written into settings, and the analytics/label identity. */
  modelType: string
  /** Heading, rendered as "<title> — Step 1 of 2". */
  title: (context: ProviderSetupContext) => string
  /** Sentence under the step-1 heading explaining what will be requested. */
  endpointHint: (context: ProviderSetupContext) => string
  /**
   * Used for the model-list request when the user leaves Base URL empty. Never
   * written to settings on its own — an unset base URL must stay unset so the
   * provider's own default keeps applying.
   */
  defaultBaseUrl: string
  /** OpenAI has always required an explicit base URL; the others default. */
  baseUrlRequired: boolean
  /**
   * When false, an empty API key skips the catalog request and drops straight
   * to manual entry instead of erroring. Keyless local gateways (vLLM behind an
   * Anthropic-compatible shim, say) were configurable before this wizard
   * existed and must stay configurable.
   */
  apiKeyRequired: boolean
  fetchModels: (args: ModelsFetchArgs) => Promise<CatalogModel[] | null>
  /** Env var names this provider writes. */
  env: {
    baseUrl: string
    apiKey: string
    model: string
    tiers: Record<TierField, string>
  }
  /** Which tier slots the form offers. All four, for every provider. */
  tiers: readonly TierField[]
  /**
   * Provider-specific validation of the collected model names. Returns a
   * user-facing message plus the field to focus, or null when the values are
   * acceptable.
   */
  validate: (
    values: ProviderSetupValues,
  ) => { message: string; field: keyof ProviderSetupValues } | null
  /** Extra env written on save (wire protocol, auth-mode resets). */
  extraEnv?: (
    context: ProviderSetupContext,
  ) => Record<string, string | undefined>
  /** Client-cache invalidation and similar, after settings are persisted. */
  afterSave?: () => void
}

const OPENAI_WIRE_API_TITLES: Record<OpenAIWireApi, string> = {
  chat: 'OpenAI Chat Completions Setup',
  responses: 'OpenAI Responses API Setup',
}

const OPENAI_WIRE_API_ENDPOINTS: Record<OpenAIWireApi, string> = {
  chat: 'POST <base URL>/chat/completions',
  responses: 'POST <base URL>/responses',
}

function tierEnv(prefix: string): Record<TierField, string> {
  return {
    haiku_model: `${prefix}_DEFAULT_HAIKU_MODEL`,
    sonnet_model: `${prefix}_DEFAULT_SONNET_MODEL`,
    opus_model: `${prefix}_DEFAULT_OPUS_MODEL`,
    fable_model: `${prefix}_DEFAULT_FABLE_MODEL`,
  }
}

/** Most providers ship built-in family defaults, so no model is mandatory. */
const noValidation = (): null => null

export const PROVIDER_SETUP_SPECS: Record<
  ProviderSetupKind,
  ProviderSetupSpec
> = {
  openai: {
    modelType: 'openai',
    title: ({ wireApi }) => OPENAI_WIRE_API_TITLES[wireApi ?? 'chat'],
    endpointHint: ({ wireApi }) =>
      `Requests will use ${OPENAI_WIRE_API_ENDPOINTS[wireApi ?? 'chat']}.`,
    defaultBaseUrl: 'https://api.openai.com/v1',
    baseUrlRequired: true,
    apiKeyRequired: true,
    fetchModels: fetchOpenAICompatibleModelsWith,
    env: {
      baseUrl: 'OPENAI_BASE_URL',
      apiKey: 'OPENAI_API_KEY',
      model: 'OPENAI_MODEL',
      tiers: tierEnv('OPENAI'),
    },
    tiers: TIER_FIELDS,
    // OpenAI-compatible endpoints have no family defaults to fall back on:
    // without OPENAI_MODEL there is nothing to send.
    validate: values =>
      values.model.trim()
        ? null
        : {
            message:
              'Default model is required. Choose or enter a model name for OPENAI_MODEL.',
            field: 'model',
          },
    extraEnv: ({ wireApi }) => ({
      OPENAI_WIRE_API: wireApi ?? 'chat',
      // Configuring an API key means this is no longer a ChatGPT-subscription
      // session; leaving the mode set would route to the Codex backend.
      OPENAI_AUTH_MODE: undefined,
    }),
    afterSave: () => {
      void import('src/services/api/openai/client.js').then(m =>
        m.clearOpenAIClientCache(),
      )
      void import('src/services/api/openai/chatgptAuth.js').then(m =>
        m.removeChatGPTAuth().catch(() => {}),
      )
    },
  },

  anthropic: {
    modelType: 'anthropic',
    title: () => 'Anthropic Compatible Setup',
    endpointHint: () =>
      'Requests will use POST <base URL>/v1/messages. Base URL may be left empty to use api.anthropic.com.',
    defaultBaseUrl: 'https://api.anthropic.com',
    baseUrlRequired: false,
    apiKeyRequired: false,
    fetchModels: fetchAnthropicCompatibleModelsWith,
    env: {
      baseUrl: 'ANTHROPIC_BASE_URL',
      apiKey: 'ANTHROPIC_AUTH_TOKEN',
      model: 'ANTHROPIC_MODEL',
      tiers: tierEnv('ANTHROPIC'),
    },
    tiers: TIER_FIELDS,
    validate: noValidation,
  },

  gemini: {
    modelType: 'gemini',
    title: () => 'Gemini API Setup',
    endpointHint: () =>
      "Configure a Gemini Generate Content compatible endpoint. Base URL may be left empty to use Google's v1beta API.",
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    baseUrlRequired: false,
    apiKeyRequired: false,
    fetchModels: fetchGeminiModelsWith,
    env: {
      baseUrl: 'GEMINI_BASE_URL',
      apiKey: 'GEMINI_API_KEY',
      model: 'GEMINI_MODEL',
      tiers: tierEnv('GEMINI'),
    },
    tiers: TIER_FIELDS,
    // Gemini has no built-in family defaults (the mapping throws on a miss),
    // so either a single default model or all three base tiers are needed.
    // Fable is exempt: unset, it falls back to the primary model key.
    validate: values => {
      if (values.model.trim()) return null
      const missing = (
        ['haiku_model', 'sonnet_model', 'opus_model'] as const
      ).find(field => !values[field].trim())
      return missing
        ? {
            message:
              'Gemini setup requires a default Model, or all of Haiku, Sonnet, and Opus model names.',
            field: missing,
          }
        : null
    },
  },

  grok: {
    modelType: 'grok',
    title: () => 'xAI Grok API Setup',
    endpointHint: () =>
      'Requests will use the xAI OpenAI-compatible API. Base URL may be left empty to use api.x.ai/v1.',
    defaultBaseUrl: 'https://api.x.ai/v1',
    baseUrlRequired: false,
    apiKeyRequired: false,
    // xAI's API is OpenAI-compatible, /models included.
    fetchModels: fetchOpenAICompatibleModelsWith,
    env: {
      baseUrl: 'GROK_BASE_URL',
      apiKey: 'GROK_API_KEY',
      model: 'GROK_MODEL',
      tiers: tierEnv('GROK'),
    },
    tiers: TIER_FIELDS,
    validate: noValidation,
    afterSave: () => {
      void import('src/services/api/grok/client.js').then(m =>
        m.clearGrokClientCache(),
      )
    },
  },
}
