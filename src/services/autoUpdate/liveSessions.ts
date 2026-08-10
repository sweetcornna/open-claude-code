/**
 * Registry of live occ processes, keyed by pid and tagged with the dist root
 * each one runs from.
 *
 * Why this has to exist at all: occ ships as ~600 content-hashed chunks that
 * are `import()`ed lazily for the entire life of a session — that code split
 * is what keeps RSS at ~35MB instead of ~1GB (see CLAUDE.md, "不要把构建
 * 优化回单文件"). `npm|bun install -g` deletes the old package directory, and
 * roughly half the chunk filenames change between any two releases, so the
 * moment a new version lands every not-yet-loaded chunk of the *running*
 * session stops existing. Each later import then throws ERR_MODULE_NOT_FOUND
 * and the REPL wedges — that is how a background update used to leave a
 * session that could not even be exited with Ctrl+C.
 *
 * Official Claude Code gets away with in-place replacement because it ships a
 * single bundled file that is fully read at startup. occ cannot, so installs
 * are deferred until no session is reading from the tree being replaced.
 *
 * The registry is best-effort by design: a missing or unreadable entry only
 * costs a postponed update, never a broken session, so every failure path here
 * is swallowed.
 */
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, unlink } from 'node:fs/promises'
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
// Pid reuse
//
// `process.kill(pid, 0)` answers "does *a* process hold this pid", not "does
// *my* session still hold it". `-p` sessions are short-lived and numerous, and
// one killed hard enough to skip cleanup (SIGKILL, OOM, a closed terminal)
// leaves its lease behind. When the OS eventually recycles that pid onto an
// unrelated process, the stale lease starts reading as a permanently live
// session and auto-updates for that dist root stop for good — silently, since
// every failure path in this file is swallowed by design.
//
// A lease therefore records *when* the process it describes started. A pid
// whose real start time is materially later than the recorded one is a
// different process wearing the same number.
//
// The comparison is deliberately one-directional and tolerant. A false
// "recycled" verdict prunes a live session's lease and lets an install replace
// the tree it is still importing chunks from — the exact accident this registry
// exists to prevent — so anything ambiguous (no recorded time, no probe, a
// start time *earlier* than recorded, a platform without `ps`) counts as alive.
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
 * exit instead, once the impostor is more than a minute old. Recycling requires
 * the pid space to wrap onto this exact number, so nothing plausible fits
 * inside the window and then disappears.
 */
const PID_REUSE_TOLERANCE_MS = 60_000

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
 * never "dead" — the caller treats unknown as alive.
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
  // entries means "unknown", which the caller reads as alive. Same safe
  // direction as a missing `ps` — never prune a lease on a bad reading.
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
    // Unknown start times must not decide anything: fall back to "the pid
    // resolves, so the session is alive", which is what this file did before
    // reuse detection existed.
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

type LeaseRecord = { distRoot: string; startedAt?: number }

/**
 * Leases used to be the bare dist root. That spelling is still read, without a
 * start time, so a session registered by the previous build keeps blocking
 * installs for as long as it runs.
 */
function parseLease(contents: string): LeaseRecord {
  const trimmed = contents.trim()
  if (!trimmed.startsWith('{')) return { distRoot: trimmed }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const startedAt = parsed.startedAt
    return {
      distRoot: typeof parsed.distRoot === 'string' ? parsed.distRoot : '',
      startedAt:
        typeof startedAt === 'number' && Number.isFinite(startedAt)
          ? startedAt
          : undefined,
    }
  } catch {
    return { distRoot: trimmed }
  }
}

function leasePayload(): string {
  return JSON.stringify({
    schemaVersion: 1,
    distRoot,
    startedAt: processStartedAtMs(),
  })
}

let registered = false
let registrationPromise: Promise<void> | undefined
let unregisterCleanup: (() => void) | undefined
let exitHandler: (() => Promise<void>) | undefined

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

/**
 * Run `handler` at exit, after this session's lease is removed.
 *
 * Separate from registration because the two have different audiences. *Every*
 * process registers — including `--print`, whose whole job is to be visible to
 * the sessions that do update, so they postpone replacing the tree it is
 * reading from. Only an interactive session attaches the handoff, because only
 * it should ever spawn an installer. Attaching is therefore allowed after
 * registration, once the entrypoint knows which kind of session this is.
 */
export function setLiveSessionExitHandler(handler: () => Promise<void>): void {
  exitHandler = handler
}

/**
 * Announce this process before it starts long-lived work. Cleanup removes this
 * lease before trying a persisted deferred install, so the last session exits
 * with an empty registry and can safely take over another session's update.
 */
export async function registerLiveSession(
  afterUnregister?: () => Promise<void>,
): Promise<void> {
  if (afterUnregister) setLiveSessionExitHandler(afterUnregister)
  if (registered) return
  if (registrationPromise) return registrationPromise

  registrationPromise = (async () => {
    const entryPath = join(liveSessionsDir(), String(process.pid))
    await mkdir(liveSessionsDir(), { recursive: true, mode: 0o700 })
    await writePrivateFileAtomic(entryPath, leasePayload())
    registered = true
    unregisterCleanup = registerCleanup(async () => {
      await unregisterLiveSession()
      // Read at exit, not at registration: the interactive path attaches this
      // after rootAction has ruled out --print.
      const handler = exitHandler
      if (!handler) return
      try {
        await handler()
      } catch (error) {
        logForDebugging(
          `liveSessions: deferred install handoff failed: ${error}`,
        )
      }
    })
  })()

  try {
    await registrationPromise
  } catch (error) {
    registrationPromise = undefined
    throw error
  }
}

/**
 * Whether another live process is running from the same dist root as this one.
 *
 * Prunes entries for pids that are gone, so a crashed session cannot block
 * updates permanently. Only the dist root matters: a `bun run dev` checkout
 * running alongside a global install is unaffected by replacing that install,
 * and vice versa.
 */
export async function hasOtherLiveSessions(): Promise<boolean> {
  let entries: string[]
  try {
    entries = await readdir(liveSessionsDir())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    // An unreadable registry cannot prove that replacing the install tree is safe.
    return true
  }

  const resolved: {
    pid: number
    path: string
    lease: LeaseRecord | undefined
  }[] = []
  await Promise.all(
    entries.map(async name => {
      const pid = Number(name)
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
        return
      }
      const entryPath = join(liveSessionsDir(), name)
      if (!isProcessAlive(pid)) {
        await pruneEntry(entryPath)
        return
      }
      try {
        resolved.push({
          pid,
          path: entryPath,
          lease: parseLease(await readFile(entryPath, 'utf8')),
        })
      } catch {
        // A live pid with an unreadable lease must block a destructive install.
        resolved.push({ pid, path: entryPath, lease: undefined })
      }
    }),
  )

  // One `ps` for every lease that recorded a start time, and only when there is
  // something to check — the common case (no peer sessions) spawns nothing.
  const startTimes = await probeStartTimes(
    resolved
      .filter(entry => entry.lease?.startedAt !== undefined)
      .map(entry => entry.pid),
  )

  let foundOther = false
  await Promise.all(
    resolved.map(async entry => {
      if (isRecycledPid(entry.lease?.startedAt, startTimes.get(entry.pid))) {
        logForDebugging(
          `liveSessions: pruning lease for recycled pid ${entry.pid}`,
        )
        await pruneEntry(entry.path)
        return
      }
      if (!entry.lease || entry.lease.distRoot === distRoot) {
        foundOther = true
      }
    }),
  )
  return foundOther
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
  registrationPromise = undefined
  registered = false
  exitHandler = undefined
  setProcessStartTimeProbeForTests()
}
