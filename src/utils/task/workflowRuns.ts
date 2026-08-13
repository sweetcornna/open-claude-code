import { PROJECT_DIR_NAME } from 'src/config/paths.js'
import { join } from 'node:path'
import { getProjectRoot } from '../../bootstrap/state.js'
import { listPersistedRuns } from '../../workflow/persistence.js'
import type { RunProgress } from '../../workflow/progress/store.js'

const WORKFLOW_RUNS_REL = join(PROJECT_DIR_NAME, 'workflow-runs')
const MAX_WORKFLOW_RUNS = 200

export type WorkflowRunRecord = RunProgress

export function listWorkflowRuns(
  rootDir: string = getProjectRoot(),
): Promise<WorkflowRunRecord[]> {
  return listPersistedRuns(join(rootDir, WORKFLOW_RUNS_REL), MAX_WORKFLOW_RUNS)
}

export function formatWorkflowRunsStatus(runs: WorkflowRunRecord[]): string {
  if (runs.length === 0) {
    return ['Workflow runs: 0', '  none'].join('\n')
  }

  const lines = [
    `Workflow runs: ${runs.length}`,
    `  Running: ${countStatus(runs, 'running')}`,
    `  Completed: ${countStatus(runs, 'completed')}`,
    `  Failed: ${countStatus(runs, 'failed')}`,
    `  Killed: ${countStatus(runs, 'killed')}`,
  ]
  for (const run of runs.slice(0, 10)) {
    const liveAgents = run.agents.filter(
      agent => agent.status === 'running',
    ).length
    lines.push(
      `  ${run.runId}: ${run.workflowName}: ${run.status} phase=${run.currentPhase ?? 'none'} agents=${run.agentCount} live=${liveAgents} updated=${new Date(run.updatedAt).toLocaleString()}`,
    )
  }
  if (runs.length > 10) {
    lines.push(`  ... ${runs.length - 10} more workflow run(s)`)
  }
  return lines.join('\n')
}

function countStatus(
  runs: WorkflowRunRecord[],
  status: WorkflowRunRecord['status'],
): number {
  return runs.filter(run => run.status === status).length
}
