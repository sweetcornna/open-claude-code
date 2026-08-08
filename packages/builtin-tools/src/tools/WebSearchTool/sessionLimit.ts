/**
 * Per-session web-search budget: opt-in, via
 * CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION. Unlimited unless that variable
 * names a positive number.
 *
 * This used to default to 200 (parity with official 2.1.212) as a guard against
 * runaway search loops. It is not one worth having by default: the cap is per
 * process lifetime and never resets, so a long-lived session that legitimately
 * searches a lot eventually loses the tool outright — and the failure lands as
 * a validation error on an ordinary search, far from the loop that caused it.
 * Runaway loops are better bounded by the token budget, which is already
 * enforced and which the user actually sets. Anyone who does want a hard stop
 * sets the variable.
 *
 * Counting continues regardless, so a cap set mid-session is immediately
 * meaningful.
 */

let webSearchesThisSession = 0

/** Configured cap, or Infinity when none is set. */
export function maxWebSearchesPerSession(): number {
  const raw = process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return Number.POSITIVE_INFINITY
}

export function isWebSearchBudgetExhausted(): boolean {
  return webSearchesThisSession >= maxWebSearchesPerSession()
}

export function countWebSearch(): void {
  webSearchesThisSession++
}

/** Reset on /clear (official 2.1.212 semantics) and in tests. */
export function resetWebSearchCount(): void {
  webSearchesThisSession = 0
}
