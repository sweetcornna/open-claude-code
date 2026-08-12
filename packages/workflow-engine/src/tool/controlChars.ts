/**
 * Control-character screening for workflow input that reaches the approval dialog.
 *
 * The threat is not "weird bytes" — it is that the approval dialog renders the script
 * (and its args) as terminal text. A carriage return rewinds the cursor to column 0, an
 * ESC starts an ANSI sequence that can clear the line, move the cursor, or paint the rest
 * of the payload in the background color. All of them let a script show the user one thing
 * and execute another. So the rule is about what the *dialog* can faithfully display, not
 * about what JavaScript can parse.
 *
 * The accepted set is deliberately narrow and matches upstream Claude Code byte for byte:
 * TAB (9) and LF (10) are the only C0 codes a script legitimately needs, everything else
 * below 0x20 plus DEL and the C1 block (0x7F-0x9F) is rejected. CR (13) is rejected too —
 * that is intentional and is the single most load-bearing entry in the list, because CR is
 * exactly the character that overwrites an already-printed line. A CRLF script file will
 * therefore be refused; normalize line endings rather than widening this predicate.
 *
 * Everything above U+009F is allowed through unchanged, so multi-byte UTF-8 (CJK, emoji,
 * combining marks) is never touched — this operates on UTF-16 code units and only ever
 * inspects the low 160.
 *
 * Zero dependencies: this module is imported by the schema, which is a module-level
 * singleton evaluated at package load.
 */

/** True when this UTF-16 code unit would not render faithfully in the approval dialog. */
function isHiddenControlCharCode(code: number): boolean {
  // TAB and LF are the only whitespace controls a workflow script needs, and both
  // advance the cursor monotonically — they cannot repaint what was already shown.
  if (code === 9 || code === 10) return false
  return code < 32 || (code >= 127 && code <= 159)
}

/**
 * True when `text` is safe to display verbatim in the approval dialog.
 *
 * Named for the passing case because it is used directly as a zod `.refine()` predicate,
 * where the callback must return true for valid input.
 */
export function hasNoHiddenControlCharacters(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (isHiddenControlCharCode(text.charCodeAt(i))) return false
  }
  return true
}

/**
 * Recursive variant for `args`, which is an arbitrary JSON value the model supplies and
 * the dialog stringifies. Object keys are checked as well as values: a key is just as
 * visible in the rendered arguments blob, and just as capable of carrying an escape.
 *
 * Cycles are impossible for values that arrived as JSON over the wire, but the depth
 * guard keeps a hostile or accidentally self-referential in-process caller from blowing
 * the stack inside schema validation.
 */
export function argsHaveNoHiddenControlCharacters(
  value: unknown,
  depth = 0,
): boolean {
  if (depth > MAX_ARGS_SCAN_DEPTH) return true
  if (typeof value === 'string') return hasNoHiddenControlCharacters(value)
  if (Array.isArray(value)) {
    return value.every(item =>
      argsHaveNoHiddenControlCharacters(item, depth + 1),
    )
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).every(
      ([key, item]) =>
        hasNoHiddenControlCharacters(key) &&
        argsHaveNoHiddenControlCharacters(item, depth + 1),
    )
  }
  // Numbers, booleans, null, undefined: nothing to hide.
  return true
}

/**
 * Depth ceiling for the args walk. Args deeper than this are accepted unscanned — the
 * dialog truncates long structures anyway, so the marginal hiding capacity down there is
 * nil, and refusing to descend is cheaper than refusing the call.
 */
const MAX_ARGS_SCAN_DEPTH = 64

/** Upstream wording, kept verbatim: it is what the model sees when the call is refused. */
export const WORKFLOW_SCRIPT_CONTROL_CHAR_MESSAGE =
  'script contains control characters that would be hidden in the approval dialog'

/** Same shape as the script message, for the field the model can also stuff text into. */
export const WORKFLOW_ARGS_CONTROL_CHAR_MESSAGE =
  'args contain control characters that would be hidden in the approval dialog'

/**
 * Message for a script that was loaded from disk (via `name` or `scriptPath`) rather than
 * sent inline. Schema refinement cannot reach those, so the runtime check names the source
 * — otherwise the user sees a complaint about a "script" they never typed.
 */
export function resolvedScriptControlCharMessage(source: string): string {
  return `workflow script from ${source} contains control characters that would be hidden in the approval dialog (only tab and newline are allowed; convert CRLF line endings to LF)`
}
