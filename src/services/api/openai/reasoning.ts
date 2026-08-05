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

/** Chat Completions supports no reasoning tiers above `high`. */
export function getChatReasoningEffort(
  model: string,
  effortValue: unknown,
): 'low' | 'medium' | 'high' | undefined {
  const resolved = getResponsesReasoningEffort(model, effortValue)
  if (resolved === 'xhigh' || resolved === 'max') return 'high'
  return resolved
}
