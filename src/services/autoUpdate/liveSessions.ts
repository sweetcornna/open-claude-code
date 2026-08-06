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
import {
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { occConfigPath } from 'src/config/paths.js'
import { distRoot } from 'src/utils/filesystem/distRoot.js'
import { registerCleanup } from 'src/utils/process/cleanupRegistry.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'

/**
 * Entries this old are ignored even if the pid still resolves. Guards against
 * pid reuse: a recycled pid would otherwise pin the registry to "a session is
 * live" forever and silently disable updates on that machine.
 */
const STALE_ENTRY_MS = 7 * 24 * 60 * 60 * 1000

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

let registered = false

/**
 * Announce this process to other sessions and keep the announcement alive for
 * as long as the process is. Idempotent; safe to call before the config dir
 * exists. Fire-and-forget — callers must not await it on the startup path.
 */
export function registerLiveSession(): void {
  if (registered) {
    return
  }
  registered = true
  const entryPath = join(liveSessionsDir(), String(process.pid))

  registerCleanup(async () => {
    try {
      await unlink(entryPath)
    } catch {
      // Already gone, or the config dir was removed under us.
    }
  })

  void (async () => {
    try {
      await mkdir(liveSessionsDir(), { recursive: true })
      await writeFile(entryPath, distRoot, 'utf8')
    } catch (error) {
      logForDebugging(
        `liveSessions: could not register ${process.pid}: ${error}`,
      )
    }
  })()
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
  } catch {
    // No directory yet — this is the only session that ever registered.
    return false
  }

  let foundOther = false
  await Promise.all(
    entries.map(async name => {
      const pid = Number(name)
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
        return
      }
      const entryPath = join(liveSessionsDir(), name)
      if (!isProcessAlive(pid)) {
        try {
          await unlink(entryPath)
        } catch {
          // Another session pruned it first.
        }
        return
      }
      try {
        const [contents, stats] = await Promise.all([
          readFile(entryPath, 'utf8'),
          stat(entryPath),
        ])
        if (Date.now() - stats.mtimeMs > STALE_ENTRY_MS) {
          return
        }
        if (contents.trim() === distRoot) {
          foundOther = true
        }
      } catch {
        // Unreadable entry: treat as absent rather than blocking updates.
      }
    }),
  )
  return foundOther
}

export function resetLiveSessionsForTests(): void {
  registered = false
}
