import { randomUUID } from 'node:crypto'
import { config, getBaseUrl } from '../config'
import {
  storeCountSessionsForAccount,
  storeCreateSession,
  storeGetSession,
  storeListSessions,
  storeListSessionsByEnvironment,
  storeListSessionsByUsername,
  storeUpdateSession,
} from '../store'
import { notifyCredentialRevocation } from '../auth/revocation'
import { issuePairToken, PAIR_TOKEN_TTL_SECONDS } from './account'
import { getEventBus, removeEventBus } from '../transport/event-bus'
import type {
  CreateSessionRequest,
  CreateCodeSessionRequest,
  SessionResponse,
  SessionSummaryResponse,
} from '../types/api'

const CODE_SESSION_PREFIX = 'cse_'
const WEB_SESSION_PREFIX = 'session_'
const CLOSED_SESSION_STATUSES = new Set(['archived', 'inactive'])

function toResponse(
  row: NonNullable<ReturnType<typeof storeGetSession>>,
): SessionResponse {
  return {
    id: row.id,
    environment_id: row.environmentId,
    title: row.title,
    status: row.status,
    source: row.source,
    permission_mode: row.permissionMode,
    worker_epoch: row.workerEpoch,
    username: row.username,
    created_at: row.createdAt.getTime() / 1000,
    updated_at: row.updatedAt.getTime() / 1000,
  }
}

function toWebSessionId(sessionId: string): string {
  if (!sessionId.startsWith(CODE_SESSION_PREFIX)) return sessionId
  return `${WEB_SESSION_PREFIX}${sessionId.slice(CODE_SESSION_PREFIX.length)}`
}

function toCompatibleCodeSessionId(sessionId: string): string | null {
  if (!sessionId.startsWith(WEB_SESSION_PREFIX)) return null
  return `${CODE_SESSION_PREFIX}${sessionId.slice(WEB_SESSION_PREFIX.length)}`
}

export function toWebSessionResponse(
  session: SessionResponse,
): SessionResponse {
  return { ...session, id: toWebSessionId(session.id) }
}

function toWebSessionSummaryResponse(
  session: SessionSummaryResponse,
): SessionSummaryResponse {
  return { ...session, id: toWebSessionId(session.id) }
}

function assertSessionQuota(accountId: string | undefined) {
  if (
    accountId &&
    storeCountSessionsForAccount(accountId) >= config.maxSessionsPerAccount
  ) {
    throw new Error('Session quota exceeded')
  }
}

export function createSession(
  req: CreateSessionRequest & { accountId?: string; username?: string },
): SessionResponse {
  assertSessionQuota(req.accountId)
  return toResponse(
    storeCreateSession({
      accountId: req.accountId,
      environmentId: req.environment_id,
      title: req.title,
      source: req.source,
      permissionMode: req.permission_mode,
      username: req.username,
    }),
  )
}

export function createCodeSession(
  req: CreateCodeSessionRequest,
  accountId?: string,
): SessionResponse {
  assertSessionQuota(accountId)
  return toResponse(
    storeCreateSession({
      accountId,
      idPrefix: CODE_SESSION_PREFIX,
      title: req.title,
      source: req.source,
      permissionMode: req.permission_mode,
    }),
  )
}

export function createSessionPairing(
  sessionId: string,
  accountId: string,
): {
  pairing_code: string
  pairing_url: string
  pairing_expires_at: number
  web_url: string
} {
  if (!storeGetSession(sessionId, accountId)) {
    throw new Error('Session not found')
  }
  const pairingCode = issuePairToken(accountId, sessionId)
  const pairingUrl = `${getBaseUrl()}/code/${toWebSessionId(sessionId)}#pair=${encodeURIComponent(pairingCode)}`
  return {
    pairing_code: pairingCode,
    pairing_url: pairingUrl,
    pairing_expires_at: Math.floor(Date.now() / 1000) + PAIR_TOKEN_TTL_SECONDS,
    web_url: pairingUrl,
  }
}

export function getSession(
  sessionId: string,
  accountId?: string,
): SessionResponse | null {
  const record = storeGetSession(sessionId, accountId)
  return record ? toResponse(record) : null
}

export function isSessionClosedStatus(
  status: string | null | undefined,
): boolean {
  return !!status && CLOSED_SESSION_STATUSES.has(status)
}

export function resolveExistingSessionId(
  sessionId: string,
  accountId?: string,
): string | null {
  if (storeGetSession(sessionId, accountId)) return sessionId
  const compatibleCodeSessionId = toCompatibleCodeSessionId(sessionId)
  if (
    compatibleCodeSessionId &&
    storeGetSession(compatibleCodeSessionId, accountId)
  ) {
    return compatibleCodeSessionId
  }
  return null
}

export function resolveOwnedWebSessionId(
  sessionId: string,
  accountId: string,
): string | null {
  return resolveExistingSessionId(sessionId, accountId)
}

export function listWebSessionsByAccount(accountId: string): SessionResponse[] {
  return storeListSessions(accountId)
    .filter(session => !isSessionClosedStatus(session.status))
    .map(toResponse)
    .map(toWebSessionResponse)
}

export function listWebSessionSummariesByAccount(
  accountId: string,
): SessionSummaryResponse[] {
  return storeListSessions(accountId)
    .filter(session => !isSessionClosedStatus(session.status))
    .map(toSummaryResponse)
    .map(toWebSessionSummaryResponse)
}

export function updateSessionTitle(
  sessionId: string,
  title: string,
  accountId?: string,
) {
  storeUpdateSession(sessionId, { title }, accountId)
}

export function updateSessionStatus(
  sessionId: string,
  status: string,
  accountId?: string,
) {
  if (!storeUpdateSession(sessionId, { status }, accountId)) return
  getEventBus(sessionId).publish({
    id: randomUUID(),
    sessionId,
    type: 'session_status',
    payload: { status },
    direction: 'inbound',
  })
}

export function touchSession(sessionId: string, accountId?: string) {
  storeUpdateSession(sessionId, {}, accountId)
}

export function archiveSession(sessionId: string, accountId?: string) {
  updateSessionStatus(sessionId, 'archived', accountId)
  removeEventBus(sessionId)
}

export function incrementEpoch(sessionId: string, accountId?: string): number {
  const record = storeGetSession(sessionId, accountId)
  if (!record) throw new Error('Session not found')
  const newEpoch = record.workerEpoch + 1
  storeUpdateSession(sessionId, { workerEpoch: newEpoch }, record.accountId)
  // Every worker JWT minted for the old epoch is now dead. Evict the sockets
  // still holding one instead of waiting for their next frame.
  notifyCredentialRevocation({
    accountId: record.accountId,
    sessionId,
    reason: 'worker_epoch_rotated',
  })
  return newEpoch
}

export function listSessions(accountId?: string) {
  return storeListSessions(accountId).map(toResponse)
}

function toSummaryResponse(row: {
  id: string
  title: string | null
  status: string
  username: string | null
  updatedAt: Date
}): SessionSummaryResponse {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    username: row.username,
    updated_at: row.updatedAt.getTime() / 1000,
  }
}

export function listSessionSummaries(
  accountId?: string,
): SessionSummaryResponse[] {
  return storeListSessions(accountId).map(toSummaryResponse)
}

export function listSessionSummariesByUsername(
  username: string,
): SessionSummaryResponse[] {
  return storeListSessionsByUsername(username).map(toSummaryResponse)
}

export function listSessionsByEnvironment(
  environmentId: string,
  accountId?: string,
) {
  return storeListSessionsByEnvironment(environmentId, accountId).map(
    toResponse,
  )
}
