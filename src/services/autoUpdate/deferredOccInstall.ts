/**
 * Persisted deferred self-install coordination.
 *
 * The background checker records an immutable candidate while the session is
 * running. Every session removes its live lease during cleanup and then calls
 * flush, so whichever session exits last can install an update discovered by
 * any peer. Candidates survive crashes, lock contention, and postponed exits.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { occConfigPath } from 'src/config/paths.js'
import { isEnvTruthy } from 'src/utils/config/envUtils.js'
import { distRoot } from 'src/utils/filesystem/distRoot.js'
import { packageManagerSpawnOptions } from 'src/utils/process/packageManager.js'
import { writePrivateFileAtomic } from 'src/utils/secureStorage/atomicWrite.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import { gt } from 'src/utils/text/semver.js'
import { hasOtherLiveSessions } from './liveSessions.js'

export type DeferredOccInstall = {
  pkgManager: 'bun' | 'npm'
  /** Full spec passed to `install -g`, e.g. `@scope/pkg@latest`. */
  spec: string
  /** Version resolved at check time; for logging and the REPL notice. */
  version: string
  acquireLock?: () => Promise<boolean>
}

type PersistedDeferredOccInstall = {
  schemaVersion: 1
  distRoot: string
  pkgManager: 'bun' | 'npm'
  version: string
}

type PendingCandidate = {
  path: string
  install: PersistedDeferredOccInstall
}

export type DeferredOccInstallDeps = {
  hasOtherLiveSessions: () => Promise<boolean>
  acquireLock: () => Promise<boolean>
  releaseLock: () => Promise<void>
  packageSpec: () => string
  spawnInstaller: (install: DeferredOccInstall) => Promise<void>
  /** Mirrors of the arm-side gates. See {@link resolveFlushGate}. */
  env: NodeJS.ProcessEnv
  /** globalConfig.autoUpdates — only an explicit `false` disables. */
  getAutoUpdatesConfig: () => boolean | undefined
  getEssentialTrafficOnlyReason: () => string | null
}

const VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

let pending: DeferredOccInstall | undefined

function pendingDir(): string {
  return occConfigPath('pending-updates')
}

function candidatePath(install: DeferredOccInstall): string {
  const key = createHash('sha256')
    .update(`${distRoot}\0${install.version}\0${install.pkgManager}`)
    .digest('hex')
  return join(pendingDir(), `${key}.json`)
}

function isPersistedInstall(
  value: unknown,
): value is PersistedDeferredOccInstall {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record.schemaVersion === 1 &&
    record.distRoot === distRoot &&
    (record.pkgManager === 'npm' || record.pkgManager === 'bun') &&
    typeof record.version === 'string' &&
    VERSION_PATTERN.test(record.version)
  )
}

async function readPendingCandidates(): Promise<PendingCandidate[]> {
  let entries: string[]
  try {
    entries = await readdir(pendingDir())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const candidates: PendingCandidate[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const path = join(pendingDir(), name)
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
      if (isPersistedInstall(parsed)) {
        candidates.push({ path, install: parsed })
      }
    } catch (error) {
      logForDebugging(
        `deferredOccInstall: ignored invalid candidate ${path}: ${error}`,
      )
    }
  }
  return candidates
}

function newestCandidate(
  candidates: PendingCandidate[],
): PendingCandidate | undefined {
  let newest: PendingCandidate | undefined
  for (const candidate of candidates) {
    if (!newest || gt(candidate.install.version, newest.install.version)) {
      newest = candidate
    }
  }
  return newest
}

async function removeCandidates(candidates: PendingCandidate[]): Promise<void> {
  await Promise.all(
    candidates.map(candidate =>
      unlink(candidate.path).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }),
    ),
  )
}

function spawnDetachedInstaller(install: DeferredOccInstall): Promise<void> {
  const child = spawn(install.pkgManager, ['install', '-g', install.spec], {
    cwd: homedir(),
    detached: true,
    stdio: 'ignore',
    ...packageManagerSpawnOptions(),
  })
  return new Promise((resolve, reject) => {
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
    child.once('error', reject)
  })
}

async function loadDefaultDeps(): Promise<DeferredOccInstallDeps> {
  const [autoUpdater, updateOcc, config, privacy] = await Promise.all([
    import('src/utils/update/autoUpdater.js'),
    import('src/cli/updateOcc.js'),
    import('src/utils/config/config.js'),
    import('src/utils/auth/privacyLevel.js'),
  ])
  return {
    hasOtherLiveSessions,
    acquireLock: autoUpdater.acquireUpdateLock,
    releaseLock: autoUpdater.releaseUpdateLock,
    packageSpec: updateOcc.latestPackageSpec,
    spawnInstaller: spawnDetachedInstaller,
    env: process.env,
    getAutoUpdatesConfig: () => config.getGlobalConfig().autoUpdates,
    getEssentialTrafficOnlyReason: privacy.getEssentialTrafficOnlyReason,
  }
}

