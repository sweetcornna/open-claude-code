import { digestToken } from '../auth/credentials'
import { generateWorkerJwt } from '../auth/jwt'
import { config, getBaseUrl } from '../config'
import { log } from '../logger'
import {
  storeClaimPendingWorkItem,
  storeCreateWorkItem,
  storeGetEnvironment,
  storeGetPendingWorkItem,
  storeGetWorkItem,
  storeListSessionsByEnvironment,
  storeUpdateWorkItem,
} from '../store'
import type { WorkResponse } from '../types/api'

function encodeWorkSecret(workerToken: string): string {
  const payload = {
    version: 1,
    session_ingress_token: workerToken,
    api_base_url: getBaseUrl(),
    sources: [] as string[],
    auth: [] as string[],
    use_code_sessions: false,
  }
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

export async function createWorkItem(
  environmentId: string,
  sessionId: string,
  accountId?: string,
): Promise<string> {
  const environment = storeGetEnvironment(environmentId, accountId)
  if (!environment) throw new Error(`Environment ${environmentId} not found`)
  if (environment.status !== 'active') {
    throw new Error(
      `Environment ${environmentId} is not active (status: ${environment.status})`,
    )
  }
  const record = storeCreateWorkItem({
    accountId: environment.accountId,
    environmentId,
    sessionId,
  })
  log(
    `[RCS] Work item created: ${record.id} for env=${environmentId} session=${sessionId}`,
  )
  return record.id
}

export async function pollWork(
  environmentId: string,
  timeoutSeconds = config.pollTimeout,
  accountId?: string,
): Promise<WorkResponse | null> {
  const environment = storeGetEnvironment(environmentId, accountId)
  if (!environment) return null
  const deadline = Date.now() + timeoutSeconds * 1000

  while (Date.now() < deadline) {
    const pending = storeGetPendingWorkItem(
      environmentId,
      environment.accountId,
    )
    if (pending) {
      const workerToken = generateWorkerJwt(
        environment.accountId,
        pending.sessionId,
        config.jwtExpiresIn,
      )
      const item = storeClaimPendingWorkItem(
        environmentId,
        environment.accountId,
        digestToken(workerToken),
        pending.id,
      )
      if (!item) continue
      return {
        id: item.id,
        type: 'work',
        environment_id: environmentId,
        state: 'dispatched',
        data: { type: 'session', id: item.sessionId },
        secret: encodeWorkSecret(workerToken),
        created_at: item.createdAt.toISOString(),
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return null
}

export function ackWork(workId: string, accountId?: string): boolean {
  return storeUpdateWorkItem(workId, { state: 'acked' }, accountId)
}

export function stopWork(workId: string, accountId?: string): boolean {
  return storeUpdateWorkItem(workId, { state: 'completed' }, accountId)
}

export function heartbeatWork(
  workId: string,
  accountId?: string,
): {
  lease_extended: boolean
  state: string
  last_heartbeat: string
  ttl_seconds: number
} | null {
  if (!storeUpdateWorkItem(workId, {}, accountId)) return null
  const item = storeGetWorkItem(workId, accountId)
  const now = new Date()
  return {
    lease_extended: true,
    state: item?.state ?? 'acked',
    last_heartbeat: now.toISOString(),
    ttl_seconds: config.heartbeatInterval * 2,
  }
}

export function reconnectWorkForEnvironment(
  environmentId: string,
  accountId?: string,
) {
  const environment = storeGetEnvironment(environmentId, accountId)
  if (!environment) return Promise.resolve([])
  const activeSessions = storeListSessionsByEnvironment(
    environmentId,
    environment.accountId,
  ).filter(session => session.status === 'idle')
  return Promise.all(
    activeSessions.map(session =>
      createWorkItem(environmentId, session.id, environment.accountId),
    ),
  )
}
