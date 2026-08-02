/**
 * Default OpenAI model per Anthropic capability family. Used only when no
 * env override applies. Family matching (not an exact model-ID table) so new
 * Anthropic model IDs keep resolving without maintenance here.
 *
 * Values mirror the ChatGPT/Codex tier constants in
 * `src/utils/model/chatgptModels.ts` (frontier / balanced / fast) — this
 * package is a leaf and cannot import them, so keep the two in sync when the
 * frontier generation changes.
 */
const DEFAULT_MODEL_BY_FAMILY: Record<'haiku' | 'sonnet' | 'opus', string> = {
  opus: 'gpt-5.6-sol',
  sonnet: 'gpt-5.6-terra',
  haiku: 'gpt-5.6-luna',
}

function getModelFamily(model: string): 'haiku' | 'sonnet' | 'opus' | null {
  if (/haiku/i.test(model)) return 'haiku'
  if (/opus/i.test(model)) return 'opus'
  if (/sonnet/i.test(model)) return 'sonnet'
  return null
}

/**
 * Resolve the OpenAI model name for a given Anthropic model.
 *
 * Priority:
 * 1. OPENAI_MODEL env var (override all)
 * 2. OPENAI_DEFAULT_{FAMILY}_MODEL env var (e.g. OPENAI_DEFAULT_SONNET_MODEL)
 * 3. ANTHROPIC_DEFAULT_{FAMILY}_MODEL env var (backward compatibility)
 * 4. DEFAULT_MODEL_BY_FAMILY (any model name containing haiku/sonnet/opus)
 * 5. Pass through original model name
 */
export function resolveOpenAIModel(anthropicModel: string): string {
  if (process.env.OPENAI_MODEL) {
    return process.env.OPENAI_MODEL
  }

  const cleanModel = anthropicModel.replace(/\[1m\]$/, '')

  const family = getModelFamily(cleanModel)
  if (family) {
    const openaiEnvVar = `OPENAI_DEFAULT_${family.toUpperCase()}_MODEL`
    const openaiOverride = process.env[openaiEnvVar]
    if (openaiOverride) return openaiOverride

    const anthropicEnvVar = `ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`
    const anthropicOverride = process.env[anthropicEnvVar]
    if (anthropicOverride) return anthropicOverride

    return DEFAULT_MODEL_BY_FAMILY[family]
  }

  return cleanModel
}
