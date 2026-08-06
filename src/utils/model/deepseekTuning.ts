import { resolveOpenAIModel } from '@ant/model-provider'
import {
  DEEPSEEK_CONTEXT_WINDOW,
  getDeepSeekContextWindow,
  isDeepSeekBaseURL,
  isDeepSeekFamilyModel,
} from './deepseekFamily.js'
import { getMainLoopModel } from './model.js'
import { getAPIProvider } from './providers.js'

// The dependency-free half of the gate. Re-exported so this module stays the
// single import site for DeepSeek behavior (CLAUDE.md), while session/context
// and effort can reach the predicates without dragging model.js in behind them.
export {
  DEEPSEEK_CONTEXT_WINDOW,
  getDeepSeekContextWindow,
  isDeepSeekBaseURL,
  isDeepSeekFamilyModel,
}

/**
 * Single gate for all DeepSeek-specific tuning, mirroring gptTuning.ts.
 *
 * Everything DeepSeek-specific in this codebase must hang off one of the
 * predicates here. Anthropic sessions and other models behind the
 * OpenAI-compatible layer (GLM, Kimi, MiMo, Qwen, local vLLM) must stay
 * byte-identical — the tuning below encodes DeepSeek's *documented* API
 * contract, and applying it blind would misconfigure every other endpoint.
 */

/**
 * DeepSeek's default sampling temperature is 1.0, which its own parameter
 * guide assigns to "data cleaning / data analysis". The guide's recommended
 * value for coding and math is 0.0 — and a coding agent is the coding case.
 *
 * https://api-docs.deepseek.com/quick_start/parameter_settings/
 */
export const DEEPSEEK_CODING_TEMPERATURE = 0

/**
 * Hard API limit: "a max of 128 functions are supported". Over the cap the
 * request is rejected outright, which with a few MCP servers attached is an
 * easy ceiling to hit.
 *
 * https://api-docs.deepseek.com/api/create-chat-completion/
 */
export const DEEPSEEK_MAX_TOOLS = 128

/**
 * The gate for callsites inside the OpenAI adapter, which already know the
 * concrete model id being requested (a subagent may run a different tier than
 * the main loop).
 */
export function isDeepSeekTuningActiveForModel(
  model: string,
  baseURL?: string,
): boolean {
  return isDeepSeekFamilyModel(model) || isDeepSeekBaseURL(baseURL)
}

/**
 * The gate for callsites that only have global state to work from (tool
 * `prompt()` bodies get no model argument). Requires the OpenAI-compatible
 * provider *and* a DeepSeek main-loop model; a `/model opus` alias is mapped
 * through resolveOpenAIModel first, exactly as isGptTuningActive does, so
 * alias sessions don't silently miss the gate.
 */
export function isDeepSeekTuningActive(): boolean {
  if (getAPIProvider() !== 'openai') return false
  if (isDeepSeekBaseURL(process.env.OPENAI_BASE_URL)) return true
  return isDeepSeekFamilyModel(resolveOpenAIModel(getMainLoopModel()))
}

/**
 * Resolve the temperature to send to a DeepSeek chat request.
 *
 * - An explicit caller override always wins (side queries pass 0 already).
 * - `DEEPSEEK_TEMPERATURE` lets a user opt out of the coding default without
 *   giving up the rest of the tuning; an unparseable or out-of-range value is
 *   ignored rather than forwarded (DeepSeek accepts 0–2).
 * - Otherwise the documented coding value.
 *
 * Returns `undefined` when thinking mode is on: DeepSeek states thinking mode
 * "does not support the temperature, top_p, presence_penalty, or
 * frequency_penalty parameters", so sending one is at best ignored noise in
 * the cached prefix.
 */
export function resolveDeepSeekTemperature(params: {
  enableThinking: boolean
  explicitOverride?: number
}): number | undefined {
  if (params.enableThinking) return undefined
  if (params.explicitOverride !== undefined) return params.explicitOverride

  const raw = process.env.DEEPSEEK_TEMPERATURE
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2) return parsed
  }

  return DEEPSEEK_CODING_TEMPERATURE
}

