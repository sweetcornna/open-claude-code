/**
 * Google Antigravity subscription auth — Gemini 3 family access through
 * Antigravity's Cloud Code backend using a Google account instead of a Gemini
 * API key. Antigravity is Google's agentic IDE (released 2025-11); signing in
 * with Google grants the IDE's model quota, which occ reuses over the same
 * `v1internal` endpoints the IDE itself calls.
 *
 * Shape deliberately mirrors ./chatgptModels.ts — the ChatGPT-subscription
 * equivalent living under the OpenAI family. Antigravity is *not* a new
 * provider family: it is an auth mode of the existing `gemini` family, exactly
 * as `OPENAI_AUTH_MODE=chatgpt` is an auth mode of `openai`.
 *
 * This module is a pure leaf (data + predicates only) so the startup logo and
 * the login UI can both read it without pulling the network layer in.
 */

import { parseContextWindowTokens } from './chinaLlmProviders.js'

/** Value of GEMINI_AUTH_MODE that turns on the Antigravity backend. */
export const ANTIGRAVITY_AUTH_MODE = 'antigravity'

/**
 * Whether this session authenticates to Gemini through Antigravity OAuth.
 *
 * Mirrors isChatGPTAuthMode(): a single env key drives it, so settings.env,
 * provider profiles and a plain shell export all reach the same switch.
 */
export function isAntigravityAuthMode(): boolean {
  return process.env.GEMINI_AUTH_MODE === ANTIGRAVITY_AUTH_MODE
}

/**
 * Model ids served by the Antigravity backend. These are Antigravity's own
 * ids, not the public Gemini API ids — `gemini-pro-agent` is Gemini 3.1 Pro
 * pinned to high reasoning, `gemini-3.1-pro-low` the same model at a low
 * thinking budget. Sending a public id (`gemini-3-pro-preview`) to
 * `v1internal` is rejected.
 */
export const ANTIGRAVITY_PRO_HIGH_MODEL = 'gemini-pro-agent'
export const ANTIGRAVITY_PRO_LOW_MODEL = 'gemini-3.1-pro-low'
export const ANTIGRAVITY_FLASH_MODEL = 'gemini-3.6-flash-high'
export const ANTIGRAVITY_FLASH_LITE_MODEL = 'gemini-3.1-flash-lite'

/**
 * occ capability tier → Antigravity model.
 *
 * sonnet is the main-loop default, so it gets the Gemini 3.1 Pro flagship at a
 * low thinking budget; opus escalates the same model to high reasoning; haiku
 * drops to Flash Lite so subagent/summarisation traffic does not burn the Pro
 * quota.
 */
export const ANTIGRAVITY_MODELS_BY_TIER = {
  opus: ANTIGRAVITY_PRO_HIGH_MODEL,
  sonnet: ANTIGRAVITY_PRO_LOW_MODEL,
  haiku: ANTIGRAVITY_FLASH_LITE_MODEL,
} as const

export type AntigravityModelTier = keyof typeof ANTIGRAVITY_MODELS_BY_TIER

export type AntigravityModelOption = {
  value: string
  label: string
  description: string
  /** Display context window; parsed by parseContextWindowTokens() on login. */
  contextWindow: string
}

/**
 * Models the Antigravity backend exposes, newest/strongest first. Claude and
 * GPT-OSS ids are also served there but are deliberately omitted: routing
 * occ's Claude-shaped traffic back through a Claude model behind a Google
 * proxy adds a translation hop for no gain.
 */
export const ANTIGRAVITY_MODEL_OPTIONS: AntigravityModelOption[] = [
  {
    value: ANTIGRAVITY_PRO_HIGH_MODEL,
    label: 'Gemini 3.1 Pro (High)',
    description: 'Frontier model, high reasoning budget',
    contextWindow: '1M',
  },
  {
    value: ANTIGRAVITY_PRO_LOW_MODEL,
    label: 'Gemini 3.1 Pro (Low)',
    description: 'Frontier model, low reasoning budget for everyday coding',
    contextWindow: '1M',
  },
  {
    value: ANTIGRAVITY_FLASH_MODEL,
    label: 'Gemini 3.6 Flash',
    description: 'Fast general-purpose model',
    contextWindow: '1M',
  },
  {
    value: ANTIGRAVITY_FLASH_LITE_MODEL,
    label: 'Gemini 3.1 Flash Lite',
    description: 'Smallest and fastest model for simple tasks',
    contextWindow: '1M',
  },
]

/** Display context window shared by every Gemini 3.x model on Antigravity. */
export const ANTIGRAVITY_CONTEXT_WINDOW_DISPLAY = '1M'

export function findAntigravityModelOption(
  model: string,
): AntigravityModelOption | undefined {
  const normalized = model
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/i, '')
  return ANTIGRAVITY_MODEL_OPTIONS.find(
    option => option.value.toLowerCase() === normalized,
  )
}

/**
 * Env written by a successful Antigravity login so the session is usable with
 * zero manual configuration.
 *
 * Deliberately does NOT set GEMINI_MODEL: resolveGeminiModel() treats it as an
 * all-tier override, which would send haiku-tier subagent traffic to the Pro
 * model. The three tier keys give the same "just works" result while keeping
 * the tiers distinct.
 *
 * CLAUDE_CODE_MAX_CONTEXT_TOKENS is derived through parseContextWindowTokens()
 * — the same idiom the China-preset login path uses — because third-party
 * models cannot be probed for their window and would otherwise fall back to
 * 200k, tripping auto-compact at a fifth of the real budget.
 */
export function buildAntigravityAutoConfigEnv(params?: {
  /** Override the main (sonnet-tier) model; defaults to the table above. */
  model?: string
}): Record<string, string> {
  const sonnetModel = params?.model?.trim() || ANTIGRAVITY_MODELS_BY_TIER.sonnet
  const option = findAntigravityModelOption(sonnetModel)
  const contextTokens = parseContextWindowTokens(
    option?.contextWindow ?? ANTIGRAVITY_CONTEXT_WINDOW_DISPLAY,
  )
  const env: Record<string, string> = {
    GEMINI_AUTH_MODE: ANTIGRAVITY_AUTH_MODE,
    GEMINI_DEFAULT_OPUS_MODEL: ANTIGRAVITY_MODELS_BY_TIER.opus,
    GEMINI_DEFAULT_SONNET_MODEL: sonnetModel,
    GEMINI_DEFAULT_HAIKU_MODEL: ANTIGRAVITY_MODELS_BY_TIER.haiku,
  }
  if (contextTokens) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(contextTokens)
  }
  return env
}
