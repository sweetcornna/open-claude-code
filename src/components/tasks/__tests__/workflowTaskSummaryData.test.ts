// Tests for the data behind the workflow summary in BackgroundTasksDialog.
//
// The projection is tested rather than the ink render on purpose: two test files in this
// suite (commands/onboarding, commands/review/ultrareviewCommand) call
// mock.module('@anthropic/ink'), which is process-global, and any ink render ordered after
// them hangs. WorkflowTaskSummary.tsx is a thin map over these functions, so this is where
// the behaviour actually lives.
import { describe, expect, test } from 'bun:test'
import { PHASE_MARK, STATUS_DOT } from '../../../workflow/panel/status.js'
import type { RunProgress } from '../../../workflow/progress/store.js'
import {
  runStatusFromTask,
  workflowAgentLine,
  workflowFallbackLine,
  workflowPhaseRows,
  workflowStatusLine,
  type WorkflowTaskFields,
} from '../workflowTaskSummaryData.js'

const task: WorkflowTaskFields = {
  id: 'task-1',
  runId: 'run-1',
  workflowName: 'spec',
  status: 'running',
}

function run(overrides: Partial<RunProgress> = {}): RunProgress {
  return {
    runId: 'run-1',
    workflowName: 'spec',
    status: 'running',
    phases: [],
    declaredPhases: [],
    currentPhase: null,
    agents: [],
    agentCount: 0,
    startedAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('runStatusFromTask', () => {
  test('terminal task statuses map straight through', () => {
    expect(runStatusFromTask('completed')).toBe('completed')
    expect(runStatusFromTask('failed')).toBe('failed')
    expect(runStatusFromTask('killed')).toBe('killed')
  })

  test('pending reads as running (the run status union has no pending)', () => {
    expect(runStatusFromTask('pending')).toBe('running')
    expect(runStatusFromTask('running')).toBe('running')
  })
})

describe('workflowStatusLine', () => {
  test('uses the run status glyph and text', () => {
    const line = workflowStatusLine(task, run())
    expect(line.glyph).toBe(STATUS_DOT.running)
    expect(line.name).toBe('spec')
    expect(line.text).toBe('running')
    expect(line.color).toBeTruthy()
  })

  test('the live run wins over a stale task status', () => {
    const line = workflowStatusLine(task, run({ status: 'completed' }))
    expect(line.glyph).toBe(STATUS_DOT.completed)
    expect(line.text).toBe('done')
  })

  test('falls back to the task status with no live run', () => {
    const line = workflowStatusLine({ ...task, status: 'failed' }, undefined)
    expect(line.glyph).toBe(STATUS_DOT.failed)
    expect(line.text).toBe('failed')
  })
})

describe('workflowPhaseRows', () => {
  test('marks declared-but-unstarted phases pending, in declared order', () => {
    const rows = workflowPhaseRows(
      run({
        declaredPhases: ['scan', 'review', 'fix'],
        phases: [
          { title: 'scan', status: 'done' },
          { title: 'review', status: 'running' },
        ],
        currentPhase: 'review',
      }),
    )
    expect(rows.map(r => [r.title, r.mark])).toEqual([
      ['scan', PHASE_MARK.done],
      ['review', PHASE_MARK.running],
      ['fix', PHASE_MARK.pending],
    ])
  })

  test('carries per-phase agent done/total counts', () => {
    const rows = workflowPhaseRows(
      run({
        declaredPhases: ['review'],
        phases: [{ title: 'review', status: 'running' }],
        currentPhase: 'review',
        agentCount: 3,
        agents: [
          { id: 1, status: 'done', phase: 'review' },
          { id: 2, status: 'done', phase: 'review' },
          { id: 3, status: 'running', phase: 'review' },
        ],
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.done).toBe(2)
    expect(rows[0]!.total).toBe(3)
  })

  test('surfaces phases that only ever appeared on agents', () => {
    // The canonical pipeline pattern passes opts.phase to agent() without calling phase(),
    // so run.phases stays empty — mergePhases recovers them and so must this view.
    const rows = workflowPhaseRows(
      run({
        agentCount: 1,
        agents: [{ id: 1, status: 'running', phase: 'build' }],
      }),
    )
    expect(rows.map(r => r.title)).toEqual(['build'])
    expect(rows[0]!.mark).toBe(PHASE_MARK.running)
  })

  test('is empty without a live run', () => {
    expect(workflowPhaseRows(undefined)).toEqual([])
  })
})

describe('workflowAgentLine', () => {
  test('breaks the total down into running and done', () => {
    expect(
      workflowAgentLine(
        task,
        run({
          agentCount: 3,
          agents: [
            { id: 1, status: 'done' },
            { id: 2, status: 'running' },
            { id: 3, status: 'running' },
          ],
        }),
      ),
    ).toBe('3 agents · 2 running · 1 done')
  })

  test('singularizes a lone agent', () => {
    expect(
      workflowAgentLine(
        task,
        run({ agentCount: 1, agents: [{ id: 1, status: 'running' }] }),
      ),
    ).toBe('1 agent · 1 running · 0 done')
  })

  test('says so before any agent spawns', () => {
    expect(workflowAgentLine(task, run())).toBe('no agents yet')
    expect(workflowAgentLine(task, undefined)).toBe('no agents yet')
  })

  test('without a live run only the denormalized total is reported', () => {
    expect(workflowAgentLine({ ...task, agentCount: 4 }, undefined)).toBe(
      '4 agents',
    )
  })
})

describe('workflowFallbackLine', () => {
  test('uses the denormalized summary the task carries', () => {
    expect(
      workflowFallbackLine({ ...task, summary: 'review (2/4) · 3 agents' }),
    ).toBe('review (2/4) · 3 agents')
  })

  test('degrades gracefully when there is no summary yet', () => {
    expect(workflowFallbackLine(task)).toBe('no phases reported yet')
  })
})
