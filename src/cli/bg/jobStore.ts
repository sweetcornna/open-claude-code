/**
 * Minimal job store for background sessions.
 *
 * WHY THIS EXISTS
 *
 * occ's PID registry (`<occConfigDir>/sessions/<pid>.json`) answers "who is
 * alive". It cannot answer "what happened to the session I stopped an hour
 * ago", because the record dies with the process. `stop` and `rm` both need
 * that second answer: `stop` must leave a visible, resumable terminal record,
 * and `rm` must have something to remove.
 *
 * Official Claude Code solves this with `~/.claude/jobs/<short>/state.json`
 * plus sort/group sidecars and a lockfile. This is the thin half of that: one
 * flat JSON file per job under `<occConfigDir>/sessions/jobs/<jobId>.json`,
 * with the same field names for the subset occ actually uses.
 *
 * DEPENDENCY RULE
 *
 * Only `node:` builtins and `occConfigPath`. The cycle ratchet
 * (`bun run check:cycles`) is two-directional and counts type-only edges, and
 * this module is imported from both the CLI verb path and a REPL slash
 * command. Process-liveness is re-implemented as a three-line local helper
 * rather than importing `genericProcessUtils`, for the same reason
 * `modelTier.ts` and `deepseekFamily.ts` stay dependency-free. Zero deps also
 * means the unit tests run against a real temp directory with no mocks.
 *
 * DELETION SAFETY
 *
 * Job records are user-writable input and `rm` takes a user-supplied target,
 * so this is the one path in the background subsystem that can lose data.
 * Every unlink goes through {@link jobFilePath}, which resolves the path and
 * requires it to be a direct child of the managed jobs directory whose
 * filename matches the job-id format — the same defence
 * `removeManagedSessionLog()` applies to session logs after
 * anthropics/claude-code#34210.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { BIN_NAME, occConfigPath } from '../../config/paths.js'

/** `running` while the process is up; the other two are terminal. */
export type JobState = 'running' | 'stopped' | 'failed'

/** Coarse activity, mirroring the official field. */
export type JobTempo = 'active' | 'idle'

export type JobRecord = {
  /** 8 lowercase hex chars. Also the suffix of the session name and log file. */
  jobId: string
  state: JobState
  /** Short human-readable reason for the current state. */
  detail?: string
  tempo?: JobTempo
  /** Session name (`occ-bg-<jobId>`), the handle users type. */
  name?: string
  /** Conversation id the background process runs under. */
  sessionId?: string
  pid?: number
  cwd?: string
  logPath?: string
  engine?: 'tmux' | 'detached'
  /** Start marker of the launching process, for PID-reuse detection. */
  processStartMarker?: string
  createdAt: number
  updatedAt: number
  /** First transition into a terminal state; ages freeze here. */
  firstTerminalAt?: number
}

/** A job id is exactly what the session-name and log-file suffixes are. */
export const JOB_ID_PATTERN = /^[0-9a-f]{8}$/

/** Records larger than this are treated as unreadable rather than parsed. */
const MAX_JOB_FILE_BYTES = 256 * 1024

/** Locks older than this are stale even if their PID happens to be alive. */
const JOB_LOCK_TTL_MS = 5 * 60 * 1000

export function isJobId(value: string | undefined): value is string {
  return typeof value === 'string' && JOB_ID_PATTERN.test(value)
}

/** Fresh id in the same shape the bg session name already uses. */
export function newJobId(): string {
  return randomUUID().slice(0, 8)
}

/**
 * `occ-bg-a1b2c3d4` → `a1b2c3d4`. Returns undefined for anything else, so a
 * hand-edited registry entry cannot smuggle a path segment through.
 */
export function jobIdFromSessionName(
  name: string | undefined,
): string | undefined {
  if (!name) return undefined
  const suffix = name.slice(name.lastIndexOf('-') + 1)
  return isJobId(suffix) ? suffix : undefined
}

export function jobsDir(): string {
  return occConfigPath('sessions', 'jobs')
}

/**
 * Absolute path of a job record, or undefined when the id is not a job id or
 * the resolved path escapes the managed directory. Every read and every
 * unlink goes through here.
 */
