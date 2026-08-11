/**
 * One-shot gate for the Haiku session-title side query.
 *
 * WHY THIS IS NOT INLINE IN REPL.tsx
 *
 * The gate used to be a bare boolean ref whose `.then` handler re-armed it
 * whenever the side query came back empty:
 *
 *     if (title) setHaikuTitle(title)
 *     else haikuTitleAttemptedRef.current = false   // <- re-arm
 *
 * `generateSessionTitle` swallows every error and returns `null`, so "empty"
 * also means "the request failed": a 401, a haiku-tier model the endpoint
 * does not know, an endpoint that rejects `response_format: json_schema`.
 * On any such provider the re-arm turned a once-per-session call into a
 * once-per-prompt call, so a single user message issued two API requests —
 * the title side query plus the main loop. Measured on a failing session
 * (one prompt, two `[OpenAI] Calling model=…` lines 16ms apart, the first
 * with `tools=0`): duplicated spend on metered providers and a duplicated
 * error in the log for every turn.
 *
 * REPL.tsx is 5400 lines and cannot be rendered in a unit test, so the
 * policy lives here where "one attempt per session even when every attempt
 * fails" can be pinned directly.
 */
import {
  BASH_INPUT_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'

/**
 * Synthetic breadcrumbs, not the user's topic: local-command output,
 * prompt-skill expansions (`/commit` -> `<command-message>`), local-command
 * headers (`/help` -> `<command-name>`) and bash mode (`!cmd`). Titling from
 * one of these produces a title about the plumbing, so wait for real prose.
 */
const BREADCRUMB_PREFIXES = [
  `<${LOCAL_COMMAND_STDOUT_TAG}>`,
  `<${COMMAND_MESSAGE_TAG}>`,
  `<${COMMAND_NAME_TAG}>`,
  `<${BASH_INPUT_TAG}>`,
]

export type SessionTitlePlanInput = {
  /** `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` — no terminal title at all. */
  disabled: boolean
  /** Title fixed by `/rename` or restored on resume; wins over generation. */
  existingTitle: string | undefined
  /** Main-thread agent name; also wins over generation. */
  agentTitle: string | undefined
  /** Whether the one-shot has already been spent this session. */
  attempted: boolean
  /** Text of this turn's first non-meta user message, if any. */
  text: string | null
}

/**
 * The prompt text to generate a session title from, or `null` to make no
 * API call this turn.
 */
export function planSessionTitleAttempt(
  input: SessionTitlePlanInput,
): string | null {
  if (input.disabled) return null
  if (input.existingTitle || input.agentTitle) return null
  if (input.attempted) return null
  const text = input.text
  if (!text) return null
  if (BREADCRUMB_PREFIXES.some(prefix => text.startsWith(prefix))) return null
  return text
}

/**
 * The gate value after an attempt settles.
 *
 * Deliberately independent of `result`: a spent gate stays spent whether the
 * side query produced a title, returned `null`, or rejected. Re-arming on
 * failure is what made a broken provider pay for an extra API request on
 * every single prompt (see the file header). A session that fails to title
 * itself simply keeps the "Claude Code" default until `/clear` or `/rename`,
 * both of which reset the ref explicitly.
 */
export function sessionTitleGateAfterAttempt(
  attempted: boolean,
  _result: string | null,
): boolean {
  return attempted
}
