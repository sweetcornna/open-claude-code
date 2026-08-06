/**
 * Shared utilities for OpenAI-compatible API paths.
 *
 * Both the OpenAI path (queryModelOpenAI) and Grok path (queryModelGrok) use
 * the same adapters (openaiStreamAdapter, openaiConvertMessages), so the event
 * processing logic should be shared rather than duplicated.
 *
 * Keep this module free of bootstrap/state imports so pure request-body unit
 * tests and isolated mocks do not need a full session runtime.
 *
 * Keep imports limited to leaf modules so request-body unit tests do not pull
 * in the session runtime.
 */

import { BIN_NAME } from 'src/constants/brand.js'
import { isGptFamilyModel } from 'src/utils/model/chatgptModels.js'

export type OpenAIVerbosity = 'low' | 'medium' | 'high'

export function resolveOpenAIVerbosity(
  model: string,
  opts: { baseURL?: string; isChatGPTAuth: boolean },
): OpenAIVerbosity | undefined {
  if (!isGptFamilyModel(model)) return undefined

  const override = process.env.OPENAI_VERBOSITY?.toLowerCase().trim()
  if (override === 'off' || override === '0' || override === 'false') {
    return undefined
  }
  if (override === 'low' || override === 'medium' || override === 'high') {
    return override
  }
  return opts.isChatGPTAuth || isOfficialOpenAIBaseURL(opts.baseURL)
    ? 'low'
    : undefined
}

/**
 * Whether a configured base URL resolves directly to OpenAI's official API.
 *
 * An absent URL means the OpenAI SDK default (`api.openai.com`). Regional
 * endpoints are subdomains of `api.openai.com`. Keep this strict so generic
 * OpenAI-compatible providers never receive OpenAI-specific cache parameters.
 */
export function isOfficialOpenAIBaseURL(baseURL: string | undefined): boolean {
  if (!baseURL?.trim()) return true

  try {
    const url = new URL(baseURL)
    const isOfficialHost =
      url.hostname === 'api.openai.com' ||
      url.hostname.endsWith('.api.openai.com')
    return (
      url.protocol === 'https:' &&
      isOfficialHost &&
      (url.port === '' || url.port === '443')
    )
  } catch {
    return false
  }
}

/**
 * Build a stable OpenAI `prompt_cache_key` for a session.
 *
 * OpenAI automatic prefix caching benefits from routing sticky keys so multi-turn
 * requests land on the same cache-bearing compute node. The key must be stable
 * for the whole conversation — never derived from full message bodies (that
 * changes every turn and defeats routing).
 *
 * Format: `occ:<sessionId>`
 */
export function formatOpenAIPromptCacheKey(sessionId: string): string {
  return `${BIN_NAME}:${sessionId}`
}

// Env truthiness is re-implemented here rather than imported from
// utils/config/envUtils: this module is deliberately dependency-free so the
// pure request-body unit tests can load it without a session runtime. Keep
// the accepted spellings in sync with isEnvTruthy/isEnvDefinedFalsy.
const TRUTHY = new Set(['1', 'true', 'yes', 'on'])
const FALSY = new Set(['0', 'false', 'no', 'off'])

function envFlag(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined
  const value = raw.toLowerCase().trim()
  if (TRUTHY.has(value)) return true
  if (FALSY.has(value)) return false
  return undefined
}

