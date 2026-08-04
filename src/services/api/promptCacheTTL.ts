/**
 * Pure helpers for the 1h prompt-cache TTL decision.
 *
 * Kept in a leaf module (no imports) so the policy can be tested without
 * pulling in claude.ts's auth/GrowthBook/bootstrap graph.
 */

/**
 * Query sources that get 1h TTL when GrowthBook serves no
 * `tengu_prompt_cache_1h_config`.
 *
 * These are the sources that run many turns against one stable prefix, so
 * they are the ones that lose the most to the 5-minute default TTL: every
 * pause longer than 5 minutes (reading a diff, a meeting, a long build)
 * re-writes the whole ~20–50K-token prefix.
 *
 * Short-lived forked sources (speculation, session_memory,
 * prompt_suggestion, …) are deliberately absent: they run 1–3 turns, so a 1h
 * write would be paid for and never read back.
 */
export const PROMPT_CACHE_1H_DEFAULT_ALLOWLIST: readonly string[] = [
  'repl_main_thread*',
  'compact',
  'sdk',
  'agent:*',
]

/**
 * Resolve the effective allowlist from a GrowthBook config.
 *
 * An absent `allowlist` key means "GrowthBook has nothing to say" — the
 * common case outside Anthropic's own deployment, where the config used to
 * resolve to `[]` and made 1h TTL dead code for every user, eligible
 * subscribers included. An explicitly served `[]` still means "off for
 * everyone" so the remote kill switch keeps working.
 */
export function resolve1hCacheAllowlist(config: {
  allowlist?: string[]
}): readonly string[] {
  return config.allowlist ?? PROMPT_CACHE_1H_DEFAULT_ALLOWLIST
}

/**
 * Whether a query source matches the allowlist. A trailing '*' makes the
 * pattern a prefix match; everything else is exact.
 */
export function matches1hCacheAllowlist(
  querySource: string | undefined,
  allowlist: readonly string[],
): boolean {
  if (querySource === undefined) return false
  return allowlist.some(pattern =>
    pattern.endsWith('*')
      ? querySource.startsWith(pattern.slice(0, -1))
      : querySource === pattern,
  )
}
