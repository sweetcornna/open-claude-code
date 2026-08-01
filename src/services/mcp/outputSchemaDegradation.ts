/**
 * Client-side `outputSchema` enforcement, and how occ survives it.
 *
 * Both SDK generations validate a tool's ADVERTISED `outputSchema` against the
 * result the server actually returned, and THROW when the two disagree. The
 * verdict is about the server's self-description, not about whether the tool
 * did its job: a server that declares `outputSchema` and answers with plain
 * text has a cosmetic bug, and failing the whole tool call over it would turn
 * that into a broken turn. `callMCPTool` classifies the throw with
 * {@link outputSchemaViolation} and degrades to a text result instead.
 *
 * Enforcement is ARMED by the response cache: the validator is compiled from
 * the cached `tools/list` aggregate, which only `listTools()` writes — a raw
 * `request({ method: 'tools/list' })` leaves it inert. occ's discovery uses
 * `listTools()`, so this classifier is a live path rather than a safety net.
 *
 * The SDK reports all four cases as `ProtocolError`s distinguished only by
 * message text, so matching that text is the only classification available.
 * A miss is not silent: an unclassified violation falls through to the generic
 * error handling and fails the tool call the way it did before this was wired,
 * which is why the tests drive real violations through the real validator.
 */

import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/client'

/**
 * The kind of `outputSchema` disagreement an error represents, or `undefined`
 * when the error is not one.
 *
 * - `missing_structured_content` — the tool declares a schema and returned
 *   none. By far the common case in the wild.
 * - `schema_mismatch` — structured content was returned but does not validate.
 * - `validator_failed` — the validator itself threw on the content.
 * - `invalid_output_schema` — the declared schema does not compile at all, so
 *   the call is rejected before it is even sent.
 */
export function outputSchemaViolation(error: unknown): string | undefined {
  if (!(error instanceof ProtocolError)) {
    return undefined
  }
  if (
    error.code === ProtocolErrorCode.InvalidRequest &&
    error.message.includes(
      'has an output schema but did not return structured content',
    )
  ) {
    return 'missing_structured_content'
  }
  if (error.code !== ProtocolErrorCode.InvalidParams) {
    return undefined
  }
  if (error.message.startsWith('Structured content does not match')) {
    return 'schema_mismatch'
  }
  if (error.message.startsWith('Failed to validate structured content')) {
    return 'validator_failed'
  }
  if (/^Tool .* has an invalid outputSchema: /.test(error.message)) {
    return 'invalid_output_schema'
  }
  return undefined
}
