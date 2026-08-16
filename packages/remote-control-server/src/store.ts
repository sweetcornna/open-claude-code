import { randomUUID } from 'node:crypto'
import { getDatabase } from './db/database'
import { digestToken } from './auth/credentials'
import { notifyCredentialRevocation } from './auth/revocation'

const MAX_EVENTS_PER_SESSION = 5000
const LEGACY_ACCOUNT_ID = 'acct_legacy'

export interface AccountRecord {
  id: string
  username: string
  passwordHash: string
  disabledAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type AuthTokenKind = 'access' | 'refresh' | 'browser' | 'pair'

export interface AuthTokenRecord {
  digest: string
  accountId: string
  kind: AuthTokenKind
  sessionId: string | null
  expiresAt: Date
  createdAt: Date
  revokedAt: Date | null
  replacedByDigest: string | null
}

export interface EnvironmentRecord {
  id: string
  accountId: string
  secret: string
  credentialDigest: string
  machineName: string | null
  directory: string | null
  branch: string | null
  gitRepoUrl: string | null
  maxSessions: number
  workerType: string
  bridgeId: string | null
  capabilities: Record<string, unknown> | null
  status: string
  username: string | null
  lastPollAt: Date | null
  createdAt: Date
  updatedAt: Date
}

interface SessionRecord {
  id: string
  accountId: string
  environmentId: string | null
  title: string | null
  status: string
  source: string
  permissionMode: string | null
  workerEpoch: number
  username: string | null
  createdAt: Date
  updatedAt: Date
}

interface WorkItemRecord {
  id: string
  accountId: string
  environmentId: string
  sessionId: string
  state: string
  secret: string
  credentialDigest: string | null
  createdAt: Date
  updatedAt: Date
}

interface SessionWorkerRecord {
  sessionId: string
  accountId: string
  workerStatus: string | null
  externalMetadata: Record<string, unknown> | null
  requiresActionDetails: Record<string, unknown> | null
  lastHeartbeatAt: Date | null
  createdAt: Date
  updatedAt: Date
}

interface PersistedEventRecord {
  id: string
  sessionId: string
  accountId: string
  type: string
  payload: unknown
  direction: 'inbound' | 'outbound'
  seqNum: number
  createdAt: number
}

interface AccountRow {
  id: string
  username: string
  password_hash: string
  disabled_at: number | null
  created_at: number
  updated_at: number
}

interface AuthTokenRow {
  digest: string
  account_id: string
  kind: AuthTokenKind
  session_id: string | null
  expires_at: number
  created_at: number
  revoked_at: number | null
  replaced_by_digest: string | null
}

interface EnvironmentRow {
  id: string
  account_id: string
  credential_digest: string
  machine_name: string | null
  directory: string | null
  branch: string | null
  git_repo_url: string | null
  max_sessions: number
  worker_type: string
  bridge_id: string | null
  capabilities_json: string | null
  status: string
  username: string | null
  last_poll_at: number | null
  created_at: number
  updated_at: number
}

interface SessionRow {
  id: string
  account_id: string
  environment_id: string | null
  title: string | null
  status: string
  source: string
  permission_mode: string | null
  worker_epoch: number
  username: string | null
  created_at: number
  updated_at: number
}

interface WorkItemRow {
  id: string
  account_id: string
  environment_id: string
  session_id: string
  state: string
  credential_digest: string | null
  created_at: number
  updated_at: number
}

interface SessionWorkerRow {
  session_id: string
  account_id: string
  worker_status: string | null
  external_metadata_json: string | null
  requires_action_details_json: string | null
  last_heartbeat_at: number | null
  created_at: number
  updated_at: number
}

interface EventRow {
  id: string
  session_id: string
  account_id: string
  type: string
  payload_json: string
  direction: 'inbound' | 'outbound'
  seq_num: number
  created_at: number
}

function id(prefix: string): string {
  return `${prefix}${randomUUID().replaceAll('-', '')}`
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function accountFromRow(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    disabledAt: row.disabled_at === null ? null : new Date(row.disabled_at),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

function tokenFromRow(row: AuthTokenRow): AuthTokenRecord {
  return {
    digest: row.digest,
    accountId: row.account_id,
    kind: row.kind,
    sessionId: row.session_id,
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
    replacedByDigest: row.replaced_by_digest,
  }
}

function environmentFromRow(
  row: EnvironmentRow,
  transientSecret = '',
): EnvironmentRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    secret: transientSecret,
    credentialDigest: row.credential_digest,
    machineName: row.machine_name,
    directory: row.directory,
    branch: row.branch,
    gitRepoUrl: row.git_repo_url,
    maxSessions: row.max_sessions,
    workerType: row.worker_type,
    bridgeId: row.bridge_id,
    capabilities: parseJsonObject(row.capabilities_json),
    status: row.status,
    username: row.username,
    lastPollAt: row.last_poll_at === null ? null : new Date(row.last_poll_at),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

function sessionFromRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    environmentId: row.environment_id,
    title: row.title,
    status: row.status,
    source: row.source,
    permissionMode: row.permission_mode,
    workerEpoch: row.worker_epoch,
    username: row.username,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

function workItemFromRow(row: WorkItemRow): WorkItemRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    environmentId: row.environment_id,
    sessionId: row.session_id,
    state: row.state,
    secret: '',
    credentialDigest: row.credential_digest,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

function workerFromRow(row: SessionWorkerRow): SessionWorkerRecord {
  return {
    sessionId: row.session_id,
    accountId: row.account_id,
    workerStatus: row.worker_status,
    externalMetadata: parseJsonObject(row.external_metadata_json),
    requiresActionDetails: parseJsonObject(row.requires_action_details_json),
    lastHeartbeatAt:
      row.last_heartbeat_at === null ? null : new Date(row.last_heartbeat_at),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

function eventFromRow(row: EventRow): PersistedEventRecord {
  let payload: unknown = null
  try {
    payload = JSON.parse(row.payload_json)
  } catch {
    payload = null
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    accountId: row.account_id,
    type: row.type,
    payload,
    direction: row.direction,
    seqNum: row.seq_num,
    createdAt: row.created_at,
  }
}

export function storeCreateAccount(
  username: string,
  passwordHash: string,
): AccountRecord {
  const now = Date.now()
  const recordId = id('acct_')
  getDatabase()
    .query(
      `INSERT INTO accounts
       (id, username, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(recordId, username, passwordHash, now, now)
  return storeGetAccountById(recordId) as AccountRecord
}

export function storeGetAccountById(
  accountId: string,
): AccountRecord | undefined {
  const row = getDatabase()
    .query('SELECT * FROM accounts WHERE id = ?')
    .get(accountId) as AccountRow | null
  return row ? accountFromRow(row) : undefined
}

export function storeGetAccountByUsername(
  username: string,
): AccountRecord | undefined {
  const row = getDatabase()
    .query('SELECT * FROM accounts WHERE username = ?')
    .get(username) as AccountRow | null
  return row ? accountFromRow(row) : undefined
}

export function storeListAccounts(): AccountRecord[] {
  const rows = getDatabase()
    .query('SELECT * FROM accounts ORDER BY username')
    .all() as AccountRow[]
  return rows.map(accountFromRow)
}

export function storeSetAccountDisabled(
  accountId: string,
  disabled: boolean,
): boolean {
  const now = Date.now()
  if (!disabled) {
    return (
      getDatabase()
        .query(
          'UPDATE accounts SET disabled_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(null, now, accountId).changes > 0
    )
  }

  // Disabling has to take down every credential shape at once. Revoking only
  // `auth_tokens` left the environment secret and the per-work-item secret
  // usable, so a disabled account's bridge kept polling and acking work.
  const db = getDatabase()
  db.exec('BEGIN IMMEDIATE')
  let changed = false
  try {
    changed =
      db
        .query(
          'UPDATE accounts SET disabled_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(now, now, accountId).changes > 0
    if (changed) {
      db.query(
        `UPDATE auth_tokens SET revoked_at = ?
         WHERE account_id = ? AND revoked_at IS NULL`,
      ).run(now, accountId)
      db.query(
        `UPDATE environments SET status = 'deregistered', updated_at = ?
         WHERE account_id = ? AND status != 'deregistered'`,
      ).run(now, accountId)
      db.query(
        `UPDATE work_items SET credential_digest = NULL, updated_at = ?
         WHERE account_id = ? AND credential_digest IS NOT NULL`,
      ).run(now, accountId)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  if (changed) {
    notifyCredentialRevocation({ accountId, reason: 'account_disabled' })
  }
  return changed
}

export function storeUpdateAccountPassword(
  accountId: string,
  passwordHash: string,
): boolean {
  const now = Date.now()
  const db = getDatabase()
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = db
      .query(
        'UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?',
      )
      .run(passwordHash, now, accountId)
    if (result.changes > 0) {
      db.query(
        'UPDATE auth_tokens SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL',
      ).run(now, accountId)
    }
    db.exec('COMMIT')
    if (result.changes > 0) {
      notifyCredentialRevocation({ accountId, reason: 'password_reset' })
    }
    return result.changes > 0
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function storeEnsureLegacyAccount(
  username = 'legacy-system',
): AccountRecord {
  const existing = storeGetAccountById(LEGACY_ACCOUNT_ID)
  if (existing) return existing
  const now = Date.now()
  getDatabase()
    .query(
      `INSERT OR IGNORE INTO accounts
       (id, username, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(LEGACY_ACCOUNT_ID, username, '!legacy-auth-disabled!', now, now)
  return storeGetAccountById(LEGACY_ACCOUNT_ID) as AccountRecord
}

function storeCreateUser(username: string): AccountRecord {
  return (
    storeGetAccountByUsername(username) ??
    storeCreateAccount(username, '!password-login-disabled!')
  )
}

export function storeCreateAuthToken(token: AuthTokenRecord) {
  getDatabase()
    .query(
      `INSERT INTO auth_tokens
       (digest, account_id, kind, session_id, expires_at, created_at,
        revoked_at, replaced_by_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      token.digest,
      token.accountId,
      token.kind,
      token.sessionId,
      token.expiresAt.getTime(),
      token.createdAt.getTime(),
      token.revokedAt?.getTime() ?? null,
      token.replacedByDigest,
    )
}

export function storeReplacePairToken(token: AuthTokenRecord) {
  if (token.kind !== 'pair' || !token.sessionId) {
    throw new Error('Pair token must have a session')
  }
  const db = getDatabase()
  db.exec('BEGIN IMMEDIATE')
  try {
    const now = token.createdAt.getTime()
    db.query(
      `UPDATE auth_tokens SET revoked_at = ?
       WHERE account_id = ? AND session_id = ? AND kind = 'pair'
         AND revoked_at IS NULL`,
    ).run(now, token.accountId, token.sessionId)
    db.query(
      `INSERT INTO auth_tokens
       (digest, account_id, kind, session_id, expires_at, created_at)
       VALUES (?, ?, 'pair', ?, ?, ?)`,
    ).run(
      token.digest,
      token.accountId,
      token.sessionId,
      token.expiresAt.getTime(),
      now,
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function storeGetActiveAuthToken(
  digest: string,
  kind: AuthTokenKind,
  now = Date.now(),
): AuthTokenRecord | undefined {
  const row = getDatabase()
    .query(
      `SELECT t.* FROM auth_tokens t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.digest = ? AND t.kind = ? AND t.revoked_at IS NULL
         AND t.expires_at > ? AND a.disabled_at IS NULL`,
    )
    .get(digest, kind, now) as AuthTokenRow | null
  return row ? tokenFromRow(row) : undefined
}

/**
 * Look up a token row regardless of revocation. Only for reuse detection:
 * a revoked refresh token presented again is evidence the family leaked.
 */
export function storeGetAuthTokenRow(
  digest: string,
  kind: AuthTokenKind,
): { accountId: string; revokedAt: Date | null } | undefined {
  const row = getDatabase()
    .query(
      `SELECT account_id, revoked_at FROM auth_tokens
       WHERE digest = ? AND kind = ?`,
    )
    .get(digest, kind) as
    | { account_id: string; revoked_at: number | null }
    | undefined
  if (!row) return undefined
  return {
    accountId: row.account_id,
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
  }
}

type AuthTokenStatus = 'active' | 'revoked' | 'expired' | 'unknown'

/**
 * Classify a credential that failed the active-token lookup. Used only to pick
 * the close reason handed to a live transport, so it must not widen access.
 */
export function storeGetAuthTokenStatus(
  digest: string,
  kind: AuthTokenKind,
  now = Date.now(),
): AuthTokenStatus {
  const row = getDatabase()
    .query(
      `SELECT revoked_at, expires_at FROM auth_tokens
       WHERE digest = ? AND kind = ?`,
    )
    .get(digest, kind) as
    | { revoked_at: number | null; expires_at: number }
    | undefined
  if (!row) return 'unknown'
  if (row.revoked_at !== null) return 'revoked'
  if (row.expires_at <= now) return 'expired'
  return 'active'
}

export function storeRevokeAuthToken(
  digest: string,
  accountId?: string,
  now = Date.now(),
): boolean {
  const result = accountId
    ? getDatabase()
        .query(
          `UPDATE auth_tokens SET revoked_at = ?
           WHERE digest = ? AND account_id = ? AND revoked_at IS NULL`,
        )
        .run(now, digest, accountId)
    : getDatabase()
        .query(
          `UPDATE auth_tokens SET revoked_at = ?
           WHERE digest = ? AND revoked_at IS NULL`,
        )
        .run(now, digest)
  if (result.changes > 0) {
    notifyCredentialRevocation({ accountId, reason: 'token_revoked' })
  }
  return result.changes > 0
}

export function storeRevokeAccountTokens(
  accountId: string,
  kinds?: AuthTokenKind[],
  now = Date.now(),
): number {
  let changes: number
  if (!kinds || kinds.length === 0) {
    changes = getDatabase()
      .query(
        `UPDATE auth_tokens SET revoked_at = ?
         WHERE account_id = ? AND revoked_at IS NULL`,
      )
      .run(now, accountId).changes
  } else {
    const placeholders = kinds.map(() => '?').join(', ')
    changes = getDatabase()
      .query(
        `UPDATE auth_tokens SET revoked_at = ?
         WHERE account_id = ? AND revoked_at IS NULL
           AND kind IN (${placeholders})`,
      )
      .run(now, accountId, ...kinds).changes
  }
  if (changes > 0) {
    notifyCredentialRevocation({ accountId, reason: 'tokens_revoked' })
  }
  return changes
}

type RefreshRotationResult =
  | { replayed: true; accountId: string }
  | { replayed: false; account: AccountRecord }

export function storeRotateRefreshToken(
  oldDigest: string,
  accessToken: AuthTokenRecord,
  refreshToken: AuthTokenRecord,
  now = Date.now(),
): RefreshRotationResult | undefined {
  const db = getDatabase()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db
      .query(
        `SELECT t.* FROM auth_tokens t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.digest = ? AND t.kind = 'refresh'
           AND t.revoked_at IS NULL AND t.expires_at > ?
           AND a.disabled_at IS NULL`,
      )
      .get(oldDigest, now) as AuthTokenRow | null
    if (!row) {
      const replay = db
        .query(
          `SELECT t.account_id FROM auth_tokens t
           WHERE t.digest = ? AND t.kind = 'refresh'
             AND t.revoked_at IS NOT NULL`,
        )
        .get(oldDigest) as { account_id: string } | null
      db.exec('ROLLBACK')
      return replay
        ? { replayed: true, accountId: replay.account_id }
        : undefined
    }

    const revoked = db
      .query(
        `UPDATE auth_tokens
         SET revoked_at = ?, replaced_by_digest = ?
         WHERE digest = ? AND revoked_at IS NULL`,
      )
      .run(now, refreshToken.digest, oldDigest)
    if (revoked.changes !== 1) {
      db.exec('ROLLBACK')
      return { replayed: true, accountId: row.account_id }
    }

    for (const token of [accessToken, refreshToken]) {
      db.query(
        `INSERT INTO auth_tokens
         (digest, account_id, kind, session_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        token.digest,
        row.account_id,
        token.kind,
        token.sessionId,
        token.expiresAt.getTime(),
        token.createdAt.getTime(),
      )
    }
    db.exec('COMMIT')
    const account = storeGetAccountById(row.account_id)
    return account ? { replayed: false, account } : undefined
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function storeConsumePairToken(
  digest: string,
  now = Date.now(),
): { accountId: string; sessionId: string } | undefined {
  const db = getDatabase()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db
      .query(
        `SELECT t.* FROM auth_tokens t
         JOIN accounts a ON a.id = t.account_id
         JOIN sessions s ON s.id = t.session_id AND s.account_id = t.account_id
         WHERE t.digest = ? AND t.kind = 'pair' AND t.revoked_at IS NULL
           AND t.expires_at > ? AND a.disabled_at IS NULL`,
      )
      .get(digest, now) as AuthTokenRow | null
    if (!row?.session_id) {
      db.exec('ROLLBACK')
      return undefined
    }
    const result = db
      .query(
        `UPDATE auth_tokens SET revoked_at = ?
         WHERE digest = ? AND revoked_at IS NULL`,
      )
      .run(now, digest)
    if (result.changes !== 1) {
      db.exec('ROLLBACK')
      return undefined
    }
    db.exec('COMMIT')
    return { accountId: row.account_id, sessionId: row.session_id }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function defaultAccountId(username?: string): string {
  if (username) return storeCreateUser(username).id
  return storeEnsureLegacyAccount().id
}

export function storeCreateEnvironment(req: {
  accountId?: string
  secret: string
  machineName?: string
  directory?: string
  branch?: string
  gitRepoUrl?: string
  maxSessions?: number
  workerType?: string
  bridgeId?: string
  username?: string
  capabilities?: Record<string, unknown>
}): EnvironmentRecord {
  const accountId = req.accountId ?? defaultAccountId(req.username)
  const account = storeGetAccountById(accountId)
  if (!account) throw new Error('Account not found')
  const recordId = id('env_')
  const now = Date.now()
  const credentialDigest = digestToken(req.secret)
  getDatabase()
    .query(
      `INSERT INTO environments
       (id, account_id, credential_digest, machine_name, directory, branch,
        git_repo_url, max_sessions, worker_type, bridge_id, capabilities_json,
        status, last_poll_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .run(
      recordId,
      accountId,
      credentialDigest,
      req.machineName ?? null,
      req.directory ?? null,
      req.branch ?? null,
      req.gitRepoUrl ?? null,
      req.maxSessions ?? 1,
      req.workerType ?? 'claude_code',
      req.bridgeId ?? null,
      req.capabilities ? JSON.stringify(req.capabilities) : null,
      now,
      now,
      now,
    )
  const row = storeGetEnvironment(recordId, accountId)
  if (!row) throw new Error('Failed to create environment')
  return { ...row, secret: req.secret }
}

const ENVIRONMENT_SELECT = `
  SELECT e.*, a.username
  FROM environments e JOIN accounts a ON a.id = e.account_id
`

export function storeGetEnvironment(
  environmentId: string,
  accountId?: string,
): EnvironmentRecord | undefined {
  const row = accountId
    ? (getDatabase()
        .query(`${ENVIRONMENT_SELECT} WHERE e.id = ? AND e.account_id = ?`)
        .get(environmentId, accountId) as EnvironmentRow | null)
    : (getDatabase()
        .query(`${ENVIRONMENT_SELECT} WHERE e.id = ?`)
        .get(environmentId) as EnvironmentRow | null)
  return row ? environmentFromRow(row) : undefined
}

export function storeGetEnvironmentByCredential(
  rawToken: string,
  environmentId: string,
): EnvironmentRecord | undefined {
  // The account filter is not decoration: this lookup is the whole auth check
  // for the environment-credential branch of bridgeCredentialAuth, which never
  // reaches validateRuntimeAccess. Without it, `disable-user` left the bridge
  // polling work indefinitely.
  const row = getDatabase()
    .query(
      `${ENVIRONMENT_SELECT}
       WHERE e.id = ? AND e.credential_digest = ?
         AND e.status != 'deregistered' AND a.disabled_at IS NULL`,
    )
    .get(environmentId, digestToken(rawToken)) as EnvironmentRow | null
  return row ? environmentFromRow(row) : undefined
}

export function storeUpdateEnvironment(
  environmentId: string,
  patch: Partial<
    Pick<
      EnvironmentRecord,
      | 'status'
      | 'lastPollAt'
      | 'capabilities'
      | 'machineName'
      | 'maxSessions'
      | 'bridgeId'
    >
  >,
  accountId?: string,
): boolean {
  const fields: string[] = []
  const values: Array<string | number | null> = []
  if (patch.status !== undefined) {
    fields.push('status = ?')
    values.push(patch.status)
  }
  if (patch.lastPollAt !== undefined) {
    fields.push('last_poll_at = ?')
    values.push(patch.lastPollAt?.getTime() ?? null)
  }
  if (patch.capabilities !== undefined) {
    fields.push('capabilities_json = ?')
    values.push(
      patch.capabilities === null ? null : JSON.stringify(patch.capabilities),
    )
  }
  if (patch.machineName !== undefined) {
    fields.push('machine_name = ?')
    values.push(patch.machineName)
  }
  if (patch.maxSessions !== undefined) {
    fields.push('max_sessions = ?')
    values.push(patch.maxSessions)
  }
  if (patch.bridgeId !== undefined) {
    fields.push('bridge_id = ?')
    values.push(patch.bridgeId)
  }
  fields.push('updated_at = ?')
  values.push(Date.now(), environmentId)
  let sql = `UPDATE environments SET ${fields.join(', ')} WHERE id = ?`
  if (accountId) {
    sql += ' AND account_id = ?'
    values.push(accountId)
  }
  return (
    getDatabase()
      .query(sql)
      .run(...values).changes > 0
  )
}

function listEnvironments(
  where: string,
  values: string[],
): EnvironmentRecord[] {
  const rows = getDatabase()
    .query(`${ENVIRONMENT_SELECT} ${where} ORDER BY e.created_at`)
    .all(...values) as EnvironmentRow[]
  return rows.map(row => environmentFromRow(row))
}

export function storeListActiveEnvironments(
  accountId?: string,
): EnvironmentRecord[] {
  return accountId
    ? listEnvironments(`WHERE e.status = 'active' AND e.account_id = ?`, [
        accountId,
      ])
    : listEnvironments(`WHERE e.status = 'active'`, [])
}

export function storeListActiveEnvironmentsByUsername(
  username: string,
): EnvironmentRecord[] {
  return listEnvironments(`WHERE e.status = 'active' AND a.username = ?`, [
    username,
  ])
}

export function storeCountEnvironmentsForAccount(accountId: string): number {
  const row = getDatabase()
    .query('SELECT COUNT(*) AS count FROM environments WHERE account_id = ?')
    .get(accountId) as { count: number }
  return row.count
}

const SESSION_SELECT = `
  SELECT s.*, a.username
  FROM sessions s JOIN accounts a ON a.id = s.account_id
`

export function storeCreateSession(req: {
  accountId?: string
  environmentId?: string | null
  title?: string | null
  source?: string
  permissionMode?: string | null
  idPrefix?: string
  username?: string | null
}): SessionRecord {
  const accountId = req.accountId ?? defaultAccountId(req.username ?? undefined)
  if (req.environmentId && !storeGetEnvironment(req.environmentId, accountId)) {
    throw new Error('Environment not found')
  }
  const recordId = id(req.idPrefix || 'session_')
  const now = Date.now()
  getDatabase()
    .query(
      `INSERT INTO sessions
       (id, account_id, environment_id, title, status, source,
        permission_mode, worker_epoch, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'idle', ?, ?, 0, ?, ?)`,
    )
    .run(
      recordId,
      accountId,
      req.environmentId ?? null,
      req.title ?? null,
      req.source ?? 'remote-control',
      req.permissionMode ?? null,
      now,
      now,
    )
  return storeGetSession(recordId, accountId) as SessionRecord
}

export function storeGetSession(
  sessionId: string,
  accountId?: string,
): SessionRecord | undefined {
  const row = accountId
    ? (getDatabase()
        .query(`${SESSION_SELECT} WHERE s.id = ? AND s.account_id = ?`)
        .get(sessionId, accountId) as SessionRow | null)
    : (getDatabase()
        .query(`${SESSION_SELECT} WHERE s.id = ?`)
        .get(sessionId) as SessionRow | null)
  return row ? sessionFromRow(row) : undefined
}

export function storeUpdateSession(
  sessionId: string,
  patch: Partial<
    Pick<SessionRecord, 'title' | 'status' | 'workerEpoch' | 'updatedAt'>
  >,
  accountId?: string,
): boolean {
  const fields: string[] = []
  const values: Array<string | number> = []
  if (patch.title !== undefined) {
    fields.push('title = ?')
    values.push(patch.title ?? '')
  }
  if (patch.status !== undefined) {
    fields.push('status = ?')
    values.push(patch.status)
  }
  if (patch.workerEpoch !== undefined) {
    fields.push('worker_epoch = ?')
    values.push(patch.workerEpoch)
  }
  fields.push('updated_at = ?')
  values.push(patch.updatedAt?.getTime() ?? Date.now(), sessionId)
  let sql = `UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`
  if (accountId) {
    sql += ' AND account_id = ?'
    values.push(accountId)
  }
  return (
    getDatabase()
      .query(sql)
      .run(...values).changes > 0
  )
}

function listSessions(where = '', values: string[] = []): SessionRecord[] {
  const rows = getDatabase()
    .query(`${SESSION_SELECT} ${where} ORDER BY s.created_at`)
    .all(...values) as SessionRow[]
  return rows.map(sessionFromRow)
}

export function storeListSessions(accountId?: string): SessionRecord[] {
  return accountId
    ? listSessions('WHERE s.account_id = ?', [accountId])
    : listSessions()
}

export function storeListSessionsByUsername(username: string): SessionRecord[] {
  return listSessions('WHERE a.username = ?', [username])
}

export function storeListSessionsByEnvironment(
  environmentId: string,
  accountId?: string,
): SessionRecord[] {
  return accountId
    ? listSessions('WHERE s.environment_id = ? AND s.account_id = ?', [
        environmentId,
        accountId,
      ])
    : listSessions('WHERE s.environment_id = ?', [environmentId])
}

export function storeCountSessionsForAccount(accountId: string): number {
  const row = getDatabase()
    .query('SELECT COUNT(*) AS count FROM sessions WHERE account_id = ?')
    .get(accountId) as { count: number }
  return row.count
}

export function storeGetSessionWorker(
  sessionId: string,
  accountId?: string,
): SessionWorkerRecord | undefined {
  const row = accountId
    ? (getDatabase()
        .query(
          'SELECT * FROM session_workers WHERE session_id = ? AND account_id = ?',
        )
        .get(sessionId, accountId) as SessionWorkerRow | null)
    : (getDatabase()
        .query('SELECT * FROM session_workers WHERE session_id = ?')
        .get(sessionId) as SessionWorkerRow | null)
  return row ? workerFromRow(row) : undefined
}

export function storeUpsertSessionWorker(
  sessionId: string,
  patch: {
    workerStatus?: string | null
    externalMetadata?: Record<string, unknown> | null
    requiresActionDetails?: Record<string, unknown> | null
    lastHeartbeatAt?: Date | null
  },
  accountId?: string,
): SessionWorkerRecord {
  const session = storeGetSession(sessionId, accountId)
  if (!session) throw new Error('Session not found')
  const existing = storeGetSessionWorker(sessionId, session.accountId)
  const now = Date.now()
  const externalMetadata =
    patch.externalMetadata === undefined
      ? (existing?.externalMetadata ?? null)
      : patch.externalMetadata === null
        ? null
        : { ...(existing?.externalMetadata ?? {}), ...patch.externalMetadata }
  const requiresActionDetails =
    patch.requiresActionDetails === undefined
      ? (existing?.requiresActionDetails ?? null)
      : patch.requiresActionDetails
  getDatabase()
    .query(
      `INSERT INTO session_workers
       (session_id, account_id, worker_status, external_metadata_json,
        requires_action_details_json, last_heartbeat_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         worker_status = excluded.worker_status,
         external_metadata_json = excluded.external_metadata_json,
         requires_action_details_json = excluded.requires_action_details_json,
         last_heartbeat_at = excluded.last_heartbeat_at,
         updated_at = excluded.updated_at`,
    )
    .run(
      sessionId,
      session.accountId,
      patch.workerStatus === undefined
        ? (existing?.workerStatus ?? null)
        : patch.workerStatus,
      externalMetadata === null ? null : JSON.stringify(externalMetadata),
      requiresActionDetails === null
        ? null
        : JSON.stringify(requiresActionDetails),
      patch.lastHeartbeatAt === undefined
        ? (existing?.lastHeartbeatAt?.getTime() ?? null)
        : (patch.lastHeartbeatAt?.getTime() ?? null),
      existing?.createdAt.getTime() ?? now,
      now,
    )
  return storeGetSessionWorker(
    sessionId,
    session.accountId,
  ) as SessionWorkerRecord
}

export function storeCreateWorkItem(req: {
  accountId?: string
  environmentId: string
  sessionId: string
  secret?: string
}): WorkItemRecord {
  const environment = storeGetEnvironment(req.environmentId, req.accountId)
  if (!environment) throw new Error('Environment not found')
  const session = storeGetSession(req.sessionId, environment.accountId)
  if (!session) throw new Error('Session not found')
  const recordId = id('work_')
  const now = Date.now()
  const credentialDigest = req.secret ? digestToken(req.secret) : null
  getDatabase()
    .query(
      `INSERT INTO work_items
       (id, account_id, environment_id, session_id, state,
        credential_digest, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(
      recordId,
      environment.accountId,
      req.environmentId,
      req.sessionId,
      credentialDigest,
      now,
      now,
    )
  const record = storeGetWorkItem(recordId, environment.accountId)
  if (!record) throw new Error('Failed to create work item')
  return { ...record, secret: req.secret ?? '' }
}

export function storeGetWorkItem(
  workItemId: string,
  accountId?: string,
): WorkItemRecord | undefined {
  const row = accountId
    ? (getDatabase()
        .query('SELECT * FROM work_items WHERE id = ? AND account_id = ?')
        .get(workItemId, accountId) as WorkItemRow | null)
    : (getDatabase()
        .query('SELECT * FROM work_items WHERE id = ?')
        .get(workItemId) as WorkItemRow | null)
  return row ? workItemFromRow(row) : undefined
}

export function storeGetPendingWorkItem(
  environmentId: string,
  accountId?: string,
): WorkItemRecord | undefined {
  const row = accountId
    ? (getDatabase()
        .query(
          `SELECT * FROM work_items
           WHERE environment_id = ? AND account_id = ? AND state = 'pending'
           ORDER BY created_at LIMIT 1`,
        )
        .get(environmentId, accountId) as WorkItemRow | null)
    : (getDatabase()
        .query(
          `SELECT * FROM work_items
           WHERE environment_id = ? AND state = 'pending'
           ORDER BY created_at LIMIT 1`,
        )
        .get(environmentId) as WorkItemRow | null)
  return row ? workItemFromRow(row) : undefined
}

export function storeClaimPendingWorkItem(
  environmentId: string,
  accountId: string,
  credentialDigest: string,
  expectedWorkItemId?: string,
): WorkItemRecord | undefined {
  const db = getDatabase()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = expectedWorkItemId
      ? (db
          .query(
            `SELECT * FROM work_items
             WHERE id = ? AND environment_id = ? AND account_id = ?
               AND state = 'pending'`,
          )
          .get(
            expectedWorkItemId,
            environmentId,
            accountId,
          ) as WorkItemRow | null)
      : (db
          .query(
            `SELECT * FROM work_items
             WHERE environment_id = ? AND account_id = ? AND state = 'pending'
             ORDER BY created_at LIMIT 1`,
          )
          .get(environmentId, accountId) as WorkItemRow | null)
    if (!row) {
      db.exec('ROLLBACK')
      return undefined
    }
    const now = Date.now()
    const result = db
      .query(
        `UPDATE work_items SET state = 'dispatched', credential_digest = ?,
         updated_at = ? WHERE id = ? AND state = 'pending'`,
      )
      .run(credentialDigest, now, row.id)
    if (result.changes !== 1) {
      db.exec('ROLLBACK')
      return undefined
    }
    db.exec('COMMIT')
    return storeGetWorkItem(row.id, accountId)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function storeUpdateWorkItem(
  workItemId: string,
  patch: Partial<Pick<WorkItemRecord, 'state'>>,
  accountId?: string,
): boolean {
  const values: Array<string | number> = []
  const fields: string[] = []
  if (patch.state !== undefined) {
    fields.push('state = ?')
    values.push(patch.state)
  }
  fields.push('updated_at = ?')
  values.push(Date.now(), workItemId)
  let sql = `UPDATE work_items SET ${fields.join(', ')} WHERE id = ?`
  if (accountId) {
    sql += ' AND account_id = ?'
    values.push(accountId)
  }
  return (
    getDatabase()
      .query(sql)
      .run(...values).changes > 0
  )
}

export function storeWorkCredentialMatches(
  workItemId: string,
  accountId: string,
  rawToken: string,
): boolean {
  const row = getDatabase()
    .query(
      `SELECT 1 AS found FROM work_items
       WHERE id = ? AND account_id = ? AND credential_digest = ?`,
    )
    .get(workItemId, accountId, digestToken(rawToken)) as {
    found: number
  } | null
  return !!row
}

export function storeListAcpAgents(accountId?: string): EnvironmentRecord[] {
  return accountId
    ? listEnvironments('WHERE e.worker_type = ? AND e.account_id = ?', [
        'acp',
        accountId,
      ])
    : listEnvironments('WHERE e.worker_type = ?', ['acp'])
}

export function storeListAcpAgentsByChannelGroup(
  channelGroupId: string,
  accountId?: string,
): EnvironmentRecord[] {
  return accountId
    ? listEnvironments(
        'WHERE e.worker_type = ? AND e.bridge_id = ? AND e.account_id = ?',
        ['acp', channelGroupId, accountId],
      )
    : listEnvironments('WHERE e.worker_type = ? AND e.bridge_id = ?', [
        'acp',
        channelGroupId,
      ])
}

export function storeMarkAcpAgentOffline(id: string): boolean {
  const record = storeGetEnvironment(id)
  return !!record && record.workerType === 'acp'
    ? storeUpdateEnvironment(id, { status: 'offline' })
    : false
}

export function storeMarkAcpAgentOnline(id: string): boolean {
  const record = storeGetEnvironment(id)
  return !!record && record.workerType === 'acp'
    ? storeUpdateEnvironment(id, {
        status: 'active',
        lastPollAt: new Date(),
      })
    : false
}

export function storeAppendEvent(event: {
  id: string
  sessionId: string
  type: string
  payload: unknown
  direction: 'inbound' | 'outbound'
  createdAt?: number
}): PersistedEventRecord {
  const db = getDatabase()
  db.exec('BEGIN IMMEDIATE')
  try {
    const session = db
      .query('SELECT account_id, next_event_seq FROM sessions WHERE id = ?')
      .get(event.sessionId) as {
      account_id: string
      next_event_seq: number
    } | null
    if (!session) throw new Error('Session not found')
    const seqNum = session.next_event_seq + 1
    const createdAt = event.createdAt ?? Date.now()
    db.query(
      `UPDATE sessions SET next_event_seq = ?, updated_at = ? WHERE id = ?`,
    ).run(seqNum, createdAt, event.sessionId)
    db.query(
      `INSERT INTO events
       (session_id, account_id, seq_num, id, type, payload_json,
        direction, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.sessionId,
      session.account_id,
      seqNum,
      event.id,
      event.type,
      JSON.stringify(event.payload ?? null),
      event.direction,
      createdAt,
    )
    if (seqNum > MAX_EVENTS_PER_SESSION) {
      db.query('DELETE FROM events WHERE session_id = ? AND seq_num <= ?').run(
        event.sessionId,
        seqNum - MAX_EVENTS_PER_SESSION,
      )
    }
    db.exec('COMMIT')
    return {
      ...event,
      accountId: session.account_id,
      seqNum,
      createdAt,
    }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function storeListEvents(
  sessionId: string,
  fromSeqNum: number,
  accountId?: string,
): PersistedEventRecord[] {
  const rows = accountId
    ? (getDatabase()
        .query(
          `SELECT * FROM events
           WHERE session_id = ? AND account_id = ? AND seq_num > ?
           ORDER BY seq_num`,
        )
        .all(sessionId, accountId, fromSeqNum) as EventRow[])
    : (getDatabase()
        .query(
          `SELECT * FROM events WHERE session_id = ? AND seq_num > ?
           ORDER BY seq_num`,
        )
        .all(sessionId, fromSeqNum) as EventRow[])
  return rows.map(eventFromRow)
}

export function storeGetLastEventSeq(sessionId: string): number {
  const row = getDatabase()
    .query('SELECT next_event_seq FROM sessions WHERE id = ?')
    .get(sessionId) as { next_event_seq: number } | null
  return row?.next_event_seq ?? 0
}

export function storeConsumeRateLimit(
  bucketKey: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): { allowed: boolean; retryAfterSeconds: number } {
  const db = getDatabase()
  const windowMs = windowSeconds * 1000
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db
      .query(
        'SELECT count, window_started_at FROM rate_limit_buckets WHERE bucket_key = ?',
      )
      .get(bucketKey) as { count: number; window_started_at: number } | null
    if (!row || now - row.window_started_at >= windowMs) {
      db.query(
        `INSERT INTO rate_limit_buckets (bucket_key, count, window_started_at)
         VALUES (?, 1, ?)
         ON CONFLICT(bucket_key) DO UPDATE SET count = 1,
           window_started_at = excluded.window_started_at`,
      ).run(bucketKey, now)
      db.exec('COMMIT')
      return { allowed: true, retryAfterSeconds: 0 }
    }
    if (row.count >= limit) {
      db.exec('COMMIT')
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((row.window_started_at + windowMs - now) / 1000),
        ),
      }
    }
    db.query(
      'UPDATE rate_limit_buckets SET count = count + 1 WHERE bucket_key = ?',
    ).run(bucketKey)
    db.exec('COMMIT')
    return { allowed: true, retryAfterSeconds: 0 }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function storePruneExpiredSecurityState(
  rateLimitRetentionMs: number,
  now = Date.now(),
): { tokens: number; rateLimits: number } {
  const db = getDatabase()
  const tokens = db
    .query('DELETE FROM auth_tokens WHERE expires_at <= ?')
    .run(now).changes
  const rateLimits = db
    .query('DELETE FROM rate_limit_buckets WHERE window_started_at <= ?')
    .run(now - rateLimitRetentionMs).changes
  return { tokens, rateLimits }
}

export function storeReset() {
  const db = getDatabase()
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec(`
      DELETE FROM events;
      DELETE FROM session_workers;
      DELETE FROM work_items;
      DELETE FROM sessions;
      DELETE FROM environments;
      DELETE FROM auth_tokens;
      DELETE FROM accounts;
      DELETE FROM rate_limit_buckets;
    `)
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}
