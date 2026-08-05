import { resolveOpenAIModel } from '@ant/model-provider'
import { isGptFamilyModel } from './chatgptModels.js'
import { getMainLoopModel } from './model.js'
import { getAPIProvider } from './providers.js'

/**
 * Single gate for all GPT-specific tuning: the behavior prompt overlay,
 * restrained EnterPlanMode/Agent tool copy, and plan-mode instruction
 * variants. True only when the session targets the OpenAI provider AND the
 * main-loop model resolves to a GPT-family id — Anthropic sessions and
 * non-GPT models behind the OpenAI-compatible layer stay byte-identical.
 *
 * Reads global state (precedent: pdfUtils.isPDFSupported) because tool
 * prompt() callsites don't receive the model.
 */
export function isGptTuningActive(): boolean {
  if (getAPIProvider() !== 'openai') return false
  // The main-loop model may still be a Claude alias (`/model opus`) that the
  // OpenAI adapter maps to a GPT id at request time — apply the same mapping
  // before classifying, or alias sessions would silently miss the gate.
  return isGptFamilyModel(resolveOpenAIModel(getMainLoopModel()))
}

/**
 * Same gate for callsites that already know the concrete model being
 * requested (the OpenAI adapter), where the main-loop model may differ
 * (e.g. subagents on a different tier).
 */
export function isGptTuningActiveForModel(model: string): boolean {
  if (getAPIProvider() !== 'openai') return false
  return isGptFamilyModel(model)
}
