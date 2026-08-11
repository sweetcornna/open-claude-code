/**
 * Reclaim runtime farms nothing is running from any more.
 *
 * Every installed version gets its own farm under `<config>/runtime/` (see
 * runtimeFarm.ts). While the package directory is intact a farm is free — the
 * files are hard links to the same inodes — but the moment `install -g`
 * replaces that directory the farm holds the *only* remaining links, so an
 * abandoned one is a real ~30MB on disk. Left unswept they accumulate one per
 * release forever.
 *
 * Deleting the wrong one resurrects the failure the farm exists to prevent: a
 * session still lazily importing chunks out of it would start throwing
 * ERR_MODULE_NOT_FOUND. Every rule below is therefore biased toward keeping.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { occConfigPath } from 'src/config/paths.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import { distRoot } from 'src/utils/filesystem/distRoot.js'
import {
  getLiveSessionDistRoots,
  type LiveSessionRoots,
} from './liveSessions.js'
import { runtimeFarmDirForDistRoot, runtimeFarmsRoot } from './runtimeFarm.js'

/**
 * How long a farm must have existed before it can be reclaimed.
 *
 * Closes the window between "a starting session created a farm" and "that
 * session registered its live-session lease": for those few hundred
 * milliseconds the farm is in use by a process no registry knows about yet.
 * An hour costs nothing — a farm that is genuinely dead is dead for good, and
 * the next session sweeps it.
 */
const FARM_GRACE_MS = 60 * 60_000

/** Delay before the one sweep per session. */
const RUNTIME_FARM_GC_DELAY_MS = 90 * 1000

export type RuntimeFarmGcDeps = {
  liveRoots: () => Promise<LiveSessionRoots>
  now: () => number
  /** The tree this process is running from; never reclaimed. */
  currentDistRoot: string
}

function defaultDeps(): RuntimeFarmGcDeps {
  return {
    liveRoots: getLiveSessionDistRoots,
    now: Date.now,
    currentDistRoot: distRoot,
  }
}

/**
 * Guard against ever handing `rm -rf` a path this module did not derive.
 *
 * The sweep deletes directory trees inside the user's config dir, so the one
 * mistake that must be impossible is a path that escaped the farms root — a
 * traversal in a directory name, a symlinked entry, a refactor that passes the
 * wrong variable.
 */
function isReclaimablePath(farmsRoot: string, candidate: string): boolean {
  const target = resolve(candidate)
  const name = basename(target)
  if (name === '' || name === '.' || name === '..') return false
  return dirname(target) === resolve(farmsRoot)
}

/**
 * The retired persisted-candidate directory.
 *
 * Deferred installs used to leave a JSON candidate per discovered version in
 * `<config>/pending-updates/`, and nothing ever pruned them: `isPersistedInstall`
 * refuses any candidate whose `distRoot` is not the current one, so entries
 * written by a dev checkout (or by any tree that has since moved) could never
 * match and could never be consumed. Real machines accumulated dead candidates
 * plus leaked `.tmp` files from interrupted atomic writes. The mechanism is
 * gone — installs are immediate now — so the directory is swept once, here,
 * rather than left as permanent litter in every existing install.
 */
async function removeRetiredPendingUpdates(): Promise<void> {
  try {
    await rm(occConfigPath('pending-updates'), {
      recursive: true,
      force: true,
    })
  } catch (error) {
    logForDebugging(`runtimeFarmGc: pending-updates cleanup failed: ${error}`)
  }
}

/**
 * One sweep. Returns the farms it removed, for tests and debug logging.
 *
 * Never throws: reclaiming disk is the least important thing this process
 * does.
 */
export async function runRuntimeFarmGc(
  deps?: RuntimeFarmGcDeps,
): Promise<string[]> {
  const removed: string[] = []
  try {
    const d = deps ?? defaultDeps()
    await removeRetiredPendingUpdates()

    const farmsRoot = runtimeFarmsRoot()
    let entries: string[]
    try {
      entries = await readdir(farmsRoot)
    } catch (error) {
      // No farms root at all is the normal state for a dev checkout.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logForDebugging(`runtimeFarmGc: ${error}`)
      }
      return removed
    }

    const live = await d.liveRoots()
    if (!live.complete) {
      // A live session exists whose tree we could not identify. Keeping every
      // farm costs disk; guessing costs somebody's session.
      logForDebugging('runtimeFarmGc: skipped — live-session set is incomplete')
      return removed
    }

    const inUse = new Set<string>()
    for (const root of live.roots) {
      const farm = runtimeFarmDirForDistRoot(root)
      if (farm) inUse.add(farm)
    }
    const currentFarm = runtimeFarmDirForDistRoot(d.currentDistRoot)
    if (currentFarm) inUse.add(currentFarm)

    const now = d.now()
    for (const name of entries) {
      const candidate = join(farmsRoot, name)
      if (!isReclaimablePath(farmsRoot, candidate)) continue
      if (inUse.has(resolve(candidate))) continue

      let mtimeMs: number
      try {
        const info = await stat(candidate)
        if (!info.isDirectory()) continue
        mtimeMs = info.mtimeMs
      } catch {
        continue
      }
      // Applies to half-built `.staging-*` leftovers too: a crash mid-populate
      // leaves one behind, but so does a session that is populating right now.
      if (now - mtimeMs < FARM_GRACE_MS) continue

      try {
        await rm(candidate, { recursive: true, force: true })
        removed.push(candidate)
      } catch (error) {
        logForDebugging(
          `runtimeFarmGc: could not remove ${candidate}: ${error}`,
        )
      }
    }

    if (removed.length > 0) {
      logForDebugging(`runtimeFarmGc: reclaimed ${removed.length} farm(s)`)
    }
  } catch (error) {
    logForDebugging(`runtimeFarmGc: ${error}`)
  }
  return removed
}

let scheduledThisSession = false

type RuntimeFarmGcScheduleFn = (
  callback: () => Promise<void>,
  delayMs: number,
) => { unref: () => void }

/**
 * Install the once-per-session sweep.
 *
 * Deliberately not wired into the background update loop: farms are created by
 * every launch, including ones where auto-updates are switched off, so tying
 * the sweep to the updater's gates would let `DISABLE_AUTOUPDATER=1` users
 * accumulate a farm per manual `occ update` forever. Delayed and unref'd for
 * the same reason as every other background job — startup is the busiest
 * moment in the process, and nothing here is worth holding it open.
 */
export function scheduleRuntimeFarmGc(options?: {
  delayMs?: number
  run?: () => Promise<unknown>
  scheduleFn?: RuntimeFarmGcScheduleFn
}): boolean {
  if (scheduledThisSession) return false
  scheduledThisSession = true
  const run = options?.run ?? (() => runRuntimeFarmGc())
  const scheduleFn: RuntimeFarmGcScheduleFn =
    options?.scheduleFn ??
    ((callback, delayMs) =>
      setTimeout(() => {
        void callback()
      }, delayMs))
  const timer = scheduleFn(async () => {
    await run()
  }, options?.delayMs ?? RUNTIME_FARM_GC_DELAY_MS)
  timer.unref()
  return true
}

export function resetRuntimeFarmGcForTests(): void {
  scheduledThisSession = false
}
