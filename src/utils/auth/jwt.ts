/**
 * Signature-free JWT decoding.
 *
 * Only used to read a token's own expiry so a client can refresh before the
 * server rejects it — never for authorization decisions, which is why not
 * verifying the signature is fine here.
 */
import { jsonParse } from '../telemetry/slowOperations.js'

/**
 * Decode a JWT's payload segment without verifying the signature.
 * Strips the `sk-ant-si-` session-ingress prefix if present.
 * Returns the parsed JSON payload as `unknown`, or `null` if the
 * token is malformed or the payload is not valid JSON.
 */
export function decodeJwtPayload(token: string): unknown | null {
  const jwt = token.startsWith('sk-ant-si-')
    ? token.slice('sk-ant-si-'.length)
    : token
  const parts = jwt.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    return jsonParse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Decode the `exp` (expiry) claim from a JWT without verifying the signature.
 * @returns The `exp` value in Unix seconds, or `null` if unparseable
 */
export function decodeJwtExpiry(token: string): number | null {
  const payload = decodeJwtPayload(token)
  if (
    payload !== null &&
    typeof payload === 'object' &&
    'exp' in payload &&
    typeof payload.exp === 'number'
  ) {
    return payload.exp
  }
  return null
}
