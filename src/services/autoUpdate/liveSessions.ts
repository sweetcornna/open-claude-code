/**
 * Registry of live occ processes, keyed by pid and tagged with the dist root
 * each one runs from.
 *
 * WHAT IT IS FOR NOW
 *
 * It used to gate self-installs: occ ships ~612 content-hashed chunks that are
 * `import()`ed lazily for the whole life of a session, `install -g` replaces
 * the package directory, and roughly half those filenames change between
 * releases — so installing while any session was still reading from that tree
 * stranded it. Sessions therefore had to wait for each other.
 *
 * That constraint is gone: a session now runs from a private hard-link farm
 * under `<config>/runtime/` that no package manager touches (see
 * runtimeFarm.ts), so installs happen immediately and this registry no longer
 * decides anything about updates.
 *
 * What it decides instead is which farms are still in use. A farm holds the
 * only remaining links to a replaced build's inodes, so reclaiming one that a
 * live session is still importing from resurrects the exact wedge the farm was
 * built to prevent. runtimeFarmGc.ts asks this module which dist roots are
 * live; everything below exists to make that answer trustworthy.
 *
 * The registry is best-effort by design: a missing or unreadable entry only
 * costs a postponed cleanup, never a broken session, so every failure path
 * here is swallowed.
 */
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { occConfigPath } from 'src/config/paths.js'
import { distRoot } from 'src/utils/filesystem/distRoot.js'
import { registerCleanup } from 'src/utils/process/cleanupRegistry.js'
import { writePrivateFileAtomic } from 'src/utils/secureStorage/atomicWrite.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'

/**
 * `execFile`, promised by hand rather than through `util.promisify`.
 *
 * `promisify` does not read the callback signature; it looks for a
 * `[util.promisify.custom]` symbol on the callee, and only that symbol makes
 * `execFile` resolve to `{ stdout, stderr }` instead of the bare first callback
 * argument. Any wrapper that replaces `execFile` without forwarding the symbol
 * silently changes the resolved shape, and `const { stdout } = ...` then
 * destructures a string into `undefined`.
 *
 * That is not hypothetical: `mock.module('node:child_process', …)` is
 * process-global and `node:*` specifiers are exempt from the mock-hygiene
 * check, so a wrapper installed by any test file in the same `bun test` run
 * reaches this module — and one of them does not forward the symbol. The
 * callback contract below is the stable part of the interface, so using it
 * directly removes the whole failure mode instead of guessing at the shape.
 */
function execFileText(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout) => {
      if (error) reject(error)
      else resolve(typeof stdout === 'string' ? stdout : String(stdout ?? ''))
    })
  })
}