export function jobFilePath(jobId: string): string | undefined {
  if (!isJobId(jobId)) return undefined
  const dir = resolve(jobsDir())
  const target = resolve(join(dir, `${jobId}.json`))
  const filename = basename(target)
  if (dirname(target) !== dir) return undefined
  if (!/^[0-9a-f]{8}\.json$/.test(filename)) return undefined
  return target
}

function lockFilePath(jobId: string): string | undefined {
  const record = jobFilePath(jobId)
  if (!record) return undefined
  return `${record.slice(0, -'.json'.length)}.lock`
}

/**
 * Local liveness probe. `kill(pid, 0)` throws ESRCH when the process is gone
 * and EPERM when it exists but belongs to another user — the latter still
 * means "alive", so only ESRCH counts as dead.
 */
function isPidAlive(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || !pid || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

async function ensureJobsDir(): Promise<string> {
  const dir = jobsDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

export type JobReadResult =
  | { status: 'ok'; record: JobRecord }
  | { status: 'missing' }
  | { status: 'unreadable' }

/**
 * Read one record. Distinguishes "no such job" from "the file is there but we
 * cannot understand it" because `rm` must refuse the second case rather than
 * delete a file whose contents it never validated.
 */
export async function readJobRecord(jobId: string): Promise<JobReadResult> {
  const path = jobFilePath(jobId)
  if (!path) return { status: 'missing' }
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { status: 'missing' }
    }
    return { status: 'unreadable' }
  }
  if (raw.length > MAX_JOB_FILE_BYTES) return { status: 'unreadable' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'unreadable' }
  }
  const record = normalizeRecord(jobId, parsed)
  return record ? { status: 'ok', record } : { status: 'unreadable' }
}

function normalizeRecord(
  jobId: string,
  parsed: unknown,
): JobRecord | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined
  }
  const data = parsed as Record<string, unknown>
  const state = data.state
  if (state !== 'running' && state !== 'stopped' && state !== 'failed') {
    return undefined
  }
  const engine = data.engine
  const tempo = data.tempo
  return {
    // The filename is the authority, exactly as it is for `<pid>.json`.
    jobId,
    state,
    detail: typeof data.detail === 'string' ? data.detail : undefined,
    tempo: tempo === 'active' || tempo === 'idle' ? tempo : undefined,
    name: typeof data.name === 'string' ? data.name : undefined,
    sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
    pid: Number.isSafeInteger(data.pid) ? (data.pid as number) : undefined,
    cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
    logPath: typeof data.logPath === 'string' ? data.logPath : undefined,
    engine: engine === 'tmux' || engine === 'detached' ? engine : undefined,
    processStartMarker:
      typeof data.processStartMarker === 'string'
        ? data.processStartMarker
        : undefined,
    createdAt: Number.isFinite(data.createdAt) ? (data.createdAt as number) : 0,
    updatedAt: Number.isFinite(data.updatedAt) ? (data.updatedAt as number) : 0,
    firstTerminalAt: Number.isFinite(data.firstTerminalAt)
      ? (data.firstTerminalAt as number)
      : undefined,
  }
}

export async function readJob(jobId: string): Promise<JobRecord | undefined> {
  const result = await readJobRecord(jobId)
  return result.status === 'ok' ? result.record : undefined
}

/** Job ids present on disk, readable or not. */
export async function listJobIds(): Promise<string[]> {
  let files: string[]
  try {
    files = await readdir(jobsDir())
  } catch {
    return []
  }
  return files
    .filter(file => /^[0-9a-f]{8}\.json$/.test(file))
    .map(file => file.slice(0, -'.json'.length))
    .sort()
}

export async function listJobs(): Promise<JobRecord[]> {
  const ids = await listJobIds()
  const records: JobRecord[] = []
  for (const id of ids) {
    const record = await readJob(id)
    if (record) records.push(record)
  }
  return records
}

export type NewJobInput = Omit<JobRecord, 'createdAt' | 'updatedAt'> & {
  createdAt?: number
  updatedAt?: number
}

export async function writeJob(
  input: NewJobInput,
): Promise<JobRecord | undefined> {
  const path = jobFilePath(input.jobId)
  if (!path) return undefined
  await ensureJobsDir()
  const now = Date.now()
  const record: JobRecord = {
    ...input,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  }
  await writeFile(path, JSON.stringify(record, null, 2), { mode: 0o600 })
  return record
}

