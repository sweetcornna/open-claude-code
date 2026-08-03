import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { WORKFLOW_RUNS_DIR } from '../constants.js'
import { assertPathWithinRoot, assertValidRunId } from '../engine/paths.js'

/**
 * Persist an inline workflow script to the run directory so the caller can
 * iterate via `scriptPath` + `resumeFromRunId` without resending the full script
 * (the round-trip the ultracode skill promises for the inline entry path).
 *
 * Mirrors engine/journal.ts: writes directly via node:fs/promises (no port) to
 * `<cwd>/<WORKFLOW_RUNS_DIR>/<runId>/script.js` — the same directory as
 * journal.jsonl. `journalStore.truncate(runId)` deliberately leaves this file
 * alone (it only clears journal.jsonl) so that a journal divergence still
 * allows the edit-then-`scriptPath`-resume round trip; whole-directory cleanup
 * is `deleteRun(runId)`.
 *
 * Fixed filename `script.js`: parseScript ignores the extension and the runId
 * already makes the directory unique, so a stable name aids muscle memory.
 */
export async function persistInlineScript(
  script: string,
  runId: string,
  cwd: string,
  workflowRunsDir: string = WORKFLOW_RUNS_DIR,
): Promise<string> {
  // A repository can ship `<project>/.occ` as a symlink pointing elsewhere;
  // without this check the script would be written wherever it points.
  const dir = await assertPathWithinRoot(
    cwd,
    join(workflowRunsDir, assertValidRunId(runId)),
    'the inline workflow script',
  )
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, 'script.js')
  await writeFile(filePath, script, 'utf-8')
  return filePath
}
