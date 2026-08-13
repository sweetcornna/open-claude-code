export const WEB_SEARCH_TIMEOUT_ENV = 'CLAUDE_CODE_WEB_SEARCH_TIMEOUT_MS'
export const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 180_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

export function parseWebSearchExecutionTimeoutMs(
  raw = process.env[WEB_SEARCH_TIMEOUT_ENV],
): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return DEFAULT_WEB_SEARCH_TIMEOUT_MS
  }
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed <= MAX_TIMER_DELAY_MS
    ? parsed
    : DEFAULT_WEB_SEARCH_TIMEOUT_MS
}

export function getWebSearchExecutionTimeoutMs(): number {
  return parseWebSearchExecutionTimeoutMs()
}
