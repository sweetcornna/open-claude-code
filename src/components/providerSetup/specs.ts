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
import {
  fetchOpencodeModels,
  fetchZenModels,
  OPENCODE_ZEN_BASE_URL,
} from 'src/services/auth/opencode/index.js'
import { ALL_MODEL_CONFIGS } from 'src/utils/model/configs.js'
import { CHATGPT_CODEX_MODEL_OPTIONS } from 'src/utils/model/chatgptModels.js'
import { applyOpencodeWire } from 'src/utils/model/opencodeWire.js'
import type { ProviderURLKind } from 'src/utils/network/providerUrl.js'
import {
  OPENCODE_PRODUCTS,
  opencodePresetModels,
  opencodeProductForBaseUrl,
  withLaneLabels,
} from '../opencodeLogin/opencodeCatalog.js'

export type ProviderSetupKind =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'grok'
  | 'china'
  | 'opencode'

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
  /** One of EFFORT_LEVELS, or '' for "each model's family default". */
  effort: string
} & Record<TierField, string>

export type ProviderSetupContext = {
  /** OpenAI only: which wire protocol the session will speak. */
  wireApi?: OpenAIWireApi
  /** Endpoint selected by the user; empty means the provider's official default. */
  baseUrl?: string
  /** China presets only: the provider's display name, for the heading. */
  providerLabel?: string
}

type ModelsFetchArgs = {
  baseURL: string
  apiKey: string
  signal?: AbortSignal
  onError?: (reason: string) => void
}

/** What the save that just happened did, for `afterSave` to react to. */
export type ProviderSetupSaveContext = {
  /**
   * Whether this save (re)configured the provider's credentials.
   *
   * False when the wizard ran in model-only mode for a subscription session:
   * the credentials belong to that login, the form never showed them, and
   * anything that tears them down (`removeChatGPTAuth`) must not run.
   */
  credentialsConfigured: boolean
}

/**
 * A provider whose credentials can come from a subscription/OAuth login rather
 * than from this form.
 *
 * When the named env key holds one of these modes, the session is authenticated
 * by that login and the form has nothing to say about it: reopening
 * `/models-setting` must edit models and tiers only. Without this the save path
 * wrote `<KEY>_API_KEY: undefined`, cleared the auth mode through `extraEnv`,
 * and ran `afterSave` — which for OpenAI deletes the stored ChatGPT tokens.
 * Three writes, one destroyed session, for a user who only wanted to repoint a
 * tier.
 */
