/**
 * `CLAUDE_CODE_NO_MODEL_FALLBACK` — a hard guarantee that a session never
 * silently answers from a model other than the one it was asked for.
 *
 * Callers that need it (regulated environments, evals, cost attribution) care
 * that the guarantee holds everywhere, not that any individual pivot site
 * remembers to check. So the chain builder is the single place the guarantee
 * is expressed: with the variable set it collapses to `[primary]`, and every
 * "try the next model" site downstream simply finds nothing to try.
 *
 * Zero dependencies on purpose — this is called from the query loop.
 */

/** Values that count as "on", matching isEnvTruthy. */
const TRUTHY = ['1', 'true', 'yes', 'on']

export function isNoModelFallbackEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.CLAUDE_CODE_NO_MODEL_FALLBACK
  if (!raw) return false
  return TRUTHY.includes(raw.toLowerCase().trim())
}

/**
 * The ordered list of models a request may fall back to after the primary.
 * Returns undefined (no fallbacks at all) when the no-fallback guarantee is
 * active, whatever `--fallback-model` asked for.
 */
export function buildAvailabilityFallbackChain(
  fallbackModels: string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  if (isNoModelFallbackEnabled(env)) return undefined
  return fallbackModels
}