function liveSessionsDir(): string {
  return occConfigPath('live-sessions')
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the pid exists but belongs to another user — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// ---------------------------------------------------------------------------
// Staleness
//
// `process.kill(pid, 0)` answers "does *a* process hold this pid", not "does
// *my* session still hold it". `-p` sessions are short-lived and numerous, and
// one killed hard enough to skip cleanup (SIGKILL, OOM, a closed terminal)
// leaves its lease behind. When the OS eventually recycles that pid onto an
// unrelated process, the stale lease starts reading as a permanently live
// session — silently, since every failure path in this file is swallowed.
//
// Two independent answers to that, because neither works everywhere:
//
//   start time  a lease records when the process it describes started, and a
//               pid whose real start time is materially later is a different
//               process wearing the same number. Exact, but it needs `ps`, and
//               readProcessStartTimes returns nothing on win32 — the one
//               platform where pids recycle fast enough to matter. Before the
//               TTL below, that meant reuse detection was simply *off* on
//               Windows and a recycled pid read as a live occ session forever.
//
//   TTL         a live session rewrites its lease every
//               LEASE_HEARTBEAT_INTERVAL_MS. A lease nobody has refreshed
//               inside LEASE_TTL_MS is stale no matter what the pid says, so
//               staleness stops depending on a probe some platforms cannot
//               run.
//
// The start time wins when it is available, and the TTL is consulted only when
// the probe cannot decide. That order matters: timers stop while a laptop
// sleeps, so after a long suspend every lease looks expired — but on a
// platform with `ps` we can still see that the process is the same one that
// registered, and a verified-live session must never be pruned. On win32 there
// is nothing better, so a suspend longer than the TTL can prune a live lease;
// the cost is bounded to a farm being reclaimed early, which surfaces as
// gracefulShutdown's "restart occ" message rather than a silent wedge.
//
// Everything ambiguous counts as alive.
// ---------------------------------------------------------------------------

/**
 * Slack between the recorded start time and what `ps` implies.
 *
 * Sized against the failure that matters. Both numbers are wall-clock, derived
 * at different moments, so a clock step between registration and this check
 * shows up as a discrepancy; a forward step larger than this window would prune
 * a live session's lease. A minute is well past any realistic NTP correction
 * (steps are rare, and slewing produces no jump at all), while costing almost
 * nothing in the other direction: a recycled pid is simply detected on a later
 * sweep instead, once the impostor is more than a minute old. Recycling
 * requires the pid space to wrap onto this exact number, so nothing plausible
 * fits inside the window and then disappears.
 */
const PID_REUSE_TOLERANCE_MS = 60_000

/** How often a live session rewrites its own lease. */
export const LEASE_HEARTBEAT_INTERVAL_MS = 5 * 60_000

/**
 * How long a lease survives without a heartbeat.
 *
 * Six missed beats. Generous because the penalty for being wrong is asymmetric:
 * an over-long TTL leaks one farm's worth of disk until the next sweep, while
 * an over-short one can reclaim a farm a live session is still importing from.
 */
export const LEASE_TTL_MS = 30 * 60_000

type ProcessStartTimeProbe = (pids: number[]) => Promise<Map<number, number>>

/** Wall-clock ms at which this process started. */
function processStartedAtMs(): number {
  return Math.round(Date.now() - process.uptime() * 1000)
}

/** `[[dd-]hh:]mm:ss`, the one format `ps` prints elapsed time in. */
function parseElapsedMs(value: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim())
  if (!match?.[3] || !match[4]) return undefined
  const days = Number(match[1] ?? 0)
  const hours = Number(match[2] ?? 0)
  return (
    ((days * 24 + hours) * 60 + Number(match[3])) * 60_000 +
    Number(match[4]) * 1000
  )
}

/**
 * Start times for `pids`, as one `ps` call. Absent entries mean "unknown",
 * never "dead" — the caller falls back to the TTL for those.
 *
 * Derived from `etime` (elapsed) rather than `lstart` (an absolute timestamp)
 * because `lstart` prints local time with no offset, and whether `Date.parse`
 * reads that back as local or UTC depends on the runtime and the environment.
 * Under `bun test` here the two disagreed by a full timezone — seven hours of
 * phantom discrepancy, in the direction that prunes a live session's lease.
 * Elapsed time has no such ambiguity, and `etime` is spelled the same on BSD
 * (darwin) and procps (linux), unlike the linux-only `etimes`.
 */
async function readProcessStartTimes(
  pids: number[],
): Promise<Map<number, number>> {
  const startTimes = new Map<number, number>()
  if (pids.length === 0 || process.platform === 'win32') return startTimes
  const stdout = await execFileText(
    'ps',
    ['-o', 'pid=,etime=', '-p', pids.join(',')],
    2000,
  )
  const sampledAt = Date.now()
  // A `ps` that answered with something unparseable yields no entries, and no
  // entries means "unknown", which hands the decision to the TTL. Same safe
  // direction as a missing `ps` — never prune a lease on a bad reading alone.
  if (!stdout) return startTimes
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line)
    if (!match?.[1] || !match[2]) continue
    const elapsedMs = parseElapsedMs(match[2])
    if (elapsedMs !== undefined) {
      startTimes.set(Number(match[1]), sampledAt - elapsedMs)
    }
  }
  return startTimes
}

let startTimeProbe: ProcessStartTimeProbe = readProcessStartTimes

