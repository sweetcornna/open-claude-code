/**
 * Which timeout knob (if any) is worth suggesting for a given API error.
 *
 * The retry banner used to append "API_TIMEOUT_MS=…ms, try increasing it" to
 * EVERY API error whenever that variable happened to be set. The common case
 * it fires on is `Error: terminated` — undici tearing down the socket — where
 * raising the timeout does nothing except make you wait longer before seeing
 * the same failure. It sent people looking at the wrong setting.
 *
 * Timeouts in this client come from three different places and only two of
 * them have a knob:
 *
 *   request deadline   the SDK's `timeout` option, from API_TIMEOUT_MS
 *                      (default 600s). Aborts the whole request.
 *   stream idle        claude.ts's watchdog, from CLAUDE_STREAM_IDLE_TIMEOUT_MS
 *                      (default 90s). Fires when no chunk arrives for that
 *                      long — in practice this is what catches a stalled
 *                      stream, well before the request deadline.
 *   undici body/headers  the transport's own limits. Nothing in this codebase
 *                      configures them, so pointing at API_TIMEOUT_MS would be
 *                      a wrong answer; say nothing instead.
 *
 * Pure string classification with no imports, so it is safe to call from
 * render and adds no edge to the module graph.
 */

/** Env var that plausibly governs the error, or null when none does. */
export type TimeoutHintEnvVar =
  | 'API_TIMEOUT_MS'
  | 'CLAUDE_STREAM_IDLE_TIMEOUT_MS'

/** claude.ts's own idle watchdog — governed by its own variable. */
const IDLE_WATCHDOG_PATTERN =
  /stream idle timeout|without receiving any events/i

/**
 * undici's bodyTimeout / headersTimeout. They contain the word "timeout" but
 * are not reachable from any setting here, so they must be matched BEFORE the
 * generic pattern below and answered with "no hint".
 */
const TRANSPORT_TIMEOUT_PATTERN = /(body|headers) timeout error/i

/** Deadline-style failures the SDK's `timeout` option actually governs. */
const REQUEST_TIMEOUT_PATTERN =
  /timed ?out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ERR_SOCKET_CONNECTION_TIMEOUT|ECONNABORTED/i

export function getTimeoutHintEnvVar(
  errorText: string,
): TimeoutHintEnvVar | null {
  if (IDLE_WATCHDOG_PATTERN.test(errorText)) {
    return 'CLAUDE_STREAM_IDLE_TIMEOUT_MS'
  }
  if (TRANSPORT_TIMEOUT_PATTERN.test(errorText)) {
    return null
  }
  if (REQUEST_TIMEOUT_PATTERN.test(errorText)) {
    return 'API_TIMEOUT_MS'
  }
  return null
}
