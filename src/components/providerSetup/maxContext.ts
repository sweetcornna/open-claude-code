/**
 * The "Max context" form field parser, shared by the provider setup wizard and
 * ConsoleOAuthFlow's remaining forms.
 *
 * Its own module because the wizard cannot import it from ConsoleOAuthFlow —
 * that file renders the wizard, so the edge would close a cycle. Duplicating
 * it was the other option, and CLAUDE.md names CLAUDE_CODE_MAX_CONTEXT_TOKENS
 * as having exactly one correction path; two parsers is how that stops being
 * true.
 */

import { parseContextWindowTokens } from 'src/utils/model/chinaLlmProviders.js'

/**
 * Accepts a plain token count ('128000') or a K/M shorthand ('128k', '1m').
 * Returns undefined for empty (leave the variable unset) and null for input
 * that cannot be read as a positive token count.
 */
export function parseMaxContextInput(raw: string): string | undefined | null {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10)
    return n > 0 ? String(n) : null
  }
  const viaSuffix = parseContextWindowTokens(trimmed)
  return viaSuffix ? String(viaSuffix) : null
}
