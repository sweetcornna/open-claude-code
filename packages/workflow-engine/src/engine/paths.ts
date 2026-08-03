import { resolve, sep } from 'node:path'

/**
 * Determine whether target, after resolution, is within base (including equal to base).
 * Relative targets are resolved against base (does not depend on process.cwd).
 * Uses the `sep` boundary to avoid false prefix positives (e.g. `/foo` is not the parent of `/foobar`).
 */
export function containsPath(base: string, target: string): boolean {
  const resolvedBase = resolve(base)
  const resolvedTarget = resolve(resolvedBase, target)
  if (resolvedTarget === resolvedBase) return true
  return resolvedTarget.startsWith(resolvedBase + sep)
}

/**
 * Validate whether the named workflow name is a legal identifier (reject path traversal).
 * Rejects: path separators, null bytes, `.` / `..`.
 * Returns the sanitized name, or null for illegal.
 */
export function sanitizeWorkflowName(name: string): string | null {
  if (typeof name !== 'string' || name.length === 0) return null
  if (name.includes('/') || name.includes('\\')) return null
  if (name.includes('\0')) return null
  if (name === '.' || name === '..') return null
  return name
}

/**
 * Validate a workflow run id before it is used to build a filesystem path.
 *
 * `resumeFromRunId` is caller-supplied and was previously passed straight into
 * `join(runsDir, runId, ...)`, so a traversing id such as `../../../some/dir`
 * turned "resume a workflow" into arbitrary filesystem reach. `deleteRun()`
 * still does a recursive `rm` of the run directory, and `append`/`rewrite` are
 * persistence boundaries in their own right, so every path built from a run id
 * goes through this check.
 *
 * Generated ids are a one-letter prefix plus 8 chars of [0-9a-z]
 * (`generateTaskId` in src/Task.ts); this accepts that plus any conservative
 * identifier, and rejects separators, `.`/`..` and null bytes.
 */
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export function isValidRunId(runId: unknown): runId is string {
  return typeof runId === 'string' && RUN_ID_RE.test(runId)
}

/** Throwing variant for persistence boundaries. */
export function assertValidRunId(runId: unknown): string {
  if (!isValidRunId(runId)) {
    throw new Error(
      `Invalid workflow run id: ${JSON.stringify(runId)} (expected ${RUN_ID_RE})`,
    )
  }
  return runId
}