export type SubscriptionAuthSpec = {
  /** Env key naming the session's auth mode. */
  envKey: string
  /** Auth-mode value → how to name whoever owns the credentials, for the UI. */
  modes: Record<string, string>
  /**
   * Env key that must be UNSET for the mode to mean "a subscription owns the
   * credentials".
   *
   * OpenAI and Gemini do not need this: their auth-mode key is written by the
   * subscription login and by nothing else, so its presence is proof. OpenCode's
   * is different — `OPENCODE_AUTH_MODE` is the switch that routes the session
   * to OpenCode at all, so an API-key session sets it too. Without this
   * discriminator that session would be told a subscription owns its
   * credentials, and the form would refuse to edit the key it wrote itself
   * while claiming a login the user never performed.
   */
  onlyWhenUnset?: string
  /**
   * Spec fields that change meaning while one of those modes is active. The
   * subscription backend resolves tiers on its own, so a provider whose form
   * normally insists on a default model stops needing one — and the heading
   * has to stop naming an endpoint the session is not using.
   */
  overrides?: Partial<
    Pick<ProviderSetupSpec, 'defaultModelField' | 'validate' | 'title'>
  >
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
  /** URL/resource grammar used to canonicalize the endpoint before saving. */
  urlKind: ProviderURLKind
  /** OpenAI has always required an explicit base URL; the others default. */
  baseUrlRequired: boolean
  /**
   * Whether step 1 exists. China presets pick the endpoint from a table and
   * collect the key on their own screen, so they enter at step 2 — and Esc
   * there has to go back to that screen, not to an endpoint form they never saw.
   */
  hasEndpointStep: boolean
  /** What the independent provider-default model field means for this provider. */
  defaultModelField: 'required' | 'optional' | 'omitted'
  /**
   * When false, an empty API key skips the catalog request and drops straight
   * to manual entry instead of erroring. Keyless local gateways (vLLM behind an
   * Anthropic-compatible shim, say) were configurable before this wizard
   * existed and must stay configurable.
   */
  apiKeyRequired: boolean
  fetchModels: (args: ModelsFetchArgs) => Promise<CatalogModel[] | null>
  /**
   * Models occ knows for the provider's official endpoint, used only when model
   * discovery fails. A compatible wire protocol does not imply catalog
   * ownership, so custom endpoints never inherit GPT or Claude guesses.
   */
  presetModels?: (context: ProviderSetupContext) => CatalogModel[]
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
  /**
   * Extra env written on save (wire protocol, auth-mode resets).
   *
   * Skipped entirely in model-only mode — every entry here describes the
   * credential plane, which that mode does not own.
   */
  extraEnv?: (
    context: ProviderSetupContext,
  ) => Record<string, string | undefined>
  /**
   * Whether this provider can be authenticated by a subscription/OAuth login
   * instead of by this form. Undefined means it always owns its credentials.
   */
  subscriptionAuth?: SubscriptionAuthSpec
  /** Client-cache invalidation and similar, after settings are persisted. */
  afterSave?: (context: ProviderSetupSaveContext) => void | Promise<void>
}

/**
 * The subscription login this session is running on, or undefined when the
 * credentials are this form's own business.
 *
 * Read from the environment rather than stored on the wizard status because the
 * auth mode is a property of the session, not of the screen.
 */
export function activeSubscriptionAuth(
  spec: ProviderSetupSpec,
  env: NodeJS.ProcessEnv = process.env,
): { envKey: string; mode: string; label: string } | undefined {
  const auth = spec.subscriptionAuth
  if (!auth) return undefined
  const mode = env[auth.envKey]?.trim()
  if (!mode) return undefined
  if (auth.onlyWhenUnset && env[auth.onlyWhenUnset]?.trim()) return undefined
  const label = auth.modes[mode]
  return label ? { envKey: auth.envKey, mode, label } : undefined
}

/**
 * The spec as it applies to this screen: the base table, plus whatever an
 * active subscription login changes about it.
 *
 * Keeping the merge here rather than in the component is the point — the
 * wizard renders one form for every provider and must not learn that ChatGPT
 * sessions are special.
 */
