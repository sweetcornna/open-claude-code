/**
 * Spawning the self-install, detached from the session that discovered it.
 *
 * The install used to be deferred until the last live session exited, because
 * replacing the package directory stranded the chunks a running session was
 * still importing. Sessions now run from a private hard-link farm
 * (runtimeFarm.ts), so the directory being replaced is one nothing is reading
 * from and the install can start the moment a newer version is found.
 *
 * Detached and `unref`'d on purpose: `install -g` takes tens of seconds, and
 * nothing about the session should wait on it — not the turn in flight, not
 * Ctrl+C, not shutdown. The installer outliving occ is the desired outcome,
 * which is also why the caller deliberately does not release the update lock
 * on success.
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { packageManagerSpawnOptions } from 'src/utils/process/packageManager.js'

export type OccInstall = {
  pkgManager: 'bun' | 'npm'
  /** Full spec passed to `install -g`, e.g. `@scope/pkg@latest`. */
  spec: string
  /** Version resolved at check time; for logging and the REPL notice. */
  version: string
}

export function spawnDetachedOccInstaller(install: OccInstall): Promise<void> {
  const child = spawn(install.pkgManager, ['install', '-g', install.spec], {
    // Never from the project cwd: a repo-level .npmrc / bunfig.toml could
    // redirect the install to another registry.
    cwd: homedir(),
    detached: true,
    stdio: 'ignore',
    // shell:true + windowsHide, because npm and bun are .cmd shims on Windows
    // and CreateProcess cannot execute a batch file.
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
