/**
 * Single source of truth for "how is the deferred-tool pool announced to the
 * model?".
 *
 *   true  → persisted `deferred_tools_delta` attachments (announce the change
 *           once, then let it sit in history and be cached)
 *   false → the pre-2.41 ephemeral copy that claude.ts appended to the tail of
 *           every Anthropic request (and openai/index.ts prepended to the head
 *           of every OpenAI request)
 *
 * Why default-on: the ephemeral message was regenerated per request and never
 * written back to history, while `addCacheBreakpoints` puts the one and only
 * message-level `cache_control` marker on `messages.length - 1` — i.e. exactly
 * on that message. Every turn therefore paid a cache *write* (1.25x) on a
 * prefix whose last block could never appear again, and re-billed the full
 * deferred-tool list (one line per tool, hundreds of lines on a fat MCP setup)
 * as uncached input. `promptCacheBreakDetection` cannot see this — it hashes
 * tools/system/cacheControl, never the message bodies.
 *
 * Why this file exists at all: SearchExtraToolsTool's own description has to
 * tell the model *where* the names show up, so `prompt.ts` needs the same
 * predicate that `src/utils/tools/searchExtraTools.ts` uses — and that module
 * already imports from `prompt.ts`, so importing back would close a cycle.
 * The two used to carry hand-copied duplicates of the gate with nothing
 * pinning them together; they now both call this.
 *
 * Deliberately zero-import: both call sites are hot, and `envUtils.ts` (whose
 * `isEnvDefinedFalsy` semantics are mirrored below) is one of the
 * process-globally mocked modules.
 */

/** Escape hatch: set to 0/false/no/off to restore the ephemeral announcement. */
export const DEFERRED_TOOLS_DELTA_ENV_VAR = 'CLAUDE_CODE_DEFERRED_TOOLS_DELTA'

const FALSY_VALUES = new Set(['0', 'false', 'no', 'off'])

export function isDeferredToolsDeltaEnabled(): boolean {
  const raw = process.env[DEFERRED_TOOLS_DELTA_ENV_VAR]
  if (raw === undefined || raw === '') return true
  return !FALSY_VALUES.has(raw.toLowerCase().trim())
}

/**
 * Whether this request still needs the ephemeral `<available-deferred-tools>`
 * copy stapled on.
 *
 * Both wire paths ask this — Anthropic appends to the tail, OpenAI prepends to
 * the head — so the flip has to be one decision, not two.
 */
export function shouldAppendEphemeralDeferredToolList(
  useSearchExtraTools: boolean,
): boolean {
  return useSearchExtraTools && !isDeferredToolsDeltaEnabled()
}