/** Patch an existing record. No-op (undefined) when it is gone or corrupt. */
export async function updateJob(
  jobId: string,
  patch: Partial<Omit<JobRecord, 'jobId'>>,
): Promise<JobRecord | undefined> {
  const existing = await readJob(jobId)
  if (!existing) return undefined
  return writeJob({ ...existing, ...patch, jobId, updatedAt: Date.now() })
}

/**
 * Move a job into a terminal state. `firstTerminalAt` is written once and
 * never overwritten, so a stop-then-kill sequence still ages from the first
 * transition (the official field has the same rule).
 */
export async function markJobTerminal(
  jobId: string,
  options: { state: Exclude<JobState, 'running'>; detail?: string },
): Promise<JobRecord | undefined> {
  const existing = await readJob(jobId)
  if (!existing) return undefined
  return writeJob({
    ...existing,
    state: options.state,
    detail: options.detail ?? existing.detail,
    tempo: 'idle',
    firstTerminalAt: existing.firstTerminalAt ?? Date.now(),
    updatedAt: Date.now(),
  })
}

/**
 * Resolve a user-supplied target the same three ways `findSession()` does —
 * job id, session name, session id — plus PID.
 */
export async function findJob(target: string): Promise<JobRecord | undefined> {
  if (isJobId(target)) {
    const direct = await readJob(target)
    if (direct) return direct
  }
  const fromName = jobIdFromSessionName(target)
  if (fromName) {
    const record = await readJob(fromName)
    if (record) return record
  }
  const asPid = Number.parseInt(target, 10)
  const all = await listJobs()
  return all.find(
    record =>
      record.sessionId === target ||
      record.name === target ||
      (Number.isSafeInteger(asPid) && record.pid === asPid),
  )
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

export type JobLock = { jobId: string; release: () => Promise<void> }

export type JobLockHolder = { pid: number; at: number }

/** Inspect a job's lock, ignoring stale ones (dead holder or past TTL). */
export async function readJobLock(
  jobId: string,
  now: number = Date.now(),
): Promise<JobLockHolder | undefined> {
  const path = lockFilePath(jobId)
  if (!path) return undefined
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  let holder: JobLockHolder | undefined
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (Number.isSafeInteger(parsed.pid) && Number.isFinite(parsed.at)) {
      holder = { pid: parsed.pid as number, at: parsed.at as number }
    }
  } catch {
    holder = undefined
  }
  // A lock we cannot parse is not a lock; treating it as one would make the
  // job permanently unremovable.
  if (!holder) return undefined
  if (now - holder.at > JOB_LOCK_TTL_MS) return undefined
  if (holder.pid !== process.pid && !isPidAlive(holder.pid)) return undefined
  return holder
}

/**
 * Take the mutation lock for a job. Returns undefined when another live
 * process holds it — the caller reports `live_lock` rather than racing.
 */
