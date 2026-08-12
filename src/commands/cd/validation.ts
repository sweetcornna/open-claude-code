import chalk from 'chalk'
import { realpath, stat } from 'fs/promises'
import { dirname } from 'path'
import { getCwd } from '../../utils/filesystem/cwd.js'
import { expandPath } from '../../utils/filesystem/path.js'
import { getErrnoCode } from '../../utils/runtime/errors.js'
import { logForDebugging } from '../../utils/telemetry/debug.js'

/**
 * Outcome of resolving a `/cd <path>` argument.
 *
 * Mirrors the official command's four terminal states. `same` is reported
 * separately from `ok` so the command can say "Already in X" instead of
 * running a pointless relocation (which would still fire CwdChanged hooks).
 */
type CdTargetResult =
  | { result: 'ok'; directory: string }
  | { result: 'same'; directory: string }
  | { result: 'not_found'; path: string }
  | { result: 'not_a_directory'; path: string; parent: string }

type CdTargetFailure = Exclude<CdTargetResult, { result: 'ok' }>

/** realpath + NFC, falling back to the input when the path can't be resolved. */
async function canonicalize(path: string): Promise<string> {
  try {
    return (await realpath(path)).normalize('NFC')
  } catch {
    // Racy unlink, an unreadable link chain, or (for the session cwd) a
    // directory that no longer exists. Fall back to the given path —
    // process.chdir() in relocateSession is the real gate.
    return path
  }
}

/**
 * Resolve and validate a `/cd` target.
 *
 * `~` and relative paths resolve through `expandPath` (relative is resolved
 * against the session cwd, matching shell `cd`). Both sides of the "am I
 * already here?" comparison are canonicalized with realpath because the
 * session's cwd state is stored physically (`setCwd` → `realpathSync`), so a
 * symlinked argument would otherwise never compare equal to it.
 *
 * `sessionCwd` is injectable purely so tests can pin a directory they own.
 * Production callers omit it and get the session cwd. (Tests must not rely on
 * the ambient one: `mock.module` is process-global and several suites — e.g.
 * share-projectdir, launchAutofixPr — pin `getCwdState` to a non-existent
 * '/mock/cwd' for the rest of the shard, with `setCwdState` no-op'd so it
 * can't even be restored.)
 */
export async function validateCdTarget(
  directoryPath: string,
  sessionCwd: string = getCwd(),
): Promise<CdTargetResult> {
  const absolutePath = expandPath(directoryPath, sessionCwd)

  try {
    const stats = await stat(absolutePath)
    if (!stats.isDirectory()) {
      return {
        result: 'not_a_directory',
        path: absolutePath,
        parent: dirname(absolutePath),
      }
    }
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    // ENOENT/ENOTDIR/EACCES/EPERM are the expected "can't go there" errnos
    // (same set /add-dir treats as not-found). Anything else is worth a debug
    // line, but the user still gets the same actionable message rather than a
    // thrown error inside a slash command.
    if (
      code !== 'ENOENT' &&
      code !== 'ENOTDIR' &&
      code !== 'EACCES' &&
      code !== 'EPERM'
    ) {
      logForDebugging(`/cd: unexpected stat errno ${code ?? 'unknown'}`, {
        level: 'error',
      })
    }
    return { result: 'not_found', path: absolutePath }
  }

  const canonical = await canonicalize(absolutePath)

  if (canonical === (await canonicalize(sessionCwd))) {
    return { result: 'same', directory: canonical }
  }

  return { result: 'ok', directory: canonical }
}

export function cdFailureMessage(result: CdTargetFailure): string {
  switch (result.result) {
    case 'not_found':
      return `Couldn't find a directory at ${chalk.bold(result.path)}.`
    case 'not_a_directory':
      return `${chalk.bold(result.path)} is not a directory. Did you mean ${chalk.bold(result.parent)}?`
    case 'same':
      return `Already in ${chalk.bold(result.directory)}.`
  }
}
