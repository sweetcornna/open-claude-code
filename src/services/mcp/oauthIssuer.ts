/**
 * RFC 9207 (OAuth 2.0 Authorization Server Issuer Identification) validation
 * for the authorization-code callback.
 *
 * MCP revision 2026-07-28 promotes this from SHOULD to **MUST**: an
 * authorization response that carries `iss` MUST be rejected unless it matches
 * the issuer of the authorization server the flow was started against. Without
 * it a *mix-up* attack works — an attacker who controls one authorization
 * server the client also talks to can get the client to redeem a code at the
 * wrong token endpoint, handing that server a code minted for someone else.
 *
 * The decision table (RFC 9207 §2.4, restated by the MCP spec) is implemented
 * by the SDK's `validateAuthorizationResponseIssuer`; this module only supplies
 * the baseline and normalizes the callback's query shape. Reusing the SDK
 * function keeps occ's semantics byte-identical to the ones the v2 transports
 * apply on their own `finishAuth` path:
 *
 * | advertised | `iss`   | action                       |
 * | ---------- | ------- | ---------------------------- |
 * | true       | present | compare, reject on mismatch  |
 * | true       | absent  | reject                       |
 * | false      | present | compare, reject on mismatch  |
 * | false      | absent  | proceed                      |
 *
 * Comparison is simple string equality per RFC 3986 §6.2.1 — no case folding,
 * no default-port elision, no trailing-slash normalization.
 *
 * The module is deliberately free of storage/network/logging imports so the
 * table above can be unit-tested without dragging in `auth.ts`'s graph. Same
 * split as `oauthPort.ts`.
 */

import {
  IssuerMismatchError,
  validateAuthorizationResponseIssuer,
} from '@modelcontextprotocol/client'

/**
 * What an authorization response's `iss` is checked against.
 *
 * `expectedIssuer` comes from the authorization server's metadata document —
 * the only authentic source. When it is `undefined` no metadata was obtained,
 * the check has no baseline, and per the SDK's own contract it degenerates to
 * a no-op rather than failing closed (failing closed would break every server
 * whose metadata fetch we could not complete).
 */
export type IssuerBaseline = {
  /** `issuer` from the authorization server's validated metadata document. */
  expectedIssuer: string | undefined
  /** Whether the metadata advertised `authorization_response_iss_parameter_supported: true`. */
  issParameterSupported: boolean
}

/** Baseline for "we hold no authorization server metadata". */
export const NO_ISSUER_BASELINE: IssuerBaseline = {
  expectedIssuer: undefined,
  issParameterSupported: false,
}

/**
 * The query half of an authorization callback, in either shape occ parses one:
 * `URLSearchParams` (pasted callback URL) or Node's `ParsedUrlQuery`
 * (`url.parse(req.url, true)` on the loopback callback server).
 */
export type AuthorizationCallbackQuery =
  | URLSearchParams
  | Record<string, string | string[] | undefined>

/**
 * Derives the RFC 9207 baseline from authorization server metadata.
 *
 * Typed as `unknown` on purpose: `authorization_response_iss_parameter_supported`
 * is absent from the v1 SDK's `AuthorizationServerMetadata` type, but its schema
 * is a `looseObject` so the field survives parsing at runtime. Only a literal
 * `true` counts as advertised — absent, `false`, or a non-boolean all mean "not
 * advertised", which is the safe reading (an absent `iss` then proceeds).
 */
export function issuerBaselineFromMetadata(metadata: unknown): IssuerBaseline {
  if (metadata === null || typeof metadata !== 'object') {
    return NO_ISSUER_BASELINE
  }
  const record = metadata as Record<string, unknown>
  const issuer = record.issuer
  return {
    expectedIssuer:
      typeof issuer === 'string' && issuer.length > 0 ? issuer : undefined,
    issParameterSupported:
      record.authorization_response_iss_parameter_supported === true,
  }
}

function readIssValues(query: AuthorizationCallbackQuery): string[] {
  if (query instanceof URLSearchParams) {
    return query.getAll('iss')
  }
  const raw = query.iss
  if (raw === undefined) {
    return []
  }
  return Array.isArray(raw) ? raw : [raw]
}

/**
 * Enforces RFC 9207 §2.4 on an authorization callback.
 *
 * Call this **before** reading `code`, `state`, or `error*` from the same
 * callback: in a mix-up every one of those is attacker-supplied, so none may
 * reach the token exchange (or the user's screen) until the response is known
 * to have come from the authorization server the flow was started against.
 *
 * A repeated `iss` parameter is rejected outright. Query parsers disagree on
 * which duplicate wins, so accepting one would let an attacker append a second
 * `iss` that our check reads and the rest of the pipeline does not.
 *
 * @throws {IssuerMismatchError} with `kind: 'authorization_response'`. Its
 * `received` value is attacker-controllable — log it, never render it.
 */
export function assertAuthorizationResponseIssuer(
  query: AuthorizationCallbackQuery,
  baseline: IssuerBaseline,
): void {
  const { expectedIssuer, issParameterSupported } = baseline
  if (expectedIssuer === undefined) {
    return
  }

  const values = readIssValues(query)
  if (values.length > 1) {
    throw new IssuerMismatchError(
      'authorization_response',
      expectedIssuer,
      values.join(', '),
    )
  }

  validateAuthorizationResponseIssuer({
    iss: values[0],
    expectedIssuer,
    issParameterSupported,
  })
}

/** True when `error` is an RFC 9207 authorization-response issuer rejection. */
export function isAuthorizationResponseIssuerMismatch(
  error: unknown,
): error is IssuerMismatchError {
  return (
    IssuerMismatchError.isInstance(error) &&
    error.kind === 'authorization_response'
  )
}
