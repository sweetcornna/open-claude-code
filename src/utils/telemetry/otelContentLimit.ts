/**
 * OTel content-attribute size cap — leaf module (no telemetry imports) so
 * both betaSessionTracing.ts and events.ts can consume it without forming a
 * cycle (betaSessionTracing already imports events.logOTelEvent).
 *
 * Configurable via CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH (official 2.1.214
 * parity); default 60KB (Honeycomb attribute limit is 64KB, staying safe).
 */

const DEFAULT_MAX_CONTENT_SIZE = 60 * 1024

/** Read lazily so the env var works when set after module load. */
export function getOtelContentMaxLength(): number {
  const raw = process.env.CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_MAX_CONTENT_SIZE
}

export function truncateContent(
  content: string,
  maxSize?: number,
): { content: string; truncated: boolean } {
  const limit = maxSize ?? getOtelContentMaxLength()
  if (content.length <= limit) {
    return { content, truncated: false }
  }

  return {
    content:
      content.slice(0, limit) +
      `\n\n[TRUNCATED - Content exceeds ${Math.floor(limit / 1024)}KB limit]`,
    truncated: true,
  }
}
