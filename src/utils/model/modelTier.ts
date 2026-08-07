/**
 * Which family alias a concrete model id belongs to.
 *
 * This regex already existed three times, module-private, in
 * `packages/@ant/model-provider/src/providers/{openai,gemini,grok}/modelMapping.ts`.
 * Per-tier configuration needs the same answer on the host side, so it lives
 * here once instead of a fourth copy.
 *
 * Deliberately zero imports. `getContextWindowForModel` and
 * `getDefaultEffortForModel` both consult this, and both are reachable from
 * `providers.ts`; anything with a dependency would close a cycle — the same
 * trap that made deepseekHost.ts necessary.
 *
 * Order matters: `fable` is checked before `opus`/`sonnet` because a Fable id
 * never contains those words, but future marketing names might combine them.
 */

/** The four family aliases occ exposes (`/model opus`, `/model haiku`, …). */
export const MODEL_TIERS = ['haiku', 'sonnet', 'opus', 'fable'] as const

export type ModelTier = (typeof MODEL_TIERS)[number]

/**
 * The tier a model id maps to, or undefined when it names none of them.
 *
 * Undefined is the common case for third-party ids (`deepseek-v4-pro`,
 * `glm-5.2`, `gpt-5.6-sol`), which is why per-tier configuration is keyed off
 * the *alias the user asked for* wherever that is known, and only falls back
 * to sniffing the concrete id.
 */
export function getModelTier(model: string): ModelTier | undefined {
  if (/haiku/i.test(model)) return 'haiku'
  if (/fable/i.test(model)) return 'fable'
  if (/opus/i.test(model)) return 'opus'
  if (/sonnet/i.test(model)) return 'sonnet'
  return undefined
}

/** Type guard for values coming out of settings.json. */
export function isModelTier(value: unknown): value is ModelTier {
  return (
    typeof value === 'string' &&
    (MODEL_TIERS as readonly string[]).includes(value)
  )
}
