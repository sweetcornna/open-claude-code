/**
 * Silent background self-update for interactive sessions.
 *
 * Official Claude Code quietly keeps the global install fresh while a session
 * runs; occ restores that behavior for its own package only
 * (`@sweetcornna/open-claude-code`). The isolation contract in
 * src/cli/__tests__/updateIsolation.test.ts stays authoritative: this chain
 * must never touch the official CLI's package, paths, or commands.
 *
 * Timeline: rootAction schedules at most one check per session on an unref'd
 * timer, delayed a few minutes past startup so it never competes with launch.
 * The check reuses the `occ update` chain (npm view → compare → `npm|bun
 * install -g` with captured output). Success surfaces as one low-key REPL
 * notification via updateNotifier; every failure path is logForDebugging-only
 * and never interrupts the session.
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
import type { InstallationType } from 'src/utils/runtime/doctorDiagnostic.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import { gt } from 'src/utils/text/semver.js'
import { emitBackgroundUpdateNotification } from './updateNotifier.js'

const BACKGROUND_UPDATE_DELAY_MS = 5 * 60 * 1000

export type BackgroundOccUpdateDeps = {
  env: NodeJS.ProcessEnv
  /** globalConfig.autoUpdates — only an explicit `false` disables. */
  getAutoUpdatesConfig: () => boolean | undefined
  getEssentialTrafficOnlyReason: () => string | null
  getInstallationType: () => Promise<InstallationType>
  isBunGlobalInstall: () => boolean
  getCurrentVersion: () => string
  getLatestVersion: () => Promise<string | null>
  installLatest: (
    pkgManager: 'bun' | 'npm',
  ) => Promise<{ ok: boolean; detail: string }>
  acquireLock: () => Promise<boolean>
  releaseLock: () => Promise<void>
  notify: (text: string) => void
}

export type BackgroundOccUpdateOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'up-to-date'; version: string }
  | { status: 'check-failed' }
  | { status: 'locked' }
  | { status: 'install-failed' }
  | { status: 'updated'; version: string }
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
    installLatest: updateOcc.installOccGloballySilent,
    acquireLock: autoUpdater.acquireUpdateLock,
    releaseLock: autoUpdater.releaseUpdateLock,
    notify: emitBackgroundUpdateNotification,
  }
}

type Eligibility = { skip: string } | { pkgManager: 'bun' | 'npm' }

async function resolveEligibility(
  deps: BackgroundOccUpdateDeps,
): Promise<Eligibility> {
  const nodeEnv = deps.env.NODE_ENV
  if (nodeEnv === 'test' || nodeEnv === 'development') {
    return { skip: `NODE_ENV=${nodeEnv}` }
  }
  if (isEnvTruthy(deps.env.DISABLE_AUTOUPDATER)) {
    return { skip: 'DISABLE_AUTOUPDATER is set' }
  }
  const essentialOnly = deps.getEssentialTrafficOnlyReason()
  if (essentialOnly) {
    return { skip: `${essentialOnly} is set` }
  }
  if (deps.getAutoUpdatesConfig() === false) {
    return { skip: 'autoUpdates disabled in global config' }
  }
  // bun check first: it is a pure path check, while getInstallationType may
  // spawn `npm config get prefix`.
  if (deps.isBunGlobalInstall()) {
    return { pkgManager: 'bun' }
  }
  const installationType = await deps.getInstallationType()
  if (installationType === 'npm-global') {
    return { pkgManager: 'npm' }
  }
  return { skip: `not a global install (${installationType})` }
}

function updateSuccessText(version: string): string {
  return `✓ Updated to v${version} · Restart to apply`
}

/**
 * One full check-and-install pass. Never throws; every failure downgrades to
 * a logForDebugging line and a status for tests.
 */
export async function runBackgroundOccUpdateOnce(
  deps?: BackgroundOccUpdateDeps,
): Promise<BackgroundOccUpdateOutcome> {
  try {
    const d = deps ?? (await loadDefaultDeps())

    const eligibility = await resolveEligibility(d)
    if ('skip' in eligibility) {
      logForDebugging(`backgroundOccUpdate: skipped (${eligibility.skip})`)
      return { status: 'skipped', reason: eligibility.skip }
    }

    const currentVersion = d.getCurrentVersion()
    const latestVersion = await d.getLatestVersion()
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

    if (!(await d.acquireLock())) {
      logForDebugging('backgroundOccUpdate: another update is in progress')
      return { status: 'locked' }
    }
    try {
      logForDebugging(
        `backgroundOccUpdate: installing ${latestVersion} via ${eligibility.pkgManager} (current ${currentVersion})`,
      )
      const result = await d.installLatest(eligibility.pkgManager)
      if (!result.ok) {
        logForDebugging(`backgroundOccUpdate: install failed: ${result.detail}`)
        return { status: 'install-failed' }
      }
    } finally {
      await d.releaseLock()
    }

    d.notify(updateSuccessText(latestVersion))
    logForDebugging(`backgroundOccUpdate: updated to ${latestVersion}`)
    return { status: 'updated', version: latestVersion }
  } catch (error) {
    logForDebugging(`backgroundOccUpdate: ${error}`)
    return { status: 'error' }
  }
}

let scheduledThisSession = false

/**
 * Schedule the once-per-session background check. Called from rootAction on
 * the interactive path only. Cheap env guards run here so no timer is created
 * at all in the common disabled cases; the full gate (config + installation
 * type) runs again when the timer fires. Returns whether a run was scheduled.
 */
export function maybeScheduleBackgroundOccUpdate(options?: {
  env?: NodeJS.ProcessEnv
  delayMs?: number
  run?: () => Promise<unknown>
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
  const run = options?.run ?? (() => runBackgroundOccUpdateOnce())
  const timer = setTimeout(() => {
    void run().catch(error => {
      // runBackgroundOccUpdateOnce never throws; this guards test overrides
      // and future edits so the updater can never surface an unhandled
      // rejection into the session.
      logForDebugging(`backgroundOccUpdate: scheduled run failed: ${error}`)
    })
  }, options?.delayMs ?? BACKGROUND_UPDATE_DELAY_MS)
  // Never keep the process alive just for an update check.
  timer.unref()
  return true
}

export function resetBackgroundOccUpdateForTests(): void {
  scheduledThisSession = false
}
