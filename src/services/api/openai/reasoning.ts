import { CHATGPT_CODEX_DEFAULT_MODEL } from 'src/utils/model/chatgptModels.js'

export type ResponsesReasoningEffort =
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

function convertToResponsesReasoningEffort(
  effortValue: unknown,
): ResponsesReasoningEffort | undefined {
  if (effortValue === 'low') return 'low'
  if (effortValue === 'medium') return 'medium'
  if (effortValue === 'high') return 'high'
  if (effortValue === 'xhigh') return 'xhigh'
  if (effortValue === 'max') return 'max'
  if (typeof effortValue === 'number') return 'high'
  return undefined
}

function getDefaultOpenAIReasoningEffort(model: string): 'low' | 'medium' {
  const normalized = model.toLowerCase().replace(/\[1m\]$/i, '')
  return normalized === CHATGPT_CODEX_DEFAULT_MODEL ||
    normalized.startsWith(`${CHATGPT_CODEX_DEFAULT_MODEL}-`)
    ? 'low'
    : 'medium'
}

export function getResponsesReasoningEffort(
  model: string,
  effortValue: unknown,
): ResponsesReasoningEffort | undefined {
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL?.toLowerCase()
  if (envOverride === 'auto' || envOverride === 'unset') return undefined
  return (
    convertToResponsesReasoningEffort(envOverride) ??
    convertToResponsesReasoningEffort(effortValue) ??
    getDefaultOpenAIReasoningEffort(model)
  )
}

/**
 * Reasoning-summary detail level for the Responses API.
 *
 * OpenAI does **not** emit reasoning summaries unless you ask for them: "This
 * output will not be included unless you explicitly opt in to including
 * reasoning summaries." Without `reasoning.summary` the stream carries no
 * `response.reasoning_summary_text.delta` events at all, so occ saw no
 * thinking blocks, the spinner never entered `thinking` mode, and GPT models
 * looked like they were idling through the part of the turn where they do the
 * most work.
 *
 * `auto` asks for the most detailed summarizer the model offers.
 */
export type ResponsesReasoningSummary = 'auto' | 'concise' | 'detailed'

/**
 * Resolve the summary level to request. `OPENAI_REASONING_SUMMARY` accepts a
 * level, or `off`/`0`/`false` to suppress summaries entirely — an escape hatch
 * for organizations that have not completed the verification OpenAI requires
 * for summarizers on its latest reasoning models, and for `/responses`
 * gateways that reject the field.
 *
 * Returns undefined when summaries are switched off.
 */
export function getResponsesReasoningSummary(): ResponsesReasoningSummary {
  const raw = process.env.OPENAI_REASONING_SUMMARY?.trim().toLowerCase()
  if (raw === 'concise' || raw === 'detailed' || raw === 'auto') return raw
  return 'auto'
}

/** Whether the user has explicitly suppressed reasoning summaries. */
export function isResponsesReasoningSummaryDisabled(): boolean {
  const raw = process.env.OPENAI_REASONING_SUMMARY?.trim().toLowerCase()
  return raw === 'off' || raw === '0' || raw === 'false' || raw === 'none'
}

/** Chat Completions supports no reasoning tiers above `high`. */
export function getChatReasoningEffort(
  model: string,
  effortValue: unknown,
): 'low' | 'medium' | 'high' | undefined {
  const resolved = getResponsesReasoningEffort(model, effortValue)
  if (resolved === 'xhigh' || resolved === 'max') return 'high'
  return resolved
}
