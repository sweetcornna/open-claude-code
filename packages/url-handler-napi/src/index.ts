const MAX_URL_LENGTH = 2048

/**
 * Check for a pending URL event from environment variables or CLI arguments.
 *
 * This is a synchronous snapshot check, not an event listener. The optional
 * timeout parameter is retained for API compatibility but has no practical
 * effect since process.env and process.argv do not change at runtime.
 * Callers that need to wait for an OS-level deep link activation should use
 * an IPC channel or platform-specific event listener instead.
 */
export async function waitForUrlEvent(
  timeoutMs?: number,
): Promise<string | null> {
  return findUrlEvent()
}

/**
 * Checks the occ event source first, then legacy compatibility variables and
 * CLI arguments. Legacy sources are read-only and are never registered by occ.
 *
 * Priority order:
 * 1. OCC_URL_EVENT — set by the occ OS URL scheme handler
 * 2. CLAUDE_CODE_URL_EVENT — legacy compatibility
 * 3. CLAUDE_CODE_DEEP_LINK_URL — legacy desktop launcher
 * 4. CLAUDE_CODE_URL — legacy manual override
 * 5. CLI arguments
 */
function findUrlEvent(): string | null {
  for (const key of [
    'OCC_URL_EVENT',
    'CLAUDE_CODE_URL_EVENT',
    'CLAUDE_CODE_DEEP_LINK_URL',
    'CLAUDE_CODE_URL',
  ]) {
    const value = process.env[key]
    if (isClaudeUrl(value)) {
      return value
    }
  }

  const arg = process.argv.find(isClaudeUrl)
  return arg ?? null
}

function isClaudeUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_URL_LENGTH &&
    (value.startsWith('occ-cli://') ||
      value.startsWith('claude-cli://') ||
      value.startsWith('claude://'))
  )
}