/** Deterministic start times for tests; `undefined` restores the real probe. */
export function setProcessStartTimeProbeForTests(
  probe?: ProcessStartTimeProbe,
): void {
  startTimeProbe = probe ?? readProcessStartTimes
}

/** The real probe, so a test can check it against a known-live process. */
export const readProcessStartTimesForTests = readProcessStartTimes

async function probeStartTimes(pids: number[]): Promise<Map<number, number>> {
  if (pids.length === 0) return new Map()
  try {
    return await startTimeProbe(pids)
  } catch (error) {
    // Unknown start times must not decide anything on their own: fall through
    // to the TTL, which does not need a subprocess.
    logForDebugging(`liveSessions: start-time probe failed: ${error}`)
    return new Map()
  }
}

function isRecycledPid(
  recordedStartedAt: number | undefined,
  actualStartedAt: number | undefined,
): boolean {
  if (recordedStartedAt === undefined || actualStartedAt === undefined) {
    return false
  }
  return actualStartedAt > recordedStartedAt + PID_REUSE_TOLERANCE_MS
}

type LeaseRecord = {
  distRoot: string
  startedAt?: number
  /** Last heartbeat, wall-clock ms. Absent on leases from older builds. */
  renewedAt?: number
}

/**
 * Leases used to be the bare dist root. That spelling is still read, without a
 * start time, so a session registered by the previous build keeps its farm
 * (which is the install tree, since that build never farmed) for as long as it
 * runs — or until the TTL retires it, using the file's mtime as its only
 * heartbeat.
 */
function parseLease(contents: string): LeaseRecord {
  const trimmed = contents.trim()
  if (!trimmed.startsWith('{')) return { distRoot: trimmed }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    return {
      distRoot: typeof parsed.distRoot === 'string' ? parsed.distRoot : '',
      startedAt: finiteNumber(parsed.startedAt),
      renewedAt: finiteNumber(parsed.renewedAt),
    }
  } catch {
    return { distRoot: trimmed }
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function leasePayload(): string {
  return JSON.stringify({
    schemaVersion: 2,
    distRoot,
    startedAt: processStartedAtMs(),
    renewedAt: Date.now(),
  })
}

let registered = false
let registrationPromise: Promise<void> | undefined
let unregisterCleanup: (() => void) | undefined
let heartbeatTimer: ReturnType<typeof setInterval> | undefined

async function unregisterLiveSession(): Promise<void> {
  try {
    await unlink(join(liveSessionsDir(), String(process.pid)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logForDebugging(
        `liveSessions: could not unregister ${process.pid}: ${error}`,
      )
    }
  }
  registered = false
}

function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = undefined
}

/**
 * Keep this session's lease fresh so peers can tell it apart from the leftover
 * of a SIGKILLed one. Unref'd: a heartbeat must never be the reason a process
 * stays alive.
 */
function startHeartbeat(entryPath: string, intervalMs: number): void {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    void writePrivateFileAtomic(entryPath, leasePayload()).catch(error => {
      logForDebugging(`liveSessions: heartbeat failed: ${error}`)
    })
  }, intervalMs)
  heartbeatTimer.unref()
}

/**
 * Announce this process before it starts long-lived work.
 *
 * *Every* process registers — `--print` included: the point is to be visible
 * to whichever session next sweeps the runtime farms, so the tree this one is
 * importing chunks from is not reclaimed underneath it.
 */
export async function registerLiveSession(options?: {
  /** Heartbeat period; tests use a short one. */
  heartbeatIntervalMs?: number
}): Promise<void> {
  if (registered) return
  if (registrationPromise) return registrationPromise

  registrationPromise = (async () => {
    const entryPath = join(liveSessionsDir(), String(process.pid))
    await mkdir(liveSessionsDir(), { recursive: true, mode: 0o700 })
    await writePrivateFileAtomic(entryPath, leasePayload())
    registered = true
    startHeartbeat(
      entryPath,
      options?.heartbeatIntervalMs ?? LEASE_HEARTBEAT_INTERVAL_MS,
    )
    unregisterCleanup = registerCleanup(async () => {
      stopHeartbeat()
      await unregisterLiveSession()
    })
  })()

  try {
    await registrationPromise
  } catch (error) {
    registrationPromise = undefined
    throw error
  }
}

