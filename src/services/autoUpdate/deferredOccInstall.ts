/**
 * Deferred self-install: the background updater decides *what* to install
 * during the session, and this module actually installs it after the session
 * is gone.
 *
 * The split is not a nicety. `npm|bun install -g` deletes the package
 * directory it replaces, and occ's ~600 chunk filenames are content-hashed, so
 * about half of them cease to exist on every release. A running session
 * `import()`s those chunks lazily until it exits, so installing in place used
 * to hand the live REPL a tree where half its remaining code was gone —
 * ERR_MODULE_NOT_FOUND on the next lazy import, a wedged UI, and a session that
 * could not even be exited with Ctrl+C. See liveSessions.ts for the full note.
 *
 * Nothing is lost by waiting: the old in-place install still told the user
 * "Restart to apply", because a running process can never adopt a new version
 * anyway. Installing at exit gives exactly the same result without breaking
 * the session that triggered it.
 *
 * Failure is safe and self-healing. The spawned child is detached with its
 * output discarded, so a failed install is invisible here — but the next
 * session's version check sees the old version still installed and arms the
 * whole thing again.
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { registerCleanup } from 'src/utils/process/cleanupRegistry.js'
import { packageManagerSpawnOptions } from 'src/utils/process/packageManager.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import { hasOtherLiveSessions } from './liveSessions.js'

export type DeferredOccInstall = {
  pkgManager: 'bun' | 'npm'
  /** Full spec passed to `install -g`, e.g. `@scope/pkg@latest`. */
  spec: string
  /** Version resolved at check time; for logging and the REPL notice. */
  version: string
  /**
   * Passed in rather than imported so this module keeps no static edge to the
   * autoUpdater (and through it gracefulShutdown) — `bun run check:cycles` is
   * a strict two-way ratchet. Deliberately never released: the child outlives
   * us, so the lock's 5-minute staleness window *is* the install window, and
   * two sessions exiting in the same instant can't both spawn an installer.
   */
  acquireLock?: () => Promise<boolean>
}

export type DeferredOccInstallDeps = {
  hasOtherLiveSessions: () => Promise<boolean>
  spawnInstaller: (install: DeferredOccInstall) => void
}

let pending: DeferredOccInstall | undefined
let unregisterFlush: (() => void) | undefined

function spawnDetachedInstaller(install: DeferredOccInstall): void {
  // Detached + unref'd + stdio ignored is what lets this outlive
  // process.exit(). cwd=homedir so a project-level .npmrc/.bunfig.toml cannot
  // redirect the registry, matching the interactive `occ update` path.
  // shell on Windows: npm/bun are .cmd shims there, so a direct spawn fails
  // with ENOENT — and with stdio ignored that failure was completely silent,
  // which is why the deferred update never landed on Windows.
  const child = spawn(install.pkgManager, ['install', '-g', install.spec], {
    cwd: homedir(),
    detached: true,
    stdio: 'ignore',
    ...packageManagerSpawnOptions(),
  })
  child.unref()
}

/**
 * Queue an install to run once this session is gone. Re-arming with a newer
 * version replaces the previous entry; the cleanup hook is registered once.
 */
export function armDeferredOccInstall(install: DeferredOccInstall): void {
  pending = install
  if (!unregisterFlush) {
    unregisterFlush = registerCleanup(flushDeferredOccInstall)
  }
}

export function getPendingDeferredOccInstall(): DeferredOccInstall | undefined {
  return pending
}

/**
 * Hand the queued install to a detached child, unless another session is still
 * running from the same install tree — that session would be wrecked exactly
 * the way this whole mechanism exists to prevent. Whichever session exits last
 * performs the install; if every one of them is killed first, the next
 * session's background check re-arms it.
 *
 * Registered with the cleanup registry, so it runs inside gracefulShutdown's
 * 2s cleanup budget. Spawning is effectively instantaneous — the child does
 * all the waiting, after this process is gone.
 */
export async function flushDeferredOccInstall(
  deps?: DeferredOccInstallDeps,
): Promise<void> {
  const install = pending
  if (!install) {
    return
  }
  pending = undefined
  const d = deps ?? {
    hasOtherLiveSessions,
    spawnInstaller: spawnDetachedInstaller,
  }
  try {
    if (await d.hasOtherLiveSessions()) {
      logForDebugging(
        `deferredOccInstall: postponed ${install.version} — another session is still running`,
      )
      return
    }
    if (install.acquireLock && !(await install.acquireLock())) {
      logForDebugging(
        `deferredOccInstall: postponed ${install.version} — another install is in flight`,
      )
      return
    }
    d.spawnInstaller(install)
    logForDebugging(
      `deferredOccInstall: spawned ${install.pkgManager} install of ${install.spec} (${install.version})`,
    )
  } catch (error) {
    logForDebugging(`deferredOccInstall: ${error}`)
  }
}

export function resetDeferredOccInstallForTests(): void {
  pending = undefined
  unregisterFlush?.()
  unregisterFlush = undefined
}
