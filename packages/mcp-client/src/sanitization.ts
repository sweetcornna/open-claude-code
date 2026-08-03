/**
 * Unicode sanitization for MCP data.
 *
 * SECURITY: this is the sanitizer that `src/services/mcp/client.ts` runs over
 * every tool description, input schema and prompt returned by an MCP server —
 * i.e. attacker-controlled text that goes straight into the model's context.
 * It must stay behaviourally identical to the host implementation in
 * `src/utils/text/sanitization.ts`; `__tests__/sanitizationParity.test.ts`
 * pins the two together. The copy exists only because this package is a leaf
 * and may not import from `src/` (see CLAUDE.md, Host facade 模式).
 *
 * The threat is hidden-character prompt injection (HackerOne #3086545 against
 * Claude Desktop's MCP implementation): Unicode Tag characters, bidi overrides,
 * zero-width spaces and private-use codepoints are invisible to the user but
 * are still read by the model. An earlier version of this file stripped only
 * C0 controls and U+FFFD, so all of those classes flowed through untouched.
 *
 * Reference: https://embracethered.com/blog/posts/2024/hiding-and-finding-text-with-unicode-tags/
 */

// Safety limit — stripping can expose new sequences that NFKC then recomposes,
// so we iterate to a fixed point. Real input converges in 1-2 rounds.
const MAX_ITERATIONS = 10

/**
 * Sanitize a single string: NFKC-normalize and strip the Unicode classes used
 * to smuggle invisible instructions, plus C0 control characters (\t, \n and \r
 * are preserved — MCP descriptions are legitimately multi-line).
 */
export function sanitizeUnicodeString(value: string): string {
  let current = value
  let previous = ''
  let iterations = 0

  while (current !== previous && iterations < MAX_ITERATIONS) {
    previous = current

    // Compatibility normalization first, so composed forms can't hide a
    // dangerous codepoint from the strips below.
    current = current.normalize('NFKC')

    // Primary defence: format (Cf), private-use (Co) and unassigned (Cn)
    // categories. Unicode Tag characters (U+E0000-U+E007F) are Cf.
    current = current.replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, '')

    // Fallback ranges for engines with incomplete Unicode property support,
    // and C0 controls, which no property class above covers.
    current = current
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control character sanitization
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // C0 controls, keeping \t \n \r
      .replace(/\uFFFD/g, '') // replacement character
      .replace(/[\u200B-\u200F]/g, '') // zero-width spaces, LTR/RTL marks
      .replace(/[\u202A-\u202E]/g, '') // directional formatting
      .replace(/[\u2066-\u2069]/g, '') // directional isolates
      .replace(/\uFEFF/g, '') // byte order mark
      .replace(/[\uE000-\uF8FF]/g, '') // BMP private use area

    iterations++
  }

  // Deliberately does NOT throw on non-convergence, unlike the host copy: this
  // runs inside MCP tool discovery, where an exception would tear down the
  // whole server connection. After MAX_ITERATIONS every dangerous class has
  // been stripped repeatedly, so returning the value is the safe outcome.
  return current
}

/**
 * Recursively sanitizes Unicode characters in MCP server responses.
 *
 * Object keys are sanitized as well as values. On a post-sanitization key
 * collision the first occurrence wins: a server that sends both `description`
 * and `des<U+200B>cription` must not be able to override the legitimate field
 * with the invisible-character twin.
 */
export function recursivelySanitizeUnicode<T>(data: T): T {
  if (typeof data === 'string') {
    return sanitizeUnicodeString(data) as unknown as T
  }

  if (Array.isArray(data)) {
    return data.map(item => recursivelySanitizeUnicode(item)) as unknown as T
  }

  if (data !== null && typeof data === 'object') {
    const result = {} as Record<string, unknown>
    for (const [key, value] of Object.entries(
      data as Record<string, unknown>,
    )) {
      const sanitizedKey = sanitizeUnicodeString(key)
      if (Object.hasOwn(result, sanitizedKey)) continue
      result[sanitizedKey] = recursivelySanitizeUnicode(value)
    }
    return result as T
  }

  return data
}