type ResolvedLease = {
  pid: number
  path: string
  lease: LeaseRecord | undefined
  /** Heartbeat, or the file's mtime for leases written by older builds. */
  lastSeenAt: number | undefined
}

async function resolveLease(name: string): Promise<ResolvedLease | undefined> {
  const pid = Number(name)
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const entryPath = join(liveSessionsDir(), name)
  if (!isProcessAlive(pid)) {
    await pruneEntry(entryPath)
    return undefined
  }
  try {
    const lease = parseLease(await readFile(entryPath, 'utf8'))
    return {
      pid,
      path: entryPath,
      lease,
      // Only leases from before the heartbeat existed need the extra stat.
      lastSeenAt: lease.renewedAt ?? (await fileMtimeMs(entryPath)),
    }
  } catch {
    // A live pid with an unreadable lease is treated as live: it may well be
    // reading from a farm, and reclaiming that farm is the expensive mistake.
    return { pid, path: entryPath, lease: undefined, lastSeenAt: undefined }
  }
}

async function fileMtimeMs(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

function isExpired(lastSeenAt: number | undefined, now: number): boolean {
  if (lastSeenAt === undefined) return false
  return now - lastSeenAt > LEASE_TTL_MS
}

/**
 * What {@link getLiveSessionDistRoots} could establish.
 *
 * `complete: false` means at least one live session's tree could not be
 * identified, so the set is not a licence to delete anything. Callers that
 * reclaim disk must treat it as "keep everything" — an unreadable registry is
 * not evidence that a tree is unused.
 */
export type LiveSessionRoots = { roots: Set<string>; complete: boolean }

/**
 * Dist roots that live occ processes are running from, pruning leases that are
 * provably stale on the way through.
 *
 * Includes this process's own root: the caller is deciding what may be
 * deleted, and "the tree I am running from" is the first thing that may not.
 */
export async function getLiveSessionDistRoots(): Promise<LiveSessionRoots> {
  const roots = new Set<string>([distRoot])
  let complete = true
  let entries: string[]
  try {
    entries = await readdir(liveSessionsDir())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { roots, complete }
    }
    logForDebugging(`liveSessions: registry unreadable: ${error}`)
    return { roots, complete: false }
  }

  const resolved = (await Promise.all(entries.map(resolveLease))).filter(
    (entry): entry is ResolvedLease => entry !== undefined,
  )

  // One `ps` for every live lease, and only when there is something to check —
  // a lone session spawns nothing.
  const startTimes = await probeStartTimes(resolved.map(entry => entry.pid))
  const now = Date.now()

  await Promise.all(
    resolved.map(async entry => {
      const actualStartedAt = startTimes.get(entry.pid)
      const recycled = isRecycledPid(entry.lease?.startedAt, actualStartedAt)
      // The probe answering at all proves this is the same process, whatever
      // the heartbeat says — see the staleness note above on laptop suspend.
      const identified =
        entry.lease?.startedAt !== undefined && actualStartedAt !== undefined
      if (recycled || (!identified && isExpired(entry.lastSeenAt, now))) {
        logForDebugging(
          `liveSessions: pruning stale lease for pid ${entry.pid}`,
        )
        await pruneEntry(entry.path)
        return
      }
      if (!entry.lease) {
        complete = false
        return
      }
      roots.add(entry.lease.distRoot)
    }),
  )
  return { roots, complete }
}

async function pruneEntry(entryPath: string): Promise<void> {
  try {
    await unlink(entryPath)
  } catch {
    // Another session pruned it first.
  }
}

export function resetLiveSessionsForTests(): void {
  unregisterCleanup?.()
  unregisterCleanup = undefined
  stopHeartbeat()
  registrationPromise = undefined
  registered = false
  setProcessStartTimeProbeForTests()
}