export async function acquireJobLock(
  jobId: string,
): Promise<JobLock | undefined> {
  const path = lockFilePath(jobId)
  if (!path) return undefined
  await ensureJobsDir()
  const payload = JSON.stringify({ pid: process.pid, at: Date.now() })
  const release = async (): Promise<void> => {
    await unlink(path).catch(() => {})
  }
  try {
    await writeFile(path, payload, { flag: 'wx', mode: 0o600 })
    return { jobId, release }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') return undefined
  }
  // Stale lock: reclaim it once. A second EEXIST means someone else won the
  // race, which is exactly the case the caller must refuse.
  if (await readJobLock(jobId)) return undefined
  await unlink(path).catch(() => {})
  try {
    await writeFile(path, payload, { flag: 'wx', mode: 0o600 })
    return { jobId, release }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/**
 * The official refusal set, transcribed from `rm`'s implementation. occ has no
 * per-job git worktree, so each reason is re-pointed at the artifact occ
 * actually deletes (the job record plus its managed log):
 *
 *   occupied           the session is still running after a graceful stop
 *   in_use             a different live session claims this job's conversation
 *   unverified         the recorded PID is alive but cannot be identified
 *   shared_record      another job record points at the same log or session
 *   live_lock          another occ process holds this job's lock right now
 *   identity_changed   the recorded PID is alive but is a different process
 *   records_unreadable the record exists but cannot be read or parsed
 */
export type JobRemovalRefusal =
  | 'occupied'
  | 'in_use'
  | 'unverified'
  | 'shared_record'
  | 'live_lock'
  | 'identity_changed'
  | 'records_unreadable'

export type JobRemovalFacts = {
  jobId: string
  /** Recorded PID, for message text only. */
  pid?: number
  /** False when the file is present but could not be read or parsed. */
  recordReadable: boolean
  /** PID of a live process holding the job lock, if any. */
  lockedByPid?: number
  /** Whether the job's recorded PID is currently running. */
  processAlive: boolean
  /** Start marker captured when the job was created. */
  recordedMarker?: string
  /** Start marker re-derived now; undefined when it could not be derived. */
  currentMarker?: string
  /** PID of a *different* live session that claims this job's session id. */
  claimedByPid?: number
  /** Another job record pointing at the same log path or session id. */
  sharedWithJobId?: string
}

export type JobRemovalDecision =
  | { ok: true }
  | { ok: false; reason: JobRemovalRefusal; message: string }

/**
 * Pure decision function: given facts, either allow removal or name the
 * reason. Kept free of I/O so every branch is unit-testable without spawning
 * processes or mocking the filesystem. Order is fixed — the checks overlap
 * (a live process can be both unverifiable and occupied) and users are better
 * served by the most specific reason first.
 */
export function evaluateJobRemoval(facts: JobRemovalFacts): JobRemovalDecision {
  if (!facts.recordReadable) {
    return {
      ok: false,
      reason: 'records_unreadable',
      message: `job ${facts.jobId}: its record could not be read, so there is no way to tell what removing it would delete. Inspect ${jobFilePath(facts.jobId) ?? 'the job file'} and delete it by hand if it is junk.`,
    }
  }
  if (facts.lockedByPid !== undefined) {
    return {
      ok: false,
      reason: 'live_lock',
      message: `job ${facts.jobId}: another ${BIN_NAME} process (PID ${facts.lockedByPid}) is modifying this job right now.`,
    }
  }
  if (facts.processAlive) {
    const pidLabel =
      facts.pid === undefined ? 'its process' : `PID ${facts.pid}`
    if (!facts.recordedMarker || !facts.currentMarker) {
      return {
        ok: false,
        reason: 'unverified',
        message: `job ${facts.jobId}: ${pidLabel} is running but its process identity could not be verified, so removing the record could orphan a live session.`,
      }
    }
    if (facts.recordedMarker !== facts.currentMarker) {
      return {
        ok: false,
        reason: 'identity_changed',
        message: `job ${facts.jobId}: ${pidLabel} is running but is no longer the process this job started; refusing to act on a reused PID.`,
      }
    }
    return {
      ok: false,
      reason: 'occupied',
      message: `job ${facts.jobId}: the session is still running. Stop it first with \`${BIN_NAME} stop ${facts.jobId}\`, then remove it.`,
    }
  }
  if (facts.claimedByPid !== undefined) {
    return {
      ok: false,
      reason: 'in_use',
      message: `job ${facts.jobId}: its conversation is open in another live session (PID ${facts.claimedByPid}).`,
    }
  }
  if (facts.sharedWithJobId !== undefined) {
    return {
      ok: false,
      reason: 'shared_record',
      message: `job ${facts.jobId}: job ${facts.sharedWithJobId} points at the same log or conversation; removing this record would delete artifacts that job still needs.`,
    }
  }
  return { ok: true }
}

/**
 * Delete a job record. Returns false when the id is not a job id, when the
 * resolved path is not a direct child of the managed jobs directory, or when
 * the file is already gone.
 */
export async function deleteJobRecord(jobId: string): Promise<boolean> {
  const path = jobFilePath(jobId)
  if (!path) return false
  try {
    await unlink(path)
    return true
  } catch {
    return false
  } finally {
    const lock = lockFilePath(jobId)
    if (lock) await unlink(lock).catch(() => {})
  }
}