export function specForSubscriptionAuth(
  spec: ProviderSetupSpec,
  auth: ReturnType<typeof activeSubscriptionAuth>,
): ProviderSetupSpec {
  if (!auth) return spec
  const overrides = spec.subscriptionAuth?.overrides
  return overrides ? { ...spec, ...overrides } : spec
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

/**
 * How to name the OpenCode endpoint a screen is pointed at.
 *
 * Zen and Go are one path segment apart on the same host, so a heading that
 * says only "OpenCode" leaves the user's most consequential choice invisible —
 * and the wrong one is only reported later, as a CreditsError from the other
 * product's balance.
 */
function opencodeEndpointLabel(baseUrl: string | undefined): string {
  const product = opencodeProductForBaseUrl(baseUrl)
  return product ? OPENCODE_PRODUCTS[product].label : 'OpenCode'
}

function usesOfficialEndpoint(
  context: ProviderSetupContext,
  officialHost: string,
): boolean {
  const baseUrl = context.baseUrl?.trim()
  if (!baseUrl) return true
  try {
    return new URL(baseUrl).host === officialHost
  } catch {
    return false
  }
}

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
    urlKind: 'openai',
    baseUrlRequired: true,
    hasEndpointStep: true,
    defaultModelField: 'required',
    apiKeyRequired: true,
    fetchModels: fetchOpenAICompatibleModelsWith,
    presetModels: context =>
      usesOfficialEndpoint(context, 'api.openai.com')
        ? CHATGPT_CODEX_MODEL_OPTIONS.map(option => ({
            id: option.value,
            displayName: option.label,
          }))
        : [],
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
    subscriptionAuth: {
      envKey: 'OPENAI_AUTH_MODE',
      modes: { chatgpt: 'ChatGPT subscription' },
      // The Codex backend maps each tier from its own table, so OPENAI_MODEL
      // is not needed — and demanding one here would be worse than useless:
      // OPENAI_MODEL pins a single model for every alias, which is the exact
      // opposite of what someone opening the tier form is asking for.
      overrides: {
        defaultModelField: 'optional',
        validate: noValidation,
        // Not "OpenAI Chat Completions Setup": that heading names a wire
        // protocol this session does not speak (ChatGPT auth forces the
        // Responses API against the Codex backend).
        title: () => 'ChatGPT Subscription — Models',
      },
    },
    afterSave: async () => {
      const client = await import('src/services/api/openai/client.js')
      client.clearOpenAIClientCache()
      // OPENAI_AUTH_MODE selects inference auth. The stored ChatGPT OAuth file
      // remains an independent Codex Web Search credential across provider
      // changes and may only be removed by an explicit logout/disconnect.
    },
  },

  anthropic: {
    modelType: 'anthropic',
    title: () => 'Anthropic Compatible Setup',
    endpointHint: () =>
      'Requests will use POST <base URL>/v1/messages. Base URL may be left empty to use api.anthropic.com.',
    defaultBaseUrl: 'https://api.anthropic.com',
    urlKind: 'anthropic',
    baseUrlRequired: false,
    hasEndpointStep: true,
    defaultModelField: 'optional',
    apiKeyRequired: false,
    fetchModels: fetchAnthropicCompatibleModelsWith,
    // An Anthropic-compatible endpoint serves Claude model names, and the
    // canonical ids are already a maintained table in this repo.
    presetModels: context =>
      usesOfficialEndpoint(context, 'api.anthropic.com')
        ? Object.values(ALL_MODEL_CONFIGS).map(config => ({
            id: config.firstParty,
          }))
        : [],
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
    urlKind: 'gemini',
    baseUrlRequired: false,
    hasEndpointStep: true,
    defaultModelField: 'optional',
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
    extraEnv: () => ({
      // A public API endpoint/key must not remain routed through an earlier
      // Antigravity OAuth session.
      GEMINI_AUTH_MODE: undefined,
    }),
    subscriptionAuth: {
      envKey: 'GEMINI_AUTH_MODE',
      modes: { antigravity: 'Antigravity Google sign-in' },
      // Only the heading: the Gemini form already treats the default model as
      // optional, and the Antigravity login writes all three base tiers, so
      // its validation passes unchanged.
      overrides: { title: () => 'Antigravity — Models' },
    },
  },

  /**
   * The China presets (DeepSeek / GLM / Qwen / MiMo). They are OpenAI-compatible,
   * so they write the same env keys — but the endpoint comes from a table rather
   * than a form, and the model list is the curated preset rather than the
   * endpoint's /models answer, so the flow joins at step 2 with the catalog
   * already in hand and the tier defaults prefilled.
   */
  china: {
    modelType: 'openai',
    title: ({ providerLabel }) =>
      `${providerLabel ?? 'China LLM Provider'} — Models`,
    endpointHint: () => '',
    defaultBaseUrl: '',
    urlKind: 'openai',
    baseUrlRequired: false,
    hasEndpointStep: false,
    defaultModelField: 'required',
    apiKeyRequired: false,
    fetchModels: async () => null,
    env: {
      baseUrl: 'OPENAI_BASE_URL',
      apiKey: 'OPENAI_API_KEY',
      model: 'OPENAI_MODEL',
      tiers: tierEnv('OPENAI'),
    },
    tiers: TIER_FIELDS,
    validate: values =>
      values.model.trim()
        ? null
        : {
            message:
              'Choose a default model for requests that do not select a tier.',
            field: 'model',
          },
    extraEnv: () => ({
      // An API key means this is no longer a ChatGPT-subscription session.
      OPENAI_AUTH_MODE: undefined,
      // A China preset writes the OpenAI keys but never asks which OpenAI wire
      // protocol to speak — the preset table settles that. A leftover
      // `OPENAI_WIRE_API` from an earlier OpenAI login therefore reads as an
      // explicit protocol choice that nobody made here, and for DeepSeek that
      // choice is load-bearing: hasExplicitWireChoice() turns it into a veto
      // that keeps the session off the Anthropic Messages wire it is supposed
      // to default to (deepseekWire.ts). The group cleanup cannot catch it —
      // this spec's own modelType is 'openai', so the OpenAI group is skipped.
      OPENAI_WIRE_API: undefined,
    }),
    afterSave: async () => {
      const client = await import('src/services/api/openai/client.js')
      client.clearOpenAIClientCache()
      // Keep ChatGPT OAuth available to the independent Codex search source.
    },
  },

  grok: {
    modelType: 'grok',
    title: () => 'xAI Grok API Setup',
    endpointHint: () =>
      'Requests will use the xAI OpenAI-compatible API. Base URL may be left empty to use api.x.ai/v1.',
    defaultBaseUrl: 'https://api.x.ai/v1',
    urlKind: 'openai',
    baseUrlRequired: false,
    hasEndpointStep: true,
    defaultModelField: 'optional',
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
    afterSave: async () => {
      const client = await import('src/services/api/grok/client.js')
      client.clearGrokClientCache()
    },
  },

  /**
   * OpenCode — two products (Zen and Go) behind one account, several wire
   * protocols behind each base URL.
   *
   * Three things make this entry unlike the others. First, the model choice
   * decides the PROTOCOL, not just the checkpoint (opencodeWire.ts derives the
   * lane from `OPENCODE_MODEL`), which is why the picker labels every option
   * with the path it lands on and why the default model is mandatory below.
   * Second, the credential can come from a Console device login OR from a key,
   * and both write the same auth mode — see `onlyWhenUnset`. Third, the base
   * URL selects the PRODUCT, and with it the catalog and who gets billed, so
   * every string here is derived from it rather than fixed to Zen.
   */
  opencode: {
    modelType: 'opencode',
    title: ({ baseUrl }) => `${opencodeEndpointLabel(baseUrl)} Setup`,
    endpointHint: ({ baseUrl }) => {
      const product = opencodeProductForBaseUrl(baseUrl)
      const other = product === 'go' ? 'zen' : 'go'
      const lanes =
        'claude-* use /messages, gpt-* and the o-series use /responses, everything else uses /chat/completions. ' +
        'A session speaks one of them — the default model below picks which, so tiers pinned to another family still ride that lane.'
      if (!product) return `Custom OpenCode-compatible endpoint. ${lanes}`
      return (
        `${OPENCODE_PRODUCTS[product].label} — ${OPENCODE_PRODUCTS[product].billing}, ` +
        `${OPENCODE_PRODUCTS[product].models.length} models. ` +
        // Spelled out because the two are one path segment apart and share a
        // host: a subscriber who leaves this on Zen is billed against the
        // credit balance and gets "Insufficient balance", which names neither
        // product. Switching is a matter of pasting the other URL here.
        `For ${OPENCODE_PRODUCTS[other].label} (${OPENCODE_PRODUCTS[other].billing}) use ${OPENCODE_PRODUCTS[other].baseUrl} instead. ` +
        lanes
      )
    },
    defaultBaseUrl: OPENCODE_ZEN_BASE_URL,
    // 'openai', not 'anthropic', even for the /messages lane: the Anthropic
    // grammar strips a trailing `/v1`, which would turn the documented base
    // (…/zen/v1) into …/zen and point every request one path segment short.
    // The Anthropic client re-derives its own version segment at request time.
    urlKind: 'openai',
    baseUrlRequired: false,
    hasEndpointStep: true,
    // Required, and this is the one provider where it is not a convenience:
    // `OPENCODE_MODEL` is the only input to the lane decision. Left empty the
    // session silently falls to /chat/completions no matter what the tiers say
    // — including a set of tiers that are all `claude-*` and expect /messages.
    defaultModelField: 'required',
    // The free tier answers with `Authorization: Bearer public` and no account
    // at all, so an empty key must drop through to the catalog rather than
    // block the form.
    apiKeyRequired: false,
    fetchModels: async ({ baseURL, apiKey, signal, onError }) => {
      const key = apiKey.trim()
      const credential = key ? { token: key, kind: 'key' as const } : null
      // The barrel's fetcher prefers the org's entitlement config, which is an
      // ACCOUNT-plane answer; a base URL occ does not recognise as one of the
      // two products has to be asked directly, or the form would validate a
      // self-hosted deployment against somebody else's console.
      const models = await (opencodeProductForBaseUrl(baseURL)
        ? fetchOpencodeModels(credential, baseURL, signal)
        : fetchZenModels(baseURL, credential ?? undefined, signal)
      ).catch(() => null)
      if (!models) onError?.('the endpoint did not answer GET /models')
      return withLaneLabels(models)
    },
    // Unlike Gemini and Grok, these tables were read off the service rather
    // than invented — /models is public on both products — so they are real
    // answers, not guesses. Chosen by the base URL's PATH, not by
    // usesOfficialEndpoint: that compares hosts, and Zen and Go share one, so
    // it would hand a Go subscriber Zen's 61 models. A base URL that is neither
    // product gets nothing — a compatible wire protocol is not catalog
    // ownership.
    presetModels: ({ baseUrl }) => opencodePresetModels(baseUrl),
    env: {
      baseUrl: 'OPENCODE_BASE_URL',
      apiKey: 'OPENCODE_API_KEY',
      model: 'OPENCODE_MODEL',
      tiers: tierEnv('OPENCODE'),
    },
    tiers: TIER_FIELDS,
    validate: values =>
      values.model.trim()
        ? null
        : {
            message:
              'Default model is required — it also decides which OpenCode protocol this session speaks.',
            field: 'model',
          },
    extraEnv: () => ({
      // Not a credential marker: this is what routes the session to Zen, so the
      // key path sets it exactly like the Console login does.
      OPENCODE_AUTH_MODE: 'opencode',
    }),
    subscriptionAuth: {
      envKey: 'OPENCODE_AUTH_MODE',
      modes: { opencode: 'OpenCode Console subscription' },
      // …but only while there is no key, which is the whole reason this field
      // exists. With one set, the credential is this form's own.
      onlyWhenUnset: 'OPENCODE_API_KEY',
      // Only the heading, and it keeps naming the product: the endpoint step is
      // skipped in this mode, so the title is the one place left that says
      // whether this session talks to Zen or to Go. The default model stays
      // mandatory: neither product resolves tiers on its own, and it is still
      // the only thing that decides the lane — a subscription changes who pays,
      // not how the request is shaped.
      overrides: {
        title: ({ baseUrl }) => `${opencodeEndpointLabel(baseUrl)} — Models`,
      },
    },
    afterSave: async () => {
      // The mirror is what actually points the clients at the configured
      // OpenCode endpoint, and it reads
      // `OPENCODE_MODEL` — which this save is the thing that changed. Skipping
      // it leaves the session claiming a lane it has not applied, which shows
      // up as an unauthenticated request to the previous provider's host.
      applyOpencodeWire()
      const client = await import('src/services/api/openai/client.js')
      client.clearOpenAIClientCache()
    },
  },
}
