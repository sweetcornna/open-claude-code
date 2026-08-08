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
const DEFAULT_MODEL_BY_FAMILY: Record<
  'haiku' | 'sonnet' | 'opus' | 'fable',
  string
> = {
  // Fable is the tier above Opus; OpenAI has no distinct higher tier, so it
  // maps to the same frontier model unless OPENAI_DEFAULT_FABLE_MODEL is set.
  fable: 'gpt-5.6-sol',
  opus: 'gpt-5.6-sol',
  sonnet: 'gpt-5.6-terra',
  haiku: 'gpt-5.6-luna',
}

function getModelFamily(
  model: string,
): 'haiku' | 'sonnet' | 'opus' | 'fable' | null {
  if (/haiku/i.test(model)) return 'haiku'
  if (/fable/i.test(model)) return 'fable'
  if (/opus/i.test(model)) return 'opus'
  if (/sonnet/i.test(model)) return 'sonnet'
  return null
}

/**
 * Resolve the OpenAI model name for a given Anthropic model.
 *
 * A model id that names no capability family is a model the user asked for by
 * name — `/model glm-4.6`, a settings pin, an SDK caller — and it passes through
 * untouched. OPENAI_MODEL is the provider's DEFAULT, so it only fills in for a
 * family alias nobody pinned; ranking it first turned it into a session-wide
 * lock that rewrote even an explicit `/model <id>`.
 *
 * Priority, for a family alias (haiku / sonnet / opus / fable):
 * 1. OPENAI_DEFAULT_{FAMILY}_MODEL env var (e.g. OPENAI_DEFAULT_SONNET_MODEL)
 * 2. ANTHROPIC_DEFAULT_{FAMILY}_MODEL env var (backward compatibility)
 * 3. OPENAI_MODEL env var (the provider default, for unpinned tiers)
 * 4. DEFAULT_MODEL_BY_FAMILY
 *
 * Anything else: pass through the original model name.
 */
export function resolveOpenAIModel(anthropicModel: string): string {
  const cleanModel = anthropicModel.replace(/\[1m\]$/, '')

  const family = getModelFamily(cleanModel)
  if (family) {
    const openaiEnvVar = `OPENAI_DEFAULT_${family.toUpperCase()}_MODEL`
    const openaiOverride = process.env[openaiEnvVar]
    if (openaiOverride) return openaiOverride

    const anthropicEnvVar = `ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`
    const anthropicOverride = process.env[anthropicEnvVar]
    if (anthropicOverride) return anthropicOverride

    return process.env.OPENAI_MODEL || DEFAULT_MODEL_BY_FAMILY[family]
  }

  return cleanModel
}
