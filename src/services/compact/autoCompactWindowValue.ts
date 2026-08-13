export const AUTO_COMPACT_WINDOW_MIN_TOKENS = 100_000
export const AUTO_COMPACT_WINDOW_MAX_TOKENS = 1_000_000
export const AUTO_COMPACT_WINDOW_ENV_VAR = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'

export type AutoCompactWindowValue = number | 'auto'

export function parseAutoCompactWindowInput(
  raw: string,
): AutoCompactWindowValue | undefined {
  const text = raw.trim().toLowerCase()
  if (text === 'auto') return 'auto'

  let tokens: number
  if (text.endsWith('m')) {
    tokens = parseFloat(text) * 1_000_000
  } else if (text.endsWith('k')) {
    tokens = parseFloat(text) * 1_000
  } else {
    const parsed = parseInt(text, 10)
    tokens = parsed >= 100 && parsed <= 1000 ? parsed * 1_000 : parsed
  }

  if (
    !Number.isFinite(tokens) ||
    tokens < AUTO_COMPACT_WINDOW_MIN_TOKENS ||
    tokens > AUTO_COMPACT_WINDOW_MAX_TOKENS
  ) {
    return undefined
  }
  return Math.round(tokens)
}

export function normalizeAutoCompactWindowSetting(
  value: unknown,
): number | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < AUTO_COMPACT_WINDOW_MIN_TOKENS ||
    value > AUTO_COMPACT_WINDOW_MAX_TOKENS
  ) {
    return undefined
  }
  return value
}
