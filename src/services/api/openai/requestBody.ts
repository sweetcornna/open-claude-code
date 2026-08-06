/**
 * Pure utility functions for building OpenAI request bodies and detecting
 * thinking mode. Extracted from index.ts so tests can import them without
 * triggering heavy module side-effects (OpenAI client, stream adapter, etc.).
 */
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions/completions.mjs'
import {
  isEnvTruthy,
  isEnvDefinedFalsy,
} from '../../../utils/config/envUtils.js'
import { logForDebugging } from '../../../utils/telemetry/debug.js'
import { isCodexFamilyModel } from '../../../utils/model/chatgptModels.js'
import {
  buildDeepSeekThinkingFields,
  capDeepSeekTools,
  isDeepSeekTuningActiveForModel,
  resolveDeepSeekReasoningEffort,
  resolveDeepSeekTemperature,
} from '../../../utils/model/deepseekTuning.js'
import { isOfficialOpenAIBaseURL } from './openaiShared.js'

/**
 * Detect whether thinking mode should be enabled for this model.
 *
 * Enabled when:
 * 1. OPENAI_ENABLE_THINKING=1 is set (explicit enable), OR
 * 2. Model name contains "deepseek" or "mimo" (auto-detect, case-insensitive)
 *
 * Disabled when:
 * - OPENAI_ENABLE_THINKING=0/false/no/off is explicitly set (overrides model detection)
 *
 * @param model - The resolved OpenAI model name
 */
export function isOpenAIThinkingEnabled(model: string): boolean {
  // Explicit disable takes priority (overrides model auto-detect)
  if (isEnvDefinedFalsy(process.env.OPENAI_ENABLE_THINKING)) return false
  // Explicit enable
  if (isEnvTruthy(process.env.OPENAI_ENABLE_THINKING)) return true
  // Auto-detect from model name (DeepSeek and MiMo models support thinking mode).
  // Grok is intentionally excluded — Grok reasoning models reason automatically
  // and do NOT require thinking/enable_thinking request body parameters.
  const modelLower = model.toLowerCase()
  return modelLower.includes('deepseek') || modelLower.includes('mimo')
}

/**
 * Resolve max output tokens for the OpenAI-compatible path.
 *
 * Override priority:
 * 1. maxOutputTokensOverride (programmatic, from query pipeline)
 * 2. OPENAI_MAX_TOKENS env var (OpenAI-specific, useful for local models
 *    with small context windows, e.g. RTX 3060 12GB running 65536-token models)
 * 3. CLAUDE_CODE_MAX_OUTPUT_TOKENS env var (generic override)
 * 4. upperLimit default (64000)
 */
export function resolveOpenAIMaxTokens(
  upperLimit: number,
  maxOutputTokensOverride?: number,
): number {
  return (
    maxOutputTokensOverride ??
    (process.env.OPENAI_MAX_TOKENS
      ? parseInt(process.env.OPENAI_MAX_TOKENS, 10) || undefined
      : undefined) ??
    (process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
      ? parseInt(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, 10) || undefined
      : undefined) ??
    upperLimit
  )
}

/**
 * Build the request body for OpenAI chat.completions.create().
 * Extracted for testability — the thinking mode params are injected here.
 *
 * Three thinking-mode formats are sent simultaneously; each endpoint uses the
 * format it recognizes and ignores the others:
 * - Official DeepSeek API:    `thinking: { type: 'enabled' }`
 * - Self-hosted DeepSeek:     `enable_thinking: true` + `chat_template_kwargs: { thinking: true }`
 * - MiMo (Xiaomi):            `chat_template_kwargs: { enable_thinking: true }`
 * OpenAI SDK passes unknown keys through to the HTTP body.
 */
