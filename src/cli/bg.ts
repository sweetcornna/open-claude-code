import { readdir, readFile, unlink } from 'fs/promises'
import treeKill from 'tree-kill'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { BIN_NAME } from '../constants/brand.js'
import { occConfigPath } from '../config/paths.js'
import { getClaudeConfigHomeDir } from '../utils/config/envUtils.js'
import { isProcessRunning } from '../utils/process/genericProcessUtils.js'
import { getPlatform } from '../utils/process/platform.js'
import {
  getProcessStartMarker,
  removeManagedSessionLog,
} from '../utils/session/concurrentSessions.js'
import { jsonParse } from '../utils/telemetry/slowOperations.js'
import { selectEngine } from './bg/engines/index.js'
import type { SessionEntry } from './bg/engine.js'
import {
  acquireJobLock,
  deleteJobRecord,
  evaluateJobRemoval,
  findJob,
  isJobId,
  type JobRecord,
  type JobRemovalFacts,
  jobIdFromSessionName,
  listJobs,
  markJobTerminal,
  readJob,
  readJobLock,
  readJobRecord,
  writeJob,
} from './bg/jobStore.js'

/**
 * Terminate a background session and everything it spawned.
 *
 * On Windows the whole SIGTERM-then-SIGKILL ladder is a formality — both map to
 * TerminateProcess, so the session never runs its cleanup registry or saves its
 * transcript. What can be fixed is the orphaning: without a process group,
 * `process.kill` leaves the session's children (MCP servers, shells) running
 * forever. tree-kill uses `taskkill /T` to walk the tree.
 */
function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    treeKill(pid, signal)
    return
  }
  process.kill(pid, signal)
}

export type { SessionEntry } from './bg/engine.js'

const sessionPidFiles = new WeakMap<SessionEntry, string>()

function getSessionsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')
}

async function removeSessionArtifacts(
  pidFile: string,
  logPath?: string,
): Promise<void> {
  await Promise.all([
    unlink(pidFile).catch(() => {}),
    removeManagedSessionLog(logPath),
  ])
}

export async function listLiveSessions(): Promise<SessionEntry[]> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  const sessions: SessionEntry[] = []
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)
    const pidFile = join(dir, file)
    const processRunning = isProcessRunning(pid)

    let entry: SessionEntry
    try {
      const raw = await readFile(pidFile, 'utf-8')
      entry = jsonParse(raw) as SessionEntry
    } catch {
      // Corrupt stale registries should not survive forever.
      if (!processRunning) await unlink(pidFile).catch(() => {})
      continue
    }

    if (!processRunning) {
      await removeSessionArtifacts(pidFile, entry.logPath)
      continue
    }

    // The filename is the registry authority. Trusting a divergent JSON PID
    // would let a stale or tampered entry redirect signal-sending commands.
    if (!Number.isSafeInteger(entry.pid) || entry.pid !== pid) {
      await removeSessionArtifacts(pidFile, entry.logPath)
      continue
    }

    if (entry.processStartMarker) {
      const currentMarker = await getProcessStartMarker(pid)
      if (currentMarker && currentMarker !== entry.processStartMarker) {
        if (getPlatform() !== 'wsl') {
          await removeSessionArtifacts(pidFile, entry.logPath)
        }
        continue
      }
    }

    sessionPidFiles.set(entry, pidFile)
    sessions.push(entry)
  }

  return sessions
}

