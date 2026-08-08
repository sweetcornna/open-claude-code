import React, { useCallback, useSyncExternalStore } from 'react';
import type { DeepImmutable } from 'src/types/utils.js';
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js';
import type { RunProgress } from '../../workflow/progress/store.js';
import { peekWorkflowService } from '../../workflow/service.js';
import { WorkflowRunPanel } from '../../workflow/panel/WorkflowRunPanel.js';

type Props = {
  task: DeepImmutable<LocalWorkflowTaskState>;
  onBack: () => void;
};

const NO_RUNS: RunProgress[] = [];

function fallbackRun(task: DeepImmutable<LocalWorkflowTaskState>): RunProgress {
  const status: RunProgress['status'] =
    task.status === 'completed'
      ? 'completed'
      : task.status === 'failed'
        ? 'failed'
        : task.status === 'killed'
          ? 'killed'
          : 'running';
  return {
    runId: task.runId,
    workflowName: task.workflowName,
    status,
    phases: [],
    declaredPhases: [],
    currentPhase: null,
    agents: [],
    agentCount: task.agentCount ?? 0,
    startedAt: task.startTime,
    updatedAt: task.endTime ?? Date.now(),
    description: task.description,
    ...(task.error !== undefined ? { error: task.error } : {}),
    ...(task.output !== undefined ? { returnValue: task.output } : {}),
  };
}

/** Single-run adapter used by /tasks, footer clicks, and Shift+task navigation. */
export function WorkflowDetailDialog({ task, onBack }: Props): React.ReactNode {
  const service = peekWorkflowService();
  const subscribe = useCallback((onChange: () => void) => service?.subscribe(onChange) ?? (() => {}), [service]);
  const getSnapshot = useCallback(() => service?.listRuns() ?? NO_RUNS, [service]);
  const runs = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const run = runs.find(candidate => candidate.runId === task.runId) ?? fallbackRun(task);

  return (
    <WorkflowRunPanel
      run={run}
      onClose={onBack}
      onCancelAgent={
        service
          ? (runId, agentId) => {
              service.killAgent(runId, agentId);
            }
          : undefined
      }
      onCancelRun={service ? runId => service.kill(runId) : undefined}
    />
  );
}
