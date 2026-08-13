import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_DIR_NAME } from 'src/config/paths.js'
import { writeRunState } from '../../../workflow/persistence.js'
import type { RunProgress } from '../../../workflow/progress/store.js'
import { formatWorkflowRunsStatus, listWorkflowRuns } from '../workflowRuns.js'

function run(overrides: Partial<RunProgress>): RunProgress {
  return {
    runId: 'run-1',
    workflowName: 'research',
    status: 'completed',
    phases: [],
    declaredPhases: [],
    currentPhase: null,
    agents: [],
    agentCount: 0,
    startedAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  }
}

test('listWorkflowRuns reads current per-run state.json files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'occ-workflow-status-'))
  const runsDir = join(root, PROJECT_DIR_NAME, 'workflow-runs')
  try {
    await writeRunState(
      runsDir,
      run({ runId: 'older', status: 'failed', updatedAt: 2_000 }),
    )
    await writeRunState(
      runsDir,
      run({ runId: 'newer', status: 'killed', updatedAt: 3_000 }),
    )

    const runs = await listWorkflowRuns(root)

    expect(runs.map(item => item.runId)).toEqual(['newer', 'older'])
    expect(runs.map(item => item.status)).toEqual(['killed', 'failed'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('formatWorkflowRunsStatus reports current status and progress fields', () => {
  const output = formatWorkflowRunsStatus([
    run({
      status: 'running',
      currentPhase: 'Inspect',
      agentCount: 2,
      agents: [
        { id: 0, status: 'running' },
        { id: 1, status: 'done' },
      ],
    }),
    run({ runId: 'failed-run', status: 'failed' }),
    run({ runId: 'killed-run', status: 'killed' }),
  ])

  expect(output).toContain('Running: 1')
  expect(output).toContain('Failed: 1')
  expect(output).toContain('Killed: 1')
  expect(output).toContain(
    'run-1: research: running phase=Inspect agents=2 live=1',
  )
})
