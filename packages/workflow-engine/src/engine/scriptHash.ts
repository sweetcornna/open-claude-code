import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertValidRunId } from './paths.js'

const SCRIPT_HASH_FILE = 'script.sha256'

/**
 * Absolute path of a run's on-disk directory (journal.jsonl, state.json,
 * script.sha256, persisted inline script). Single definition so the path shown to
 * the model can never drift from the one written to.
 */
export function workflowRunDir(
  cwd: string,
  workflowRunsDir: string,
  runId: string,
): string {
  return join(cwd, workflowRunsDir, assertValidRunId(runId))
}

/**
 * Whether `script` differs from the source recorded for `runId`.
 *
 * Read-only on purpose, and split from {@link recordScriptHash} for two reasons:
 *
 * - Only the launch that actually wins single-flight registration may record a hash.
 *   Writing at check time let the loser of two concurrent resumes stamp the run with
 *   a script that never executed, and the winner's checkpoints then looked stale.
 * - Selective resume has to detect a mismatch *and* refuse the run without touching
 *   the recorded hash, so the next attempt still compares against the real baseline.
 *
 * A run with no recorded hash reads as changed: an unproven script must not be
 * allowed to replay checkpoints it may not have produced.
 */
export async function isScriptChanged(opts: {
  script: string
  runId: string
  cwd: string
  workflowRunsDir: string
}): Promise<boolean> {
  const hashPath = join(
    workflowRunDir(opts.cwd, opts.workflowRunsDir, opts.runId),
    SCRIPT_HASH_FILE,
  )
  let previousHash: string | undefined
  try {
    previousHash = (await readFile(hashPath, 'utf-8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return previousHash !== hashOf(opts.script)
}

/** Record the source this run is actually executing, for later resume comparison. */
export async function recordScriptHash(opts: {
  script: string
  runId: string
  cwd: string
  workflowRunsDir: string
}): Promise<void> {
  const runDir = workflowRunDir(opts.cwd, opts.workflowRunsDir, opts.runId)
  await mkdir(runDir, { recursive: true })
  await writeFile(
    join(runDir, SCRIPT_HASH_FILE),
    `${hashOf(opts.script)}\n`,
    'utf-8',
  )
}

function hashOf(script: string): string {
  return createHash('sha256').update(script).digest('hex')
}
