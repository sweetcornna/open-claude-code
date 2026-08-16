import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { config } from '../config'
import { storeEnsureLegacyAccount, storeGetSession } from '../store'

export interface WorkerJwtPayload {
  session_id: string
  account_id: string
  role: 'worker'
  worker_epoch: number
  jti: string
  iat: number
  exp: number
}

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url')
}

function sign(input: string): Buffer {
  return createHmac('sha256', config.workerJwtSecret).update(input).digest()
}

export function generateWorkerJwt(
  accountId: string,
  sessionId: string,
  expiresInSeconds: number,
): string
export function generateWorkerJwt(
  sessionId: string,
  expiresInSeconds: number,
): string
export function generateWorkerJwt(
  accountOrSessionId: string,
  sessionOrExpires: string | number,
  maybeExpires?: number,
): string {
  const compatibilityCall = typeof sessionOrExpires === 'number'
  const sessionId = compatibilityCall ? accountOrSessionId : sessionOrExpires
  const session = storeGetSession(sessionId)
  const accountId = compatibilityCall
    ? (session?.accountId ?? storeEnsureLegacyAccount().id)
    : accountOrSessionId
  const expiresInSeconds = compatibilityCall
    ? sessionOrExpires
    : (maybeExpires as number)
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload: WorkerJwtPayload = {
    session_id: sessionId,
    account_id: accountId,
    role: 'worker',
    worker_epoch: session?.workerEpoch ?? 0,
    jti: randomBytes(32).toString('base64url'),
    iat: now,
    exp: now + expiresInSeconds,
  }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`
  return `${signingInput}.${base64url(sign(signingInput))}`
}

/**
 * Verify signature, header and claim shape but ignore `exp`. Only for telling
 * "this credential expired" apart from "this credential was never valid" when
 * closing a live connection — the caller must still reject the token.
 */
function verifyWorkerJwtIgnoringExpiry(token: string): WorkerJwtPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerPart, payloadPart, signaturePart] = parts
  if (!headerPart || !payloadPart || !signaturePart) return null

  let actualSignature: Buffer
  try {
    actualSignature = Buffer.from(signaturePart, 'base64url')
  } catch {
    return null
  }
  const expectedSignature = sign(`${headerPart}.${payloadPart}`)
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return null
  }

  try {
    const header: unknown = JSON.parse(
      Buffer.from(headerPart, 'base64url').toString('utf8'),
    )
    if (
      !header ||
      typeof header !== 'object' ||
      (header as Record<string, unknown>).alg !== 'HS256' ||
      (header as Record<string, unknown>).typ !== 'JWT'
    ) {
      return null
    }
    const payload: unknown = JSON.parse(
      Buffer.from(payloadPart, 'base64url').toString('utf8'),
    )
    if (!payload || typeof payload !== 'object') return null
    const value = payload as Record<string, unknown>
    const now = Math.floor(Date.now() / 1000)
    if (
      value.role !== 'worker' ||
      typeof value.account_id !== 'string' ||
      typeof value.session_id !== 'string' ||
      typeof value.worker_epoch !== 'number' ||
      typeof value.jti !== 'string' ||
      typeof value.iat !== 'number' ||
      typeof value.exp !== 'number' ||
      value.iat > now + 60
    ) {
      return null
    }
    return value as unknown as WorkerJwtPayload
  } catch {
    return null
  }
}

export function verifyWorkerJwt(token: string): WorkerJwtPayload | null {
  const payload = verifyWorkerJwtIgnoringExpiry(token)
  if (!payload) return null
  return payload.exp <= Math.floor(Date.now() / 1000) ? null : payload
}

/** True when the token is genuinely ours and only failed the expiry check. */
export function isExpiredWorkerJwt(token: string): boolean {
  const payload = verifyWorkerJwtIgnoringExpiry(token)
  return !!payload && payload.exp <= Math.floor(Date.now() / 1000)
}
