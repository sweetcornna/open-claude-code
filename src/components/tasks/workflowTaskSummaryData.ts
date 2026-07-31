// Data projection behind WorkflowTaskSummary.tsx.
//
// Kept React-free and in its own module for two reasons: the shaping logic (which glyph,
// which counts, what to show when the live run is missing) is the part worth testing, and
// a unit test that never touches ink is immune to the process-global `mock.module`
// pollution that makes any late-ordered ink render in this suite hang.

import type { TaskStatus } from '../../Task.js'
import { mergePhases } from '../../workflow/panel/selectors.js'
import {
  PHASE_COLOR,
  PHASE_MARK,
  RUN_STATUS_COLOR,
  RUN_STATUS_TEXT,
  STATUS_DOT,
} from '../../workflow/panel/status.js'
import type { RunProgress } from '../../workflow/progress/store.js'

/**
 * The slice of LocalWorkflowTaskState this view reads. Declared structurally so the dialog
 * can hand over its `DeepImmutable<LocalWorkflowTaskState>` unchanged, and so tests can
 * build a fixture without the full task shape.
 */
export type WorkflowTaskFields = {
  id: string
  runId?: string
  workflowName: string
  status: TaskStatus
  summary?: string
  agentCount?: number
  error?: string
}

/** Pointer to the surface that owns the interactive controls (kill / skip / retry). */
export const WORKFLOW_PANEL_HINT = 'run /workflows for the full panel'

/** Task statuses map onto run statuses 1:1 except `pending`, which reads as not-yet-progressed. */
export function runStatusFromTask(status: TaskStatus): RunProgress['status'] {
  return status === 'completed' || status === 'failed' || status === 'killed'
    ? status
    : 'running'
}

export type WorkflowStatusLine = {
  glyph: string
  color: string
  name: string
  text: string
}

/**
 * Header line. The live run wins over the task's own status: the registrar writes the
 * terminal status onto the task, but while running the store is the fresher source.
 */
export function workflowStatusLine(
  task: WorkflowTaskFields,
  run: RunProgress | undefined,
): WorkflowStatusLine {
  const status = run?.status ?? runStatusFromTask(task.status)
  return {
    glyph: STATUS_DOT[status],
    color: RUN_STATUS_COLOR[status],
    name: task.workflowName,
    text: RUN_STATUS_TEXT[status],
  }
}

export type WorkflowPhaseRow = {
  title: string
  mark: string
  color: string
  done: number
  total: number
}

/**
 * Phase rows with the panel's own glyphs (○ pending / ● running / ✓ done) and per-phase
 * agent counts. Delegates the merge of declared-vs-observed-vs-agent-only phases to
 * `panel/selectors.mergePhases` so this view and the panel can never disagree.
 */
export function workflowPhaseRows(
  run: RunProgress | undefined,
): WorkflowPhaseRow[] {
  if (!run) return []
  return mergePhases(run).map(phase => ({
    title: phase.title,
    mark: PHASE_MARK[phase.status],
    color: PHASE_COLOR[phase.status],
    done: phase.done,
    total: phase.total,
  }))
}

/**
 * Agent tally. With a live run it breaks down into running/done; without one only the
 * denormalized total the task carries is trustworthy, so it says just that.
 */
export function workflowAgentLine(
  task: WorkflowTaskFields,
  run: RunProgress | undefined,
): string {
  const total = run?.agentCount ?? task.agentCount ?? 0
  if (total === 0) return 'no agents yet'
  const noun = total === 1 ? 'agent' : 'agents'
  if (!run) return `${total} ${noun}`
  const running = run.agents.filter(a => a.status === 'running').length
  const done = run.agents.filter(a => a.status === 'done').length
  return `${total} ${noun} · ${running} running · ${done} done`
}

/**
 * Line shown in place of the phase list when the live run is unavailable (session that
 * never instantiated the workflow service, or a task whose run has aged out of memory).
 */
export function workflowFallbackLine(task: WorkflowTaskFields): string {
  return task.summary ?? 'no phases reported yet'
}