export function buildOpenAIRequestBody(params: {
  model: string
  messages: any[]
  tools: any[]
  toolChoice: any
  enableThinking: boolean
  maxTokens: number
  baseURL?: string
  temperatureOverride?: number
  /** Session-scoped routing key for official OpenAI requests. */
  promptCacheKey?: string
  /**
   * Chat Completions reasoning effort ('minimal'|'low'|'medium'|'high').
   * Only set for reasoning-capable OpenAI models — strict OpenAI-compatible
   * endpoints (GLM/Kimi/DeepSeek chat) reject unknown top-level keys.
   */
  reasoningEffort?: string
  /**
   * occ's raw effort level for this request ('low'|'medium'|'high'|'xhigh'|
   * 'max', or an ant-only number). Used by the DeepSeek path, which has its
   * own three-rung `reasoning_effort` ladder and previously received nothing
   * at all — the `/model` effort picker was purely cosmetic there.
   */
  effortValue?: unknown
  // `reasoning_effort` is omitted from the SDK params before being re-declared:
  // intersecting with the SDK's own union would narrow it back to OpenAI's
  // rungs, and DeepSeek's ladder includes `max`, which OpenAI has no name for.
}): Omit<ChatCompletionCreateParamsStreaming, 'reasoning_effort'> & {
  thinking?: { type: string }
  enable_thinking?: boolean
  chat_template_kwargs?: { thinking: boolean; enable_thinking: boolean }
  /** OpenAI prompt-cache routing key (not always in SDK types yet). */
  prompt_cache_key?: string
  reasoning_effort?: string
  max_completion_tokens?: number
} {
  const {
    model,
    messages,
    tools,
    toolChoice,
    enableThinking,
    maxTokens,
    baseURL,
    temperatureOverride,
    promptCacheKey,
    reasoningEffort,
    effortValue,
  } = params
  const useMaxCompletionTokens =
    isOfficialOpenAIBaseURL(baseURL) && isCodexFamilyModel(model)

  // Everything DeepSeek-specific hangs off this one predicate; when it is
  // false the body below is byte-identical to what it has always been.
  const isDeepSeek = isDeepSeekTuningActiveForModel(model, baseURL)

  // DeepSeek rejects a request carrying more than 128 functions outright.
  const { tools: effectiveTools, dropped: droppedTools } = isDeepSeek
    ? capDeepSeekTools(tools)
    : { tools, dropped: 0 }
  if (droppedTools > 0) {
    logForDebugging(
      `[DeepSeek] tool list capped at ${effectiveTools.length}; dropped ${droppedTools} trailing tool(s) over the 128-function API limit`,
    )
  }

  // DeepSeek's own parameter guide puts coding/math at temperature 0.0, and
  // its unset default is 1.0 ("data analysis"). Left alone, every request from
  // this coding agent samples far hotter than DeepSeek recommends for the job.
  const deepseekTemperature = isDeepSeek
    ? resolveDeepSeekTemperature({
        enableThinking,
        explicitOverride: temperatureOverride,
      })
    : undefined

  // DeepSeek's `thinking` field defaults to `enabled`, so switching thinking
  // off has to be stated explicitly — omitting the field (what the shared path
  // below does) left OPENAI_ENABLE_THINKING=0 a no-op against the official API.
  const deepseekThinking = isDeepSeek
    ? buildDeepSeekThinkingFields({ enableThinking, baseURL })
    : undefined

  // `reasoning_effort` was only ever sent for OpenAI reasoning models, so every
  // DeepSeek request ran at DeepSeek's default `high` no matter what `/model`
  // or CLAUDE_CODE_EFFORT_LEVEL said. Meaningless when thinking is off — which
  // is also what keeps the `max` default off checkpoints that ignore the field.
  // The resolver always returns a rung now, so the OpenAI-side value below is
  // never consulted for DeepSeek (it is not an OpenAI reasoning model).
  const effectiveReasoningEffort =
    (isDeepSeek && enableThinking
      ? resolveDeepSeekReasoningEffort(effortValue)
      : undefined) ?? reasoningEffort

  return {
    model,
    messages,
    ...(useMaxCompletionTokens
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens }),
    ...(promptCacheKey && { prompt_cache_key: promptCacheKey }),
    ...(effectiveTools.length > 0 && {
      tools: effectiveTools,
      ...(toolChoice && { tool_choice: toolChoice }),
    }),
    stream: true,
    stream_options: { include_usage: true },
    ...(effectiveReasoningEffort && {
      reasoning_effort: effectiveReasoningEffort,
    }),
    // DeepSeek states its own switches (both directions, and only the
    // documented field on the official endpoint); everything else keeps the
    // enable-only, send-all-three-dialects shape.
    ...(deepseekThinking ??
      // Enable chain-of-thought output for MiMo and other thinking-capable
      // compatible endpoints. When active,
      // temperature/top_p/presence_penalty/frequency_penalty are ignored.
      (enableThinking && {
        // Official DeepSeek API format
        thinking: { type: 'enabled' },
        // Self-hosted DeepSeek-V3.2 format
        enable_thinking: true,
        // Both DeepSeek self-hosted and MiMo formats in chat_template_kwargs
        chat_template_kwargs: { thinking: true, enable_thinking: true },
      })),
    // Only send temperature when thinking mode is off (DeepSeek ignores it anyway,
    // but other providers may respect it). On DeepSeek the resolved value also
    // supplies the documented coding default when no caller override exists.
    ...(!enableThinking &&
      (isDeepSeek
        ? deepseekTemperature !== undefined && {
            temperature: deepseekTemperature,
          }
        : temperatureOverride !== undefined && {
            temperature: temperatureOverride,
          })),
  }
}