export function findSession(
  sessions: SessionEntry[],
  target: string,
): SessionEntry | undefined {
  const asNum = parseInt(target, 10)
  return sessions.find(
    s =>
      s.sessionId === target ||
      s.pid === asNum ||
      (s.name && s.name === target),
  )
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

/**
 * Resolve the engine type for an existing session.
 * Backward-compatible: sessions without an `engine` field are inferred
 * from the presence of `tmuxSessionName`.
 */
function resolveSessionEngine(session: SessionEntry): 'tmux' | 'detached' {
  if (session.engine) return session.engine
  return session.tmuxSessionName ? 'tmux' : 'detached'
}

/**
 * `claude daemon status` / `claude ps` — list live sessions.
 */
export async function psHandler(_args: string[]): Promise<void> {
  const sessions = await listLiveSessions()

  if (sessions.length === 0) {
    console.log('No active sessions.')
    await printTerminalJobs(sessions)
    return
  }

  console.log(
    `${sessions.length} active session${sessions.length > 1 ? 's' : ''}:\n`,
  )

  for (const s of sessions) {
    const engineType = resolveSessionEngine(s)
    const parts: string[] = [
      `  PID: ${s.pid}`,
      `  Kind: ${s.kind}`,
      `  Engine: ${engineType}`,
      `  Session: ${s.sessionId}`,
      `  CWD: ${s.cwd}`,
    ]

    if (s.name) parts.push(`  Name: ${s.name}`)
    if (s.startedAt) parts.push(`  Started: ${formatTime(s.startedAt)}`)
    if (s.status) parts.push(`  Status: ${s.status}`)
    if (s.waitingFor) parts.push(`  Waiting for: ${s.waitingFor}`)
    if (s.bridgeSessionId) parts.push(`  Bridge: ${s.bridgeSessionId}`)
    if (s.tmuxSessionName) parts.push(`  Tmux: ${s.tmuxSessionName}`)
    if (s.logPath) parts.push(`  Log: ${s.logPath}`)

    console.log(parts.join('\n'))
    console.log()
  }

  await printTerminalJobs(sessions)
}

/**
 * Sessions that are no longer running but still have a job record. Without
 * this they would be invisible and `rm` would have nothing discoverable to act
 * on.
 *
 * A record still marked `running` whose process is gone counts too: nothing
 * updates a job record when its session dies on its own (crash, machine
 * reboot), so filtering on state alone would hide exactly the records users
 * most need to clean up.
 */
async function printTerminalJobs(sessions: SessionEntry[]): Promise<void> {
  const jobs = (await listJobs()).filter(
    job =>
      job.state !== 'running' ||
      !sessions.some(session => isJobsOwnSession(job, session)),
  )
  if (jobs.length === 0) return

  console.log(`${jobs.length} stopped job${jobs.length > 1 ? 's' : ''}:\n`)
  for (const job of jobs) {
    const when = job.firstTerminalAt ? formatTime(job.firstTerminalAt) : '—'
    const detail = job.detail ? ` (${job.detail})` : ''
    const state = job.state === 'running' ? 'exited' : job.state
    console.log(`  ${job.name ?? job.jobId}  ${state}${detail}  ${when}`)
    if (job.sessionId) console.log(`    Session: ${job.sessionId}`)
  }
  console.log()
  console.log(`Remove one with \`${BIN_NAME} rm <name>\`.`)
}

/**
 * `claude daemon logs <target>` — show logs for a session.
 */
export async function logsHandler(target: string | undefined): Promise<void> {
  const sessions = await listLiveSessions()

  if (!target) {
    if (sessions.length === 0) {
      console.log('No active sessions.')
      return
    }
    if (sessions.length === 1) {
      target = sessions[0]!.sessionId
    } else {
      console.log('Multiple sessions active. Specify one:')
      for (const s of sessions) {
        const label = s.name ? `${s.name} (${s.sessionId})` : s.sessionId
        console.log(`  ${label}  PID=${s.pid}`)
      }
      return
    }
  }

  const session = findSession(sessions, target)
  if (!session) {
    console.error(`Session not found: ${target}`)
    process.exitCode = 1
    return
  }

  if (!session.logPath) {
    console.log(`No log path recorded for session ${session.sessionId}`)
    return
  }

  try {
    const content = await readFile(session.logPath, 'utf-8')
    process.stdout.write(content)
  } catch (e) {
    console.error(`Failed to read log file: ${session.logPath}`)
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
}

/**
 * `claude daemon attach <target>` — attach to a background session.
 *
 * Engine-aware: tmux sessions use tmux attach, detached sessions use log tail.
 */
export async function attachHandler(target: string | undefined): Promise<void> {
  const sessions = await listLiveSessions()

  if (!target) {
    // Find bg sessions (tmux or detached)
    const bgSessions = sessions.filter(
      s => s.tmuxSessionName || s.engine === 'detached',
    )
    if (bgSessions.length === 0) {
      console.log(
        `No background sessions to attach to. Start one with \`${BIN_NAME} daemon bg\`.`,
      )
      return
    }
    if (bgSessions.length === 1) {
      target = bgSessions[0]!.sessionId
    } else {
      console.log('Multiple background sessions. Specify one:')
      for (const s of bgSessions) {
        const label = s.name ? `${s.name} (${s.sessionId})` : s.sessionId
        const engineType = resolveSessionEngine(s)
        console.log(`  ${label}  PID=${s.pid}  engine=${engineType}`)
      }
      return
    }
  }

  const session = findSession(sessions, target)
  if (!session) {
    console.error(`Session not found: ${target}`)
    process.exitCode = 1
    return
  }

  const engineType = resolveSessionEngine(session)

  try {
    if (engineType === 'tmux') {
      const { TmuxEngine } = await import('./bg/engines/tmux.js')
      const tmux = new TmuxEngine()
      if (!(await tmux.available())) {
        console.error(
          'tmux is no longer available. Cannot attach to tmux session.',
        )
        process.exitCode = 1
        return
      }
      await tmux.attach(session)
    } else {
      const { DetachedEngine } = await import('./bg/engines/detached.js')
      const detached = new DetachedEngine()
      await detached.attach(session)
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
}

/**
 * Outcome of the shared termination ladder.
 *
 * `refused` means one of the PID-identity guards tripped; the caller must not
 * write a terminal job state, because the process it was told about may not be
 * the process it was talking to.
 */
type TerminationOutcome =
  | 'exited'
  | 'force-killed'
  | 'still-running'
  | 'refused'

/**
 * SIGTERM, grace period, then optionally SIGKILL — with the PID-reuse guards
 * that make it safe to send a signal at all.
 *
 * `stop` and `kill` share this on purpose. Official Claude Code makes `kill` a
 * literal alias of `stop` (one SIGTERM, no escalation); occ keeps the extra
 * rung because its registry can prove the PID has not been reused, so
 * escalation is a parameter rather than a second implementation.
 */
async function terminateSession(
  session: SessionEntry,
  options: { escalate: boolean; verb: string },
): Promise<TerminationOutcome> {
  const { escalate, verb } = options

  if (!session.processStartMarker) {
    console.error(
      `Refusing to ${verb} session ${session.sessionId}: its registry entry predates process identity checks.`,
    )
    console.error(`Restart the session before using ${BIN_NAME} ${verb}.`)
    process.exitCode = 1
    return 'refused'
  }

  const currentMarker = await getProcessStartMarker(session.pid)
  if (!currentMarker) {
    console.error(
      `Refusing to ${verb} session ${session.sessionId}: PID ${session.pid} could not be verified.`,
    )
    process.exitCode = 1
    return 'refused'
  }
  if (currentMarker !== session.processStartMarker) {
    console.error(
      `Refusing to ${verb} session ${session.sessionId}: PID ${session.pid} no longer matches the registered process.`,
    )
    process.exitCode = 1
    const pidFile = sessionPidFiles.get(session)
    if (pidFile) await removeSessionArtifacts(pidFile, session.logPath)
    return 'refused'
  }

  try {
    // Windows has no process groups: process.kill reaches only the session
    // process itself, orphaning whatever it spawned. tree-kill shells out to
    // `taskkill /T` there. It is also unconditionally forceful — but SIGTERM on
    // Windows is already TerminateProcess, so no graceful shutdown is being
    // given up; see the note before the SIGKILL escalation below.
    killProcessTree(session.pid, 'SIGTERM')
  } catch {
    console.log('Session already exited.')
    const pidFile = sessionPidFiles.get(session)
    if (pidFile) await removeSessionArtifacts(pidFile, session.logPath)
    return 'exited'
  }

  await new Promise(resolve => setTimeout(resolve, 2000))

  if (!isProcessRunning(session.pid)) {
    console.log('Session stopped.')
    const pidFile = sessionPidFiles.get(session)
    if (pidFile) await removeSessionArtifacts(pidFile, session.logPath)
    return 'exited'
  }

  const markerAfterGrace = await getProcessStartMarker(session.pid)
  if (!markerAfterGrace) {
    console.error(
      `Session ${session.sessionId} is still running, but its process identity could not be verified. Refusing to force-kill it.`,
    )
    process.exitCode = 1
    return 'refused'
  }
  if (markerAfterGrace !== session.processStartMarker) {
    console.error(
      `PID ${session.pid} was reused during shutdown. Refusing to force-kill the replacement process.`,
    )
    process.exitCode = 1
    const pidFile = sessionPidFiles.get(session)
    if (pidFile) await removeSessionArtifacts(pidFile, session.logPath)
    return 'refused'
  }

  if (!escalate) {
    // Graceful stop only. The session is still draining (MCP shutdown, final
    // transcript flush); saying so is more useful than escalating behind the
    // user's back, and `kill` is one command away.
    console.log(
      `Session ${session.sessionId} did not exit within the grace period. It may still be shutting down; use \`${BIN_NAME} kill ${session.sessionId}\` to force it.`,
    )
    return 'still-running'
  }

  try {
    killProcessTree(session.pid, 'SIGKILL')
    console.log('Session force-killed.')
  } catch {
    console.log('Session exited during grace period.')
  }

  const pidFile = sessionPidFiles.get(session)
  if (pidFile) await removeSessionArtifacts(pidFile, session.logPath)
  return 'force-killed'
}

/**
 * Job id for a session, derived from its launcher-assigned name
 * (`occ-bg-<8 hex>`). Sessions the user started by hand have no job id and
 * simply get no job record.
 */
function jobIdForSession(session: SessionEntry): string | undefined {
  return jobIdFromSessionName(session.name)
}

/**
 * Make sure a background session has a job record before writing a terminal
 * state to it. Adopts sessions that were started before the job store existed,
 * so `stop`/`rm` are not silently useless for anything already running.
 */
async function ensureJobRecord(
  session: SessionEntry,
  jobId: string,
): Promise<void> {
  const existing = await readJobRecord(jobId)
  if (existing.status !== 'missing') return
  await writeJob({
    jobId,
    state: 'running',
    tempo: 'active',
    name: session.name,
    sessionId: session.sessionId,
    pid: session.pid,
    cwd: session.cwd,
    logPath: session.logPath,
    engine: resolveSessionEngine(session),
    processStartMarker: session.processStartMarker,
    createdAt: session.startedAt,
  })
}

async function recordTermination(
  session: SessionEntry,
  detail: string,
): Promise<void> {
  const jobId = jobIdForSession(session)
  if (!jobId) return
  await ensureJobRecord(session, jobId)
  await markJobTerminal(jobId, { state: 'stopped', detail })
}

function printSessionChoices(header: string, sessions: SessionEntry[]): void {
  console.log(header)
  for (const s of sessions) {
    const label = s.name ? `${s.name} (${s.sessionId})` : s.sessionId
    console.log(`  ${label}  PID=${s.pid}`)
  }
}

/**
 * `claude daemon kill <target>` — kill a session, escalating to SIGKILL.
 */
export async function killHandler(target: string | undefined): Promise<void> {
  const sessions = await listLiveSessions()

  if (!target) {
    if (sessions.length === 0) {
      console.log('No active sessions to kill.')
      return
    }
    printSessionChoices('Specify a session to kill:', sessions)
    return
  }

  const session = findSession(sessions, target)
  if (!session) {
    console.error(`Session not found: ${target}`)
    process.exitCode = 1
    return
  }

  console.log(`Killing session ${session.sessionId} (PID: ${session.pid})...`)

  const outcome = await terminateSession(session, {
    escalate: true,
    verb: 'kill',
  })
  if (outcome === 'refused') return
  await recordTermination(session, 'killed')
}

/**
 * `occ stop <target>` — stop a session gracefully.
 *
 * Same guards as `kill`, one signal instead of two: the conversation is left
 * intact so `--resume` (or `occ agents`) can pick it back up, and the job
 * record keeps the session visible after its process is gone.
 */
export async function stopHandler(target: string | undefined): Promise<void> {
  const sessions = await listLiveSessions()

  if (!target) {
    if (sessions.length === 0) {
      console.log('No active sessions to stop.')
      return
    }
    printSessionChoices('Specify a session to stop:', sessions)
    return
  }

  const session = findSession(sessions, target)
  if (!session) {
    console.error(`Session not found: ${target}`)
    process.exitCode = 1
    return
  }

  console.log(`Stopping session ${session.sessionId} (PID: ${session.pid})...`)

  const outcome = await terminateSession(session, {
    escalate: false,
    verb: 'stop',
  })
  if (outcome === 'refused' || outcome === 'still-running') return
  await recordTermination(session, 'stopped')
  console.log(
    `Conversation kept. Resume it with \`${BIN_NAME} --resume ${session.sessionId}\`.`,
  )
}

/**
 * Resolve a user-supplied target to a job id without requiring the record to
 * be readable — `rm` must be able to name a corrupt record as corrupt rather
 * than reporting it as missing.
 */
async function resolveJobId(target: string): Promise<string | undefined> {
  const direct = isJobId(target) ? target : jobIdFromSessionName(target)
  if (direct && (await readJobRecord(direct)).status !== 'missing') {
    return direct
  }
  return (await findJob(target))?.jobId
}

/** Whether a live registry entry is the process this job started. */
function isJobsOwnSession(
  job: JobRecord | undefined,
  session: SessionEntry,
): boolean {
  if (!job) return false
  if (job.name !== undefined && session.name === job.name) return true
  return job.pid !== undefined && session.pid === job.pid
}

async function collectRemovalFacts(
  jobId: string,
  job: JobRecord | undefined,
  session: SessionEntry | undefined,
  jobs: JobRecord[],
): Promise<JobRemovalFacts> {
  const lock = await readJobLock(jobId)
  const facts: JobRemovalFacts = {
    jobId,
    recordReadable: job !== undefined,
    lockedByPid: lock && lock.pid !== process.pid ? lock.pid : undefined,
    processAlive: false,
  }
  if (!job) return facts

  // Prefer the live registry entry: it has already been identity-checked by
  // listLiveSessions. Fall back to probing the recorded PID directly, which is
  // the only way to notice a process whose registry file was removed.
  if (session) {
    facts.pid = session.pid
    facts.processAlive = true
    facts.recordedMarker = session.processStartMarker
    facts.currentMarker = await getProcessStartMarker(session.pid)
  } else if (job.pid && isProcessRunning(job.pid)) {
    facts.pid = job.pid
    facts.processAlive = true
    facts.recordedMarker = job.processStartMarker
    facts.currentMarker = await getProcessStartMarker(job.pid)
  }

  if (job.sessionId) {
    const claimant = (await listLiveSessions()).find(
      s => s.sessionId === job.sessionId && s.pid !== job.pid,
    )
    if (claimant) facts.claimedByPid = claimant.pid
  }

  const shared = jobs.find(
    other =>
      other.jobId !== jobId &&
      ((job.logPath !== undefined && other.logPath === job.logPath) ||
        (job.sessionId !== undefined && other.sessionId === job.sessionId)),
  )
  if (shared) facts.sharedWithJobId = shared.jobId

  return facts
}

/**
 * `occ rm <target>` — remove a background session's job record and its
 * launcher-managed log.
 *
 * Unlike `stop` this also works on sessions that already exited, and unlike
 * anything else in this file it deletes files chosen by user input. Both
 * halves of that are guarded: the refusal table below is transcribed from
 * official's `rm` (it refuses with a reason rather than forcing), and every
 * unlink goes through a path validator that requires a direct child of a
 * managed directory with a known filename shape.
 *
 * Transcripts are never touched — `rm` removes the bookkeeping, not the
 * conversation.
 */
export async function rmHandler(target: string | undefined): Promise<void> {
  if (!target) {
    const jobs = await listJobs()
    if (jobs.length === 0) {
      console.log('No background jobs recorded.')
      return
    }
    console.log('Specify a job to remove:')
    for (const job of jobs) {
      console.log(`  ${job.name ?? job.jobId}  state=${job.state}`)
    }
    return
  }

  const jobId = await resolveJobId(target)
  if (!jobId) {
    console.error(`No background job recorded for: ${target}`)
    console.error(
      `Only sessions started with \`${BIN_NAME} daemon bg\` or moved with \`/background\` have job records.`,
    )
    process.exitCode = 1
    return
  }

  const lock = await acquireJobLock(jobId)
  if (!lock) {
    const holder = await readJobLock(jobId)
    console.error(
      `Refusing to remove job ${jobId}: another ${BIN_NAME} process${
        holder ? ` (PID ${holder.pid})` : ''
      } is modifying it right now.`,
    )
    process.exitCode = 1
    return
  }

  try {
    const read = await readJobRecord(jobId)
    const job = read.status === 'ok' ? read.record : undefined
    const sessions = await listLiveSessions()
    // Deliberately identity fields only (launcher-assigned name, recorded
    // PID). Matching on sessionId as well would conflate "this job's own
    // process" with "some other session that has this conversation open" —
    // and the second one is the `in_use` refusal, which must not be silently
    // resolved by stopping the process it names.
    const live = job && sessions.find(s => isJobsOwnSession(job, s))

    const jobs = await listJobs()
    let decision = evaluateJobRemoval(
      await collectRemovalFacts(jobId, job, live, jobs),
    )

    // `occupied` is the one refusal official resolves rather than reports: a
    // live session is stopped first (gracefully — the point is to remove the
    // record, not to lose the conversation) and the decision is retaken. The
    // identity refusals are never resolved this way, which is why they are
    // evaluated before anything is signalled.
    if (!decision.ok && decision.reason === 'occupied' && live) {
      console.log(
        `Session ${live.sessionId} is still running; stopping it first...`,
      )
      const outcome = await terminateSession(live, {
        escalate: false,
        verb: 'stop',
      })
      if (outcome === 'exited') await recordTermination(live, 'stopped')
      const after = await listLiveSessions()
      const stillLive = after.find(s => isJobsOwnSession(job, s))
      decision = evaluateJobRemoval(
        await collectRemovalFacts(jobId, await readJob(jobId), stillLive, jobs),
      )
    }

    if (!decision.ok) {
      console.error(`Refusing to remove ${decision.message}`)
      process.exitCode = 1
      return
    }

    await removeManagedSessionLog(job?.logPath)
    const removed = await deleteJobRecord(jobId)
    if (!removed) {
      console.error(`Failed to remove job ${jobId}.`)
      process.exitCode = 1
      return
    }
    console.log(`Removed job ${job?.name ?? jobId}.`)
  } finally {
    await lock.release()
  }
}

/**
 * `claude daemon bg [args]` — start a background session.
 *
 * Cross-platform: uses TmuxEngine on macOS/Linux when tmux is available,
 * falls back to DetachedEngine on Windows or when tmux is absent.
 */
export async function handleBgStart(args: string[]): Promise<void> {
  const engine = await selectEngine()

  // Strip --bg/--background from args (for backward-compat shortcut)
  const filteredArgs = args.filter(a => a !== '--bg' && a !== '--background')

  // Engines without interactive TTY input (e.g. detached) require -p/--print
  // or piped input. Tmux provides a virtual terminal so it works without -p.
  if (
    !engine.supportsInteractiveInput &&
    !filteredArgs.some(a => a === '-p' || a === '--print' || a === '--pipe')
  ) {
    console.error(
      'Error: Background sessions with detached engine require -p/--print flag.\n' +
        'The detached engine has no terminal for interactive input.\n\n' +
        'Usage:\n' +
        `  ${BIN_NAME} daemon bg -p "your prompt here"\n` +
        `  echo "prompt" | ${BIN_NAME} daemon bg --pipe`,
    )
    if (process.platform !== 'win32') {
      console.error(
        '\nAlternatively, install tmux for interactive background sessions:\n' +
          `  ${process.platform === 'darwin' ? 'brew install tmux' : 'sudo apt install tmux'}`,
      )
    }
    process.exitCode = 1
    return
  }

  const jobId = randomUUID().slice(0, 8)
  const sessionName = `${BIN_NAME}-bg-${jobId}`
  const logPath = occConfigPath('sessions', 'logs', `${sessionName}.log`)

  try {
    const result = await engine.start({
      sessionName,
      args: filteredArgs,
      env: { ...process.env },
      logPath,
      cwd: process.cwd(),
    })

    // Written before the child has registered itself: the job record is what
    // keeps the session addressable by `stop`/`rm` even if it dies at boot.
    await writeJob({
      jobId,
      state: 'running',
      tempo: 'active',
      name: result.sessionName,
      pid: result.pid || undefined,
      cwd: process.cwd(),
      logPath: result.logPath,
      engine: result.engineUsed,
    })

    console.log(`Background session started: ${result.sessionName}`)
    console.log(`  Engine: ${result.engineUsed}`)
    console.log(`  Log: ${result.logPath}`)
    console.log()
    console.log(
      `Use \`${BIN_NAME} daemon attach ${result.sessionName}\` to reconnect.`,
    )
    console.log(`Use \`${BIN_NAME} daemon status\` to check status.`)
    console.log(
      `Use \`${BIN_NAME} daemon kill ${result.sessionName}\` to stop.`,
    )
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
}
