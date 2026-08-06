/**
 * Silent background self-update for interactive sessions.
 *
 * Official Claude Code quietly keeps the global install fresh while a session
 * runs; occ restores that behavior for its own package only
 * (`@sweetcornna/open-claude-code`). The isolation contract in
 * src/cli/__tests__/updateIsolation.test.ts stays authoritative: this chain
 * must never touch the official CLI's package, paths, or commands.
 *
 * Timeline: rootAction installs one recursive, unref'd timer loop per session,
 * first firing a minute past startup and every 30 minutes after. Each run
 * completes before the next is scheduled. The check reuses the `occ update`
 * chain up to the comparison (npm view → compare) and then stops: the install
 * itself is queued for after the session exits, see deferredOccInstall.ts for
 * why installing in place wedges the running REPL. A queued update surfaces as
 * one low-key REPL notification via updateNotifier; every failure path is
 * logForDebugging-only and never interrupts the session.
 *
 * Hard gates — all must pass, re-checked when the timer fires:
 *  - NODE_ENV is not test/development
 *  - DISABLE_AUTOUPDATER unset and no essential-traffic-only env var
 *  - globalConfig.autoUpdates !== false
 *  - the running copy is a global install: npm-global per doctorDiagnostic,
 *    or resolving into bun's global tree. Source checkouts, npm-local and
 *    package-manager (brew etc.) installs never auto-update.
 */
import { isEnvTruthy } from 'src/utils/config/envUtils.js'
import { registerCleanup } from 'src/utils/process/cleanupRegistry.js'
import type { InstallationType } from 'src/utils/runtime/doctorDiagnostic.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import { gt } from 'src/utils/text/semver.js'
import * as updateInterval from './backgroundUpdateInterval.js'
import {
  armDeferredOccInstall,
  type DeferredOccInstall,
} from './deferredOccInstall.js'
import { emitBackgroundUpdateNotification } from './updateNotifier.js'

/**
 * Delay before the first check. Short on purpose — a session that starts right
 * after a release should not wait out a full interval to find it — but not
 * zero: startup is the busiest moment in the process and an `npm view` there
 * competes with everything the user is actually waiting for.
 */
const BACKGROUND_UPDATE_DELAY_MS = 60 * 1000
const CHECK_THROTTLE_RATIO = 0.9

type ClaimCheck = (checkedAt: number, minElapsedMs: number) => boolean

export type BackgroundOccUpdateDeps = {
  env: NodeJS.ProcessEnv
  /** globalConfig.autoUpdates — only an explicit `false` disables. */
  getAutoUpdatesConfig: () => boolean | undefined
  getEssentialTrafficOnlyReason: () => string | null
  getInstallationType: () => Promise<InstallationType>
  isBunGlobalInstall: () => boolean
  getCurrentVersion: () => string
  /** `signal` cancels the spawned `npm view` when the session is shutting down. */
  getLatestVersion: (signal?: AbortSignal) => Promise<string | null>
  /** Queue the install for after this session exits. */
  armInstall: (install: DeferredOccInstall) => void
  packageSpec: () => string
  acquireLock: () => Promise<boolean>
  notify: (text: string) => void
  now: () => number
  claimUpdateCheck: ClaimCheck
}

export type BackgroundOccUpdateOutcome =
  /**
   * `permanent` distinguishes a skip that can never resolve inside this
   * process (NODE_ENV, installation type) from one the user can undo mid-session
   * (`/config` toggling autoUpdates, a settings `env` change). Only the former
   * stops the loop; treating every skip as final meant turning auto-updates
   * back on had no effect until the next launch.
   */
  | { status: 'skipped'; reason: string; permanent: boolean }
  | { status: 'throttled' }
  | { status: 'up-to-date'; version: string }
  | { status: 'check-failed' }
  /** Newer version found and handed to deferredOccInstall for exit time. */
  | { status: 'queued'; version: string }
  | { status: 'error' }

/**
 * Default deps are loaded lazily so that importing this module (rootAction
 * does it dynamically; Notifications.tsx only imports updateNotifier.ts)
 * never drags the update chain into startup, and so tests can exercise the
 * full flow through injected deps without process-global mock.module calls.
 */
