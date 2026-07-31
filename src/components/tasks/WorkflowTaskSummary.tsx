import React, { useCallback, useSyncExternalStore } from 'react';
import { Box, Text } from '@anthropic/ink';
import type { Theme } from '@anthropic/ink';
import type { RunProgress } from 'src/workflow/progress/store.js';
import { peekWorkflowService } from 'src/workflow/service.js';
import {
  WORKFLOW_PANEL_HINT,
  workflowAgentLine,
  workflowFallbackLine,
  workflowPhaseRows,
  workflowStatusLine,
  type WorkflowTaskFields,
} from './workflowTaskSummaryData.js';

export type { WorkflowTaskFields };

/**
 * Read-only compact view of a workflow run, rendered inside the Shift+Down dialog.
 *
 * Presentational and pure — `run` is passed in — so it renders identically whether the live
 * ProgressStore has the run or not (a task whose run aged out, or a session where the
 * workflow service was never instantiated, falls back to the denormalized fields the task
 * itself carries). All shaping lives in ./workflowTaskSummaryData.
 *
 * Deliberately no interactivity: kill / skip / retry stay in the /workflows panel.
 */
export function WorkflowRunSummaryView({
  task,
  run,
}: {
  task: WorkflowTaskFields;
  run?: RunProgress | undefined;
}): React.ReactNode {
  const header = workflowStatusLine(task, run);
  const phases = workflowPhaseRows(run);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={header.color as keyof Theme}>{header.glyph}</Text>
        <Text bold> {header.name}</Text>
        <Text color="subtle"> · {header.text}</Text>
      </Box>

      {phases.length > 0 ? (
        phases.map(phase => (
          <Box key={phase.title}>
            <Text color={phase.color as keyof Theme}> {phase.mark}</Text>
            <Text> {phase.title}</Text>
            <Text color="subtle">
              {'  '}
              {phase.done}/{phase.total}
            </Text>
          </Box>
        ))
      ) : (
        <Text color="subtle"> {workflowFallbackLine(task)}</Text>
      )}

      <Text color="subtle"> {workflowAgentLine(task, run)}</Text>

      {task.error ? <Text color="error">{task.error}</Text> : null}

      <Text dimColor>{WORKFLOW_PANEL_HINT}</Text>
    </Box>
  );
}

/** Stable empty snapshot — useSyncExternalStore must not see a fresh array each call. */
const NO_RUNS: RunProgress[] = [];

/**
 * Store-connected wrapper. Uses `peekWorkflowService` rather than `getWorkflowService` so
 * merely opening the dialog never instantiates the service (and its ports / journal side
 * effects) for a session that never ran a workflow.
 */
export function WorkflowTaskSummary({ task }: { task: WorkflowTaskFields }): React.ReactNode {
  const service = peekWorkflowService();
  const subscribe = useCallback((onChange: () => void) => service?.subscribe(onChange) ?? (() => {}), [service]);
  const getSnapshot = useCallback(() => service?.listRuns() ?? NO_RUNS, [service]);
  const runs = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // A resumed run keeps its original runId while getting a new task id, so runId is the
  // correlation key; fall back to the id for tasks registered before it was stamped.
  const run = runs.find(r => r.runId === (task.runId ?? task.id));
  return <WorkflowRunSummaryView task={task} run={run} />;
}
