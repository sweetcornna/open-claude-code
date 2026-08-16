import { generateOpaqueToken } from '../auth/credentials'
import { config } from '../config'
import {
  storeCountEnvironmentsForAccount,
  storeCountSessionsForAccount,
  storeCreateEnvironment,
  storeCreateSession,
  storeGetEnvironment,
  storeListActiveEnvironments,
  storeListActiveEnvironmentsByUsername,
  storeListSessionsByEnvironment,
  storeUpdateEnvironment,
  type EnvironmentRecord,
} from '../store'
import type {
  EnvironmentResponse,
  RegisterEnvironmentRequest,
} from '../types/api'

function toResponse(row: EnvironmentRecord): EnvironmentResponse {
  return {
    id: row.id,
    machine_name: row.machineName,
    directory: row.directory,
    branch: row.branch,
    status: row.status,
    username: row.username,
    last_poll_at: row.lastPollAt ? row.lastPollAt.getTime() / 1000 : null,
    worker_type: row.workerType,
    channel_group_id: row.bridgeId,
    capabilities: row.capabilities,
  }
}

export function registerEnvironment(
  req: RegisterEnvironmentRequest & {
    metadata?: { worker_type?: string }
    accountId?: string
    username?: string
  },
) {
  if (
    req.accountId &&
    storeCountEnvironmentsForAccount(req.accountId) >=
      config.maxEnvironmentsPerAccount
  ) {
    throw new Error('Environment quota exceeded')
  }
  const secret = generateOpaqueToken('environment')
  const workerType = req.worker_type || req.metadata?.worker_type
  const record = storeCreateEnvironment({
    accountId: req.accountId,
    secret,
    machineName: req.machine_name,
    directory: req.directory,
    branch: req.branch,
    gitRepoUrl: req.git_repo_url,
    maxSessions: req.max_sessions,
    workerType,
    bridgeId: req.bridge_id,
    username: req.username,
    capabilities: req.capabilities,
  })

  let sessionId: string | undefined
  if (workerType === 'acp') {
    const existing = storeListSessionsByEnvironment(record.id, record.accountId)
    if (existing.length > 0) {
      sessionId = existing[0]?.id
    } else if (
      req.accountId &&
      storeCountSessionsForAccount(req.accountId) >=
        config.maxSessionsPerAccount
    ) {
      throw new Error('Session quota exceeded')
    } else {
      sessionId = storeCreateSession({
        accountId: record.accountId,
        environmentId: record.id,
        title: req.machine_name || 'ACP Agent',
        source: 'acp',
      }).id
    }
  }

  return {
    environment_id: record.id,
    environment_secret: secret,
    status: record.status as 'active',
    session_id: sessionId,
  }
}

export function deregisterEnvironment(
  environmentId: string,
  accountId?: string,
): boolean {
  return storeUpdateEnvironment(
    environmentId,
    { status: 'deregistered' },
    accountId,
  )
}

export function getEnvironment(environmentId: string, accountId?: string) {
  return storeGetEnvironment(environmentId, accountId)
}

export function updatePollTime(environmentId: string, accountId?: string) {
  return storeUpdateEnvironment(
    environmentId,
    { lastPollAt: new Date() },
    accountId,
  )
}

export function listActiveEnvironments(accountId?: string) {
  return storeListActiveEnvironments(accountId)
}

export function listActiveEnvironmentsResponse(
  accountId?: string,
): EnvironmentResponse[] {
  return storeListActiveEnvironments(accountId).map(toResponse)
}

export function listActiveEnvironmentsByUsername(
  username: string,
): EnvironmentResponse[] {
  return storeListActiveEnvironmentsByUsername(username).map(toResponse)
}

export function reconnectEnvironment(
  environmentId: string,
  accountId?: string,
): boolean {
  return storeUpdateEnvironment(environmentId, { status: 'active' }, accountId)
}