async function loadDefaultDeps(): Promise<BackgroundOccUpdateDeps> {
  const [updateOcc, autoUpdater, config, doctor, privacy] = await Promise.all([
    import('src/cli/updateOcc.js'),
    import('src/utils/update/autoUpdater.js'),
    import('src/utils/config/config.js'),
    import('src/utils/runtime/doctorDiagnostic.js'),
    import('src/utils/auth/privacyLevel.js'),
  ])
  return {
    env: process.env,
    getAutoUpdatesConfig: () => config.getGlobalConfig().autoUpdates,
    getEssentialTrafficOnlyReason: privacy.getEssentialTrafficOnlyReason,
    getInstallationType: doctor.getCurrentInstallationType,
    isBunGlobalInstall: updateOcc.isRunningFromBunGlobalInstall,
    getCurrentVersion: updateOcc.getCurrentOccVersion,
    getLatestVersion: updateOcc.getLatestOccVersion,
    armInstall: armDeferredOccInstall,
    packageSpec: updateOcc.latestPackageSpec,
    acquireLock: autoUpdater.acquireUpdateLock,
    notify: emitBackgroundUpdateNotification,
    now: Date.now,
    claimUpdateCheck: (checkedAt, minimumElapsedMs) => {
      let claimed = false
      config.saveGlobalConfig(current => {
        const previous = current.lastBackgroundUpdateCheckAt
        const isRecent =
          previous !== undefined && checkedAt - previous < minimumElapsedMs
        if (isRecent) {
          return current
        }
        claimed = true
        return {
          ...current,
          lastBackgroundUpdateCheckAt: checkedAt,
        }
      })
      return claimed
    },
  }
}

type Eligibility =
  | { skip: string; permanent: boolean }
  | { pkgManager: 'bun' | 'npm' }

/**
 * Order matters twice over. The reversible gates (env, config) come first so a
 * disabled session never reaches `getInstallationType`, which may spawn `npm
 * config get prefix` — keeping the loop alive on those skips has to stay cheap.
 * The bun check precedes it for the same reason: it is a pure path check.
 */
async function resolveEligibility(
  deps: BackgroundOccUpdateDeps,
): Promise<Eligibility> {
  const nodeEnv = deps.env.NODE_ENV
  if (nodeEnv === 'test' || nodeEnv === 'development') {
    return { skip: `NODE_ENV=${nodeEnv}`, permanent: true }
  }
  if (isEnvTruthy(deps.env.DISABLE_AUTOUPDATER)) {
    return { skip: 'DISABLE_AUTOUPDATER is set', permanent: false }
  }
  const essentialOnly = deps.getEssentialTrafficOnlyReason()
  if (essentialOnly) {
    return { skip: `${essentialOnly} is set`, permanent: false }
  }
  if (deps.getAutoUpdatesConfig() === false) {
    return { skip: 'autoUpdates disabled in global config', permanent: false }
  }
  if (deps.isBunGlobalInstall()) {
    return { pkgManager: 'bun' }
  }
  const installationType = await deps.getInstallationType()
  if (installationType === 'npm-global') {
    return { pkgManager: 'npm' }
  }
  // How occ was installed cannot change while it is running.
  return { skip: `not a global install (${installationType})`, permanent: true }
}

function updateQueuedText(version: string): string {
  return `✓ Update v${version} ready · installs on exit`
}

let lastQueuedVersion: string | undefined

/**
 * Compare against the newest version already queued, not just the running one.
 * Without this, every subsequent 30-minute pass would re-queue and re-notify
 * the same release for the rest of the session.
 */
function getComparisonVersion(currentVersion: string): string {
  if (lastQueuedVersion && gt(lastQueuedVersion, currentVersion)) {
    return lastQueuedVersion
  }
  return currentVersion
}

/**
 * One full check-and-queue pass. Never throws; every failure downgrades to
 * a logForDebugging line and a status for tests.
 */
