/**
 * `--max-turns` / `CLAUDE_CODE_MAX_TURNS`.
 *
 * The flag already existed (hidden); the environment fallback did not, which
 * matters for the callers most likely to want a turn ceiling — CI jobs and SDK
 * daemons that set an environment once rather than editing every invocation.
 *
 * Fail loud, not open: unlike the version gate, a malformed value here means
 * "run without the ceiling you asked for", i.e. an unbounded agent loop and an
 * unbounded bill. A bad value is rejected instead.
 *
 * Pure — takes the flag value and the raw environment string, returns a number
 * or throws. No mocks needed to test it.
 */

export const MAX_TURNS_ENV_VAR = 'CLAUDE_CODE_MAX_TURNS'

export function resolveMaxTurns(
  flagValue: number | undefined,
  envValue: string | undefined,
): number | undefined {
  // The explicit flag always wins; the environment is only a default.
  if (flagValue !== undefined) return flagValue

  const raw = envValue?.trim()
  if (!raw) return undefined

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${MAX_TURNS_ENV_VAR} must be a positive integer, got "${raw}".`,
    )
  }
  return parsed
}
