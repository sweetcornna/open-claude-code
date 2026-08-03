/**
 * Per-session web-search budget (parity with official 2.1.212):
 * CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION, default 200. Guards against
 * runaway search loops burning quota. Counted per process lifetime (the
 * official build also resets on /clear; wiring that reset needs a host
 * facade and is deliberately deferred — a stricter budget, not a looser one).
 */

const DEFAULT_MAX_WEB_SEARCHES_PER_SESSION = 200

let webSearchesThisSession = 0

export function maxWebSearchesPerSession(): number {
  const raw = process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_MAX_WEB_SEARCHES_PER_SESSION
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
