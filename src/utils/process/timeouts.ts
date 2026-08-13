// Constants for timeout values
const DEFAULT_TIMEOUT_MS = 120_000 // 2 minutes
const MAX_TIMEOUT_MS = 600_000 // 10 minutes

type EnvLike = Record<string, string | undefined>

/**
 * Get the default timeout for bash operations in milliseconds
 * Checks BASH_DEFAULT_TIMEOUT_MS environment variable or returns 2 minutes default
 * @param env Environment variables to check (defaults to process.env for production use)
 */
export function getDefaultBashTimeoutMs(env: EnvLike = process.env): number {
  const envValue = env.BASH_DEFAULT_TIMEOUT_MS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_TIMEOUT_MS
}

/**
 * Get the maximum timeout for bash operations in milliseconds
 * Checks BASH_MAX_TIMEOUT_MS environment variable or returns 10 minutes default
 * @param env Environment variables to check (defaults to process.env for production use)
 */
export function getMaxBashTimeoutMs(env: EnvLike = process.env): number {
  const envValue = env.BASH_MAX_TIMEOUT_MS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (!isNaN(parsed) && parsed > 0) {
      // Ensure max is at least as large as default
      return Math.max(parsed, getDefaultBashTimeoutMs(env))
    }
  }
  // Always ensure max is at least as large as default
  return Math.max(MAX_TIMEOUT_MS, getDefaultBashTimeoutMs(env))
}

/**
 * Clamp a model-requested bash timeout into the enforceable range
 * [default, getMaxBashTimeoutMs()].
 *
 * The Bash tool schema and prompt both advertise a ceiling ("max 600000"), but
 * nothing enforced it — `timeout || default` passed the requested value through
 * untouched, so a model requesting `timeout: 3600000` got a one-hour blocking
 * foreground bash. Non-positive / non-finite / falsy requests fall back to the
 * default (the lower bound; note a bare `||` would let a negative such as -5
 * slip through since it is truthy); anything above the max is capped.
 *
 * Mirrors official's `Math.min(requested || default, max)`
 * (module-9cb2f0ec421d.mjs:1234) and PowerShellTool's existing clamp
 * (PowerShellTool.tsx:807), plus the negative-value guard the bare `||` misses.
 */
export function clampBashTimeoutMs(
  requested: number | undefined,
  env: EnvLike = process.env,
): number {
  const max = getMaxBashTimeoutMs(env)
  if (
    typeof requested !== 'number' ||
    !Number.isFinite(requested) ||
    requested <= 0
  ) {
    // getDefaultBashTimeoutMs is always <= max by construction, but clamp
    // defensively in case BASH_DEFAULT_TIMEOUT_MS is set above the max.
    return Math.min(getDefaultBashTimeoutMs(env), max)
  }
  return Math.min(requested, max)
}