type FlushGate = {
  skip: string
  /**
   * Whether the queued candidate should be dropped rather than left for the
   * next exit. True for gates that express user intent, false for gates that
   * only say "this particular process must not be the one to install".
   */
  discardCandidates: boolean
}

/**
 * The arm-side gates (`backgroundOccUpdate.resolveEligibility`), re-asked at
 * flush time.
 *
 * Arming and flushing are different processes minutes or hours apart: the
 * session that queued the update may be long gone, and the settings it checked
 * may have been reverted since. Without this, `DISABLE_AUTOUPDATER=1 occ` would
 * still install an update some earlier session queued — the one thing that flag
 * exists to prevent.
 *
 * Installation type is deliberately *not* re-probed. Arm already checked it,
 * and `isPersistedInstall` refuses any candidate whose `distRoot` is not this
 * one, so the candidate's mere existence carries the answer. Re-deriving it
 * would spawn `npm config get prefix` on every exit for nothing.
 */
function resolveFlushGate(deps: DeferredOccInstallDeps): FlushGate | undefined {
  const nodeEnv = deps.env.NODE_ENV
  if (nodeEnv === 'test' || nodeEnv === 'development') {
    // Keep the candidate: a dev checkout or a test run must not install, but it
    // also has no standing to cancel an update a real session queued.
    return { skip: `NODE_ENV=${nodeEnv}`, discardCandidates: false }
  }
  if (isEnvTruthy(deps.env.DISABLE_AUTOUPDATER)) {
    return { skip: 'DISABLE_AUTOUPDATER is set', discardCandidates: true }
  }
  const essentialOnly = deps.getEssentialTrafficOnlyReason()
  if (essentialOnly) {
    return { skip: `${essentialOnly} is set`, discardCandidates: true }
  }
  if (deps.getAutoUpdatesConfig() === false) {
    return {
      skip: 'autoUpdates disabled in global config',
      discardCandidates: true,
    }
  }
  return undefined
}

export async function armDeferredOccInstall(
  install: DeferredOccInstall,
): Promise<void> {
  await mkdir(pendingDir(), { recursive: true, mode: 0o700 })
  const persisted: PersistedDeferredOccInstall = {
    schemaVersion: 1,
    distRoot,
    pkgManager: install.pkgManager,
    version: install.version,
  }
  await writePrivateFileAtomic(
    candidatePath(install),
    `${JSON.stringify(persisted)}\n`,
  )
  if (!pending || gt(install.version, pending.version)) {
    pending = install
  }
}

export function getPendingDeferredOccInstall(): DeferredOccInstall | undefined {
  return pending
}

export async function flushDeferredOccInstall(
  deps?: DeferredOccInstallDeps,
): Promise<void> {
  try {
    const candidates = await readPendingCandidates()
    const candidate = newestCandidate(candidates)
    if (!candidate) return

    const d = deps ?? (await loadDefaultDeps())

    const gate = resolveFlushGate(d)
    if (gate) {
      logForDebugging(
        `deferredOccInstall: skipped ${candidate.install.version} (${gate.skip})`,
      )
      if (gate.discardCandidates) {
        await removeCandidates(candidates)
        pending = undefined
      }
      return
    }

    if (await d.hasOtherLiveSessions()) {
      logForDebugging(
        `deferredOccInstall: postponed ${candidate.install.version} — another session is still running`,
      )
      return
    }
    if (!(await d.acquireLock())) {
      logForDebugging(
        `deferredOccInstall: postponed ${candidate.install.version} — another install is in flight`,
      )
      return
    }

    let install: DeferredOccInstall
    try {
      install = {
        pkgManager: candidate.install.pkgManager,
        spec: d.packageSpec(),
        version: candidate.install.version,
      }
      await d.spawnInstaller(install)
    } catch (error) {
      await d.releaseLock()
      throw error
    }
    // No releaseLock on success, on purpose. The installer is detached and
    // outlives this process, so releasing here would open the window to a
    // second session starting a competing `install -g` over the same tree.
    // The lock is left to expire on its own (LOCK_TIMEOUT_MS, 5 min), which is
    // longer than an install takes. Do not "fix" this into a symmetric release.
    await removeCandidates(candidates)
    pending = undefined
    logForDebugging(
      `deferredOccInstall: spawned ${install.pkgManager} install of ${install.spec} (${install.version})`,
    )
  } catch (error) {
    logForDebugging(`deferredOccInstall: ${error}`)
  }
}

export function resetDeferredOccInstallForTests(): void {
  pending = undefined
}