export async function runBackgroundOccUpdateOnce(
  deps?: BackgroundOccUpdateDeps,
  signal?: AbortSignal,
): Promise<BackgroundOccUpdateOutcome> {
  try {
    const d = deps ?? (await loadDefaultDeps())

    const eligibility = await resolveEligibility(d)
    if ('skip' in eligibility) {
      logForDebugging(`backgroundOccUpdate: skipped (${eligibility.skip})`)
      return {
        status: 'skipped',
        reason: eligibility.skip,
        permanent: eligibility.permanent,
      }
    }

    const intervalMs = updateInterval.resolveBackgroundUpdateIntervalMs(d.env)
    if (!d.claimUpdateCheck(d.now(), intervalMs * CHECK_THROTTLE_RATIO)) {
      logForDebugging('backgroundOccUpdate: throttled')
      return { status: 'throttled' }
    }

    const currentVersion = getComparisonVersion(d.getCurrentVersion())
    const latestVersion = await d.getLatestVersion(signal)
    if (!latestVersion) {
      logForDebugging('backgroundOccUpdate: version check failed')
      return { status: 'check-failed' }
    }
    if (!gt(latestVersion, currentVersion)) {
      logForDebugging(
        `backgroundOccUpdate: up to date (${currentVersion}, latest ${latestVersion})`,
      )
      return { status: 'up-to-date', version: currentVersion }
    }

    // Queue only — installing now would delete the chunks this very session
    // still needs (deferredOccInstall.ts). Nothing is lost: a running process
    // could never have adopted the new version anyway.
    d.armInstall({
      pkgManager: eligibility.pkgManager,
      spec: d.packageSpec(),
      version: latestVersion,
      acquireLock: d.acquireLock,
    })
    lastQueuedVersion = latestVersion
    d.notify(updateQueuedText(latestVersion))
    logForDebugging(
      `backgroundOccUpdate: queued ${latestVersion} via ${eligibility.pkgManager} for exit (current ${currentVersion})`,
    )
    return { status: 'queued', version: latestVersion }
  } catch (error) {
    logForDebugging(`backgroundOccUpdate: ${error}`)
    return { status: 'error' }
  }
}

let scheduledThisSession = false

type BackgroundOccScheduleFn = (
  callback: () => Promise<void>,
  delayMs: number,
) => { unref: () => void }

/**
 * Abort the in-flight check when the session shuts down.
 *
 * The timers are unref'd, so they never hold the process open — but a spawned
 * `npm view` (10s) child does. Without this, Ctrl+C during a background check
 * sat until gracefulShutdown's 5s failsafe fired and then hard-exited.
 * Cancelling the child instead lets the event loop drain and exit on its own.
 * (The installer itself is no longer spawned here at all — see
 * deferredOccInstall.ts.)
 */
function registerShutdownAbort(controller: AbortController): void {
  registerCleanup(async () => {
    controller.abort()
  })
}

/**
 * Install the once-per-session background loop. Called from rootAction on the
 * interactive path only. Cheap env guards run here so no timer is created at
 * all in the common disabled cases; the full gate (config + installation
 * type) runs again on every pass. Returns whether the loop was installed.
 */
export function maybeScheduleBackgroundOccUpdate(options?: {
  env?: NodeJS.ProcessEnv
  delayMs?: number
  run?: (signal: AbortSignal) => Promise<BackgroundOccUpdateOutcome>
  scheduleFn?: BackgroundOccScheduleFn
  /** Injected by tests; production registers one tied to graceful shutdown. */
  abortController?: AbortController
}): boolean {
  if (scheduledThisSession) {
    return false
  }
  const env = options?.env ?? process.env
  if (env.NODE_ENV === 'test' || env.NODE_ENV === 'development') {
    return false
  }
  if (isEnvTruthy(env.DISABLE_AUTOUPDATER)) {
    return false
  }
  scheduledThisSession = true
  const controller = options?.abortController ?? new AbortController()
  if (!options?.abortController) {
    registerShutdownAbort(controller)
  }
  const run =
    options?.run ??
    ((signal: AbortSignal) => runBackgroundOccUpdateOnce(undefined, signal))
  const intervalMs = updateInterval.resolveBackgroundUpdateIntervalMs(env)
  const scheduleFn: BackgroundOccScheduleFn =
    options?.scheduleFn ??
    ((callback, delayMs) =>
      setTimeout(() => {
        void callback()
      }, delayMs))
  const scheduleNext = (delayMs: number): void => {
    const timer = scheduleFn(async () => {
      if (controller.signal.aborted) {
        return
      }
      try {
        const outcome = await run(controller.signal)
        // Only a skip that this process can never resolve retires the loop.
        // A reversible one (autoUpdates toggled off, an env var) keeps ticking
        // so flipping it back on takes effect without a restart.
        if (outcome.status === 'skipped' && outcome.permanent) {
          logForDebugging(
            `backgroundOccUpdate: loop retired (${outcome.reason})`,
          )
          return
        }
      } catch (error) {
        // The production runner never throws; keep overrides and future
        // edits from surfacing an unhandled rejection into the session.
        logForDebugging(`backgroundOccUpdate: scheduled run failed: ${error}`)
      }
      scheduleNext(intervalMs)
    }, delayMs)
    // Never keep the process alive just for an update check.
    timer.unref()
  }
  scheduleNext(options?.delayMs ?? BACKGROUND_UPDATE_DELAY_MS)
  return true
}

export function resetBackgroundOccUpdateForTests(): void {
  scheduledThisSession = false
  lastQueuedVersion = undefined
}
