import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js';
import type { RunProgress } from '../progress/store.js';
import { getWorkflowService } from '../service.js';
import { filterActiveRuns } from './selectors.js';
import { WorkflowRunPanel } from './WorkflowRunPanel.js';

export function isRunTerminatedTransition(
  prev: { runId: string; status: RunProgress['status'] } | null,
  curr: { runId: string; status: RunProgress['status'] } | null,
): boolean {
  if (!prev || !curr) return false;
  if (prev.runId !== curr.runId || prev.status !== 'running') return false;
  return curr.status === 'completed' || curr.status === 'failed' || curr.status === 'killed';
}

/**
 * /workflows adapter. Subscription, active-run tab selection, resume context,
 * and command completion stay here; all run rendering and interaction lives in
 * WorkflowRunPanel so task/footer entry points cannot drift.
 */
export function WorkflowsPanel({
  onDone,
  context,
}: {
  onDone: LocalJSXCommandOnDone;
  context: LocalJSXCommandContext;
}): React.ReactNode {
  const service = getWorkflowService();
  const runs = useSyncExternalStore(
    service.subscribe,
    () => service.listRuns(),
    () => [],
  );
  const activeRuns = filterActiveRuns(runs);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  useEffect(() => {
    void service.loadPersistedRuns();
  }, [service]);

  const focused = runs.find(run => run.runId === activeRunId);
  useEffect(() => {
    // Retain a just-finished focused run until the delayed command close below;
    // otherwise its result/error flashes out before the user can see it.
    if (focused && focused.status !== 'running') return;
    if (activeRuns.length === 0) {
      if (activeRunId !== null) setActiveRunId(null);
      return;
    }
    if (!activeRuns.some(run => run.runId === activeRunId)) {
      setActiveRunId(activeRuns[0]!.runId);
    }
  }, [activeRunId, activeRuns, focused]);

  const previousFocused = useRef<{ runId: string; status: RunProgress['status'] } | null>(null);
  useEffect(() => {
    const current = focused ? { runId: focused.runId, status: focused.status } : null;
    const previous = previousFocused.current;
    previousFocused.current = current;
    if (!isRunTerminatedTransition(previous, current)) return;
    const timer = setTimeout(() => onDone(), 800);
    return (): void => clearTimeout(timer);
  }, [focused?.runId, focused?.status, onDone]);

  const switchRun = (delta: 1 | -1): void => {
    if (activeRuns.length === 0) return;
    const index = activeRuns.findIndex(run => run.runId === activeRunId);
    const base = index >= 0 ? index : 0;
    setActiveRunId(activeRuns[(base + delta + activeRuns.length) % activeRuns.length]!.runId);
  };

  const displayRuns =
    focused && focused.status !== 'running'
      ? [focused, ...activeRuns.filter(run => run.runId !== focused.runId)]
      : activeRuns;

  return (
    <WorkflowRunPanel
      run={focused}
      runs={displayRuns}
      onNextRun={() => switchRun(1)}
      onPreviousRun={() => switchRun(-1)}
      onClose={() => onDone()}
      onCancelAgent={(runId, agentId) => {
        service.killAgent(runId, agentId);
      }}
      onCancelRun={runId => service.kill(runId)}
      onResume={run => {
        const canUseTool = context.canUseTool;
        if (!canUseTool) {
          onDone('resume needs canUseTool context; run /<name> resume from the main session.');
          return;
        }
        void service
          .launch({ resumeFromRunId: run.runId, name: run.workflowName }, context, canUseTool)
          .catch(error => onDone(`resume failed: ${(error as Error).message}`));
      }}
      onNewRun={() => onDone('Tip: start a named workflow with /<name>, or pass name via the Workflow tool.')}
    />
  );
}