/**
 * Whether this request may carry OpenAI's `prompt_cache_key`.
 *
 * Measured against a live OpenAI-compatible gateway (5 turns, ~4K-token
 * stable prefix, everything else held constant): omitting the key dropped the
 * cumulative hit rate from **75.8% to 18.3%** — per-turn 95/0/0/0/0. Without
 * a sticky routing key each turn is free to land on a different
 * cache-bearing node, so only the very first follow-up hits. This is the
 * single largest lever on the OpenAI side, well ahead of anything about
 * request-body shape.
 *
 * Sent by default everywhere, because the endpoints that cannot take it say
 * so and are then never asked again (see {@link markPromptCacheKeyRejected}).
 * The previous default — OpenAI's own endpoint only on the chat line — meant
 * the single largest cache lever was opt-in behind an env var for exactly the
 * population that needs it most: OpenAI behind a chat gateway (LiteLLM,
 * one-api, new-api, OpenRouter). Those users silently ran at the 18.3% number
 * above unless they happened to read the docs.
 *
 * The trade for endpoints that reject unknown top-level keys (Cerebras and
 * Qwen direct, historically) is one failed request per session, after which
 * the key is suppressed for the rest of the process. Endpoints that merely
 * ignore the field — the common case across the OpenAI-compatible ecosystem —
 * pay nothing.
 *
 * `OPENAI_PROMPT_CACHE_KEY=0` forces it off outright, for a gateway that
 * neither accepts the key nor returns a recognisable rejection; `=1` forces it
 * on even after a rejection.
 */
export function shouldSendOpenAIPromptCacheKey(
  baseURL: string | undefined,
  wireProtocol?: 'chat' | 'responses',
): boolean {
  const forced = envFlag(process.env.OPENAI_PROMPT_CACHE_KEY)
  if (forced !== undefined) return forced
  if (wireProtocol === 'responses') return true
  return !promptCacheKeyRejected || isOfficialOpenAIBaseURL(baseURL)
}

/**
 * Latched once an endpoint has rejected `prompt_cache_key`, so the rest of the
 * session stops paying a failed round trip per turn to re-learn it. Never set
 * for OpenAI's own endpoint, which documents the field.
 */
let promptCacheKeyRejected = false

/**
 * Whether a failed chat request looks like the endpoint objecting to
 * `prompt_cache_key` in particular, rather than to anything else in the body.
 */
export function isPromptCacheKeyRejection(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : ''
  const lower = message.toLowerCase()
  if (!lower.includes('prompt_cache_key')) return false
  return (
    lower.includes('unknown') ||
    lower.includes('unsupported') ||
    lower.includes('unrecognized') ||
    lower.includes('not supported') ||
    lower.includes('extra') ||
    lower.includes('invalid')
  )
}

/** Suppress the key for the remainder of the process. */
export function markPromptCacheKeyRejected(): void {
  promptCacheKeyRejected = true
}

/** Test-only: undo the process-wide latch between cases. */
export function _resetPromptCacheKeySupportForTesting(): void {
  promptCacheKeyRejected = false
}

/**
 * Session-sticky cache key for endpoints that accept it, or undefined when
 * the key must be withheld. See {@link shouldSendOpenAIPromptCacheKey}.
 */
export function getOpenAIPromptCacheKey(
  baseURL: string | undefined,
  sessionId: string,
  wireProtocol?: 'chat' | 'responses',
): string | undefined {
  return shouldSendOpenAIPromptCacheKey(baseURL, wireProtocol)
    ? formatOpenAIPromptCacheKey(sessionId)
    : undefined
}

/**
 * Merge a delta usage into the accumulated usage, preserving cache-related
 * fields from previous values when the delta carries explicit zeroes or
 * undefined values.
 *
 * Mirrors updateUsage() in claude.ts: a future adapter change that omits
 * cache fields from certain streaming events should not silently zero the
 * accumulated counters.
 */
export function updateOpenAIUsage(
  current: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  },
  delta: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  },
): typeof current {
  return {
    input_tokens: delta.input_tokens ?? current.input_tokens,
    output_tokens: delta.output_tokens ?? current.output_tokens,
    cache_creation_input_tokens:
      delta.cache_creation_input_tokens !== undefined &&
      delta.cache_creation_input_tokens > 0
        ? delta.cache_creation_input_tokens
        : current.cache_creation_input_tokens,
    cache_read_input_tokens:
      delta.cache_read_input_tokens !== undefined &&
      delta.cache_read_input_tokens > 0
        ? delta.cache_read_input_tokens
        : current.cache_read_input_tokens,
  }
}
