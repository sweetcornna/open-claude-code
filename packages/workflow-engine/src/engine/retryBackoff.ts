import { AGENT_RETRY_JITTER_RATIO } from '../constants.js'

/**
 * Backoff before retry number `retryNo` (1-based): `base * 2^(retryNo - 1)`, plus up to
 * AGENT_RETRY_JITTER_RATIO of that as jitter.
 *
 * Extracted from hooks.agent as a pure function so the formula is directly testable: every
 * retry test injects `retryBackoffMs: 0` to stay instant, which makes the growth curve and the
 * jitter bound invisible to them — a mis-typed exponent would keep the whole suite green.
 *
 * `jitter` is the [0, 1) fraction (Math.random() in production, fixed in tests). Callers should
 * not pre-multiply it; passing 0 yields the exact geometric value and 1 the maximum.
 */
export function retryDelayMs(
  baseMs: number,
  retryNo: number,
  jitter: number = Math.random(),
): number {
  if (baseMs <= 0) return 0
  return Math.round(
    baseMs * 2 ** (retryNo - 1) * (1 + jitter * AGENT_RETRY_JITTER_RATIO),
  )
}