/**
 * DeepSeek's `reasoning_effort` ladder is three rungs — `low`, `high`, `max`.
 * occ has five, so they collapse:
 *
 * | occ     | DeepSeek | why |
 * | ------- | -------- | --- |
 * | low     | low      | the cheap rung, as intended |
 * | medium  | high     | the middle of a three-rung ladder |
 * | high    | high     | same rung |
 * | xhigh   | max      | nothing between high and max to land on |
 * | max     | max      | DeepSeek's recommendation for demanding agent work |
 * | (unset) | max      | see below |
 *
 * `deepseek-v4-pro` currently accepts only `high`/`max` and coerces `low`
 * server-side, so no per-model narrowing is needed here.
 */
export type DeepSeekReasoningEffort = 'low' | 'high' | 'max'

/**
 * What a session that never touched `/effort` runs at.
 *
 * DeepSeek's own unset default is `high`, and this used to send nothing and
 * inherit it. `max` is the rung DeepSeek recommends for demanding agent work,
 * and an agent driving a codebase is that workload — on a three-rung ladder
 * the difference between the default and the top is one step, not the long
 * climb the five-rung naming suggests.
 *
 * Only the floor moves: `/effort` and CLAUDE_CODE_EFFORT_LEVEL still win, so
 * anyone who wants the cheaper rungs says so and gets them.
 */
export const DEEPSEEK_DEFAULT_REASONING_EFFORT: DeepSeekReasoningEffort = 'max'

export function resolveDeepSeekReasoningEffort(
  effortValue: unknown,
): DeepSeekReasoningEffort {
  switch (effortValue) {
    case 'low':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
    case 'max':
      return 'max'
    default:
      // Unset, and the ant-only numeric efforts that have no rung here.
      return DEEPSEEK_DEFAULT_REASONING_EFFORT
  }
}

/**
 * Thinking-mode switches for a DeepSeek request.
 *
 * DeepSeek's `thinking` field defaults to `enabled`, so "off" has to be said
 * out loud — omitting the field left `OPENAI_ENABLE_THINKING=0` a no-op
 * against the official API, which is the opposite of what the user asked for.
 *
 * The official endpoint only documents `thinking`; `enable_thinking` and
 * `chat_template_kwargs` are the self-hosted (vLLM / SGLang chat-template)
 * spellings. Both are emitted off-endpoint so a self-hosted DeepSeek reached
 * by model name still flips, and suppressed on api.deepseek.com so the
 * official body carries no unknown keys.
 */
export function buildDeepSeekThinkingFields(params: {
  enableThinking: boolean
  baseURL?: string
}): Record<string, unknown> {
  const { enableThinking } = params
  const official = isDeepSeekBaseURL(params.baseURL)

  return {
    thinking: { type: enableThinking ? 'enabled' : 'disabled' },
    ...(official
      ? {}
      : {
          enable_thinking: enableThinking,
          chat_template_kwargs: {
            thinking: enableThinking,
            enable_thinking: enableThinking,
          },
        }),
  }
}

/**
 * Trim a tool array to DeepSeek's 128-function ceiling.
 *
 * Order is load-bearing: the tool list is built core-first, so truncating the
 * tail drops the least-essential (typically MCP) tools rather than Read/Edit/
 * Bash. Returns the count dropped so the caller can log it — a silently
 * shortened tool list is much harder to diagnose than a noisy one.
 */
export function capDeepSeekTools<T>(tools: T[]): {
  tools: T[]
  dropped: number
} {
  if (tools.length <= DEEPSEEK_MAX_TOOLS) return { tools, dropped: 0 }
  return {
    tools: tools.slice(0, DEEPSEEK_MAX_TOOLS),
    dropped: tools.length - DEEPSEEK_MAX_TOOLS,
  }
}
