import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Dialog, Text, useAnimationFrame } from '@anthropic/ink';
import type { Theme } from '@anthropic/ink';
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js';
import { getWorkflowService } from '../service.js';
import type { RunProgress } from '../progress/store.js';
import { AgentDetail } from './AgentDetail.js';
import { AgentList } from './AgentList.js';
import { PhaseSidebar } from './PhaseSidebar.js';
import { TabsBar } from './TabsBar.js';
import { RUN_STATUS_COLOR, RUN_STATUS_TEXT } from './status.js';
import {
  type FocusColumn,
  type WorkflowKeyboardHandlers,
  focusColumnLeftOf,
  useWorkflowKeyboard,
} from './useWorkflowKeyboard.js';
import {
  ALL_PHASE,
  type AgentStatusFilter,
  filterActiveRuns,
  filterAgentsByPhase,
  filterAgentsByStatus,
  formatDuration,
  mergePhases,
  nextAgentStatusFilter,
} from './selectors.js';

/**
 * Clamp the selected index to a valid range (empty list -> 0; out of range -> last position; negative/NaN -> 0).
 * Extracted into a module-level pure function: called inside the panel + unit tested for the same logic, to avoid behavior drift.
 */
export function clampSelected(selected: number, len: number): number {
  if (len === 0) return 0;
  const n = Math.trunc(selected);
  if (Number.isNaN(n) || n < 0) return 0;
  return Math.min(n, len - 1);
}

/**
 * Determine whether the focused run completed the running -> terminal state transition (used for panel auto-exit).
 * Extracted into a pure function for easy unit testing; called directly inside the panel's useEffect.
 *
 * Trigger condition: prev and curr are the same runId, prev is running, curr is completed/failed/killed.
 * - Opening the history panel (prev=null): does not trigger
 * - Switching to an already completed tab (different runId): does not trigger
 * - Same run running -> terminal: triggers
 */
export function isRunTerminatedTransition(
  prev: { runId: string; status: RunProgress['status'] } | null,
  curr: { runId: string; status: RunProgress['status'] } | null,
): boolean {
  if (!prev || !curr) return false;
  if (prev.runId !== curr.runId) return false;
  if (prev.status !== 'running') return false;
  return curr.status === 'completed' || curr.status === 'failed' || curr.status === 'killed';
}

/**
 * /workflows main panel: run tabs on top, phase sidebar on the left, and a
 * right pane that is either the agent list or the selected agent's detail view.
 *
 * - useSyncExternalStore subscribes to WorkflowService (the store returns stable snapshots, no re-render without change).
 * - Focus state: activeRunId / focusColumn('phases'|'agents'|'detail') / selectedPhaseIndex(0=All) / selectedAgentIndex / statusFilter.
 * - Keybindings: Tab switch run · ←/→ step between regions · ↵ open agent detail · ↑/↓ move ·
 *   f cycle status filter · x kill agent · K kill workflow · r resume · q/Esc quit.
 * - ← only ever steps out one region and stops at the phase sidebar; closing the panel is Esc/q's job.
 */
export function WorkflowsPanel({
  onDone,
  context,
}: {
  onDone: LocalJSXCommandOnDone;
  context: LocalJSXCommandContext;
}): React.ReactNode {
  const svc = getWorkflowService();
  const runs = useSyncExternalStore(
    svc.subscribe,
    () => svc.listRuns(),
    () => [],
  );
  // Only in-flight runs reach the tab row. Terminal (completed/failed/killed) runs are hidden so opening
  // the panel no longer floods the row with persisted history (which overflowed the terminal and rendered
  // garbled overlapping text). They stay on disk and remain resumable via getRunAsync.
  const activeRuns = filterActiveRuns(runs);

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [focusColumn, setFocusColumn] = useState<FocusColumn>('phases');
  const [selectedPhaseIndex, setSelectedPhaseIndex] = useState(0);
  const [selectedAgentIndex, setSelectedAgentIndex] = useState(0);
  const [statusFilter, setStatusFilter] = useState<AgentStatusFilter>('all');
  // kill secondary confirmation. null = no dialog; 'workflow' = kill the whole run; 'agent' = kill the currently selected agent.
  // When non-null the keyboard enters confirm mode (only y/Enter/n/Esc/q respond).
  const [confirmKill, setConfirmKill] = useState<null | 'agent' | 'workflow'>(null);

  // On mount, trigger a single disk scan to hydrate historical runs (the service's internal persistedLoaded flag guards idempotency).
  // Re-mount / re-render does not scan again (guarded by the process-singleton flag). The svc reference is stable (getWorkflowService singleton).
  useEffect(() => {
    void svc.loadPersistedRuns();
  }, [svc]);

  // On activeRuns change: activeRunId invalidated (killed / first time) -> clamp to the first one.
  // Tracks activeRuns (not raw runs) so focus never lands on a hidden terminal run.
  useEffect(() => {
    if (activeRuns.length === 0) {
      if (activeRunId !== null) setActiveRunId(null);
      return;
    }
    if (!activeRuns.some(r => r.runId === activeRunId)) {
      setActiveRunId(activeRuns[0]!.runId);
    }
  }, [activeRuns, activeRunId]);

  const focused: RunProgress | undefined = activeRuns.find(r => r.runId === activeRunId);
  const phases = focused ? mergePhases(focused) : [];
  // The sidebar includes the All row: prepend one item to the phases array -> total rows = phases.length + 1
  const phaseRowCount = phases.length + 1;
  const clampedPhase = clampSelected(selectedPhaseIndex, phaseRowCount);

  // Auto-exit the panel when the focused run transitions from running to terminal (800ms delay so the user sees the ✓/✗ terminal state).
  // Only triggered by a state transition on the same runId: switching to an already completed tab (prev was a different run) does not exit; opening the history panel
  // (prev=null) does not exit either. Otherwise the agent is blocked by the panel while waiting for the Workflow tool result, and the user must press q manually.
  const prevFocusedRef = useRef<{ runId: string; status: RunProgress['status'] } | null>(null);
  useEffect(() => {
    const curr = focused ? { runId: focused.runId, status: focused.status } : null;
    const prev = prevFocusedRef.current;
    prevFocusedRef.current = curr;
    if (!isRunTerminatedTransition(prev, curr)) return;
    const timer = setTimeout(() => onDone(), 800);
    return (): void => {
      clearTimeout(timer);
    };
  }, [focused?.runId, focused?.status, onDone]);

  // Selected phase title (0 = All = undefined)
  const selectedPhaseTitle = clampedPhase === 0 ? undefined : phases[clampedPhase - 1]?.title;

  const phaseAgents = focused ? filterAgentsByPhase(focused.agents, selectedPhaseTitle) : [];
  const visibleAgents = filterAgentsByStatus(phaseAgents, statusFilter);
  const clampedAgent = clampSelected(selectedAgentIndex, visibleAgents.length);
  const selectedAgent = visibleAgents[clampedAgent];
  // The detail view has nothing to render once its agent leaves the filtered
  // list (filter change, phase switch, a killed run clearing agents). Fall
  // back to the list rather than rendering an empty pane.
  const effectiveFocus: FocusColumn = focusColumn === 'detail' && selectedAgent === undefined ? 'agents' : focusColumn;

  const switchTab = (runId: string): void => {
    setActiveRunId(runId);
    setFocusColumn('phases');
    setSelectedPhaseIndex(0);
    setSelectedAgentIndex(0);
  };

  const nextTab = (): void => {
    if (activeRuns.length === 0) return;
    const idx = activeRuns.findIndex(r => r.runId === activeRunId);
    const next = activeRuns[(idx + 1) % activeRuns.length]!;
    switchTab(next.runId);
  };
  const prevTab = (): void => {
    if (activeRuns.length === 0) return;
    const idx = activeRuns.findIndex(r => r.runId === activeRunId);
    const next = activeRuns[(idx - 1 + activeRuns.length) % activeRuns.length]!;
    switchTab(next.runId);
  };

  const handlers: WorkflowKeyboardHandlers = {
    nextTab,
    prevTab,
    focusLeft: () => setFocusColumn(focusColumnLeftOf(effectiveFocus)),
    focusRight: () => {
      if (effectiveFocus === 'phases') setFocusColumn('agents');
      // Rightward from the list drills into the selected agent — but only
      // when there is one, so an empty list can't strand focus in a blank pane.
      else if (selectedAgent !== undefined) setFocusColumn('detail');
    },
    openDetail: () => {
      if (selectedAgent !== undefined) setFocusColumn('detail');
    },
    cycleStatusFilter: () => {
      setStatusFilter(nextAgentStatusFilter(statusFilter));
      // The surviving rows are a different set; keeping the old index would
      // silently retarget the selection (and therefore x) at another agent.
      setSelectedAgentIndex(0);
    },
    // In the detail view ↑/↓ keep moving the agent selection, so the pane
    // steps through agents in place instead of forcing a trip back to the list.
    moveUp: () => {
      if (effectiveFocus === 'phases') setSelectedPhaseIndex(s => clampSelected(s - 1, phaseRowCount));
      else setSelectedAgentIndex(s => clampSelected(s - 1, visibleAgents.length));
    },
    moveDown: () => {
      if (effectiveFocus === 'phases') setSelectedPhaseIndex(s => clampSelected(s + 1, phaseRowCount));
      else setSelectedAgentIndex(s => clampSelected(s + 1, visibleAgents.length));
    },
    killAgent: () => {
      // Only pop the agent confirmation when an agent is actually selected
      // (pressing x in the phases column has no target, no-op). The detail
      // view counts: it is showing exactly the agent x would kill.
      // The selected agent is saved into confirmKill and then actually executed by confirmYes -
      // to avoid mis-killing caused by visibleAgents changing between two renders.
      if (effectiveFocus === 'phases' || !focused) return;
      if (selectedAgent === undefined) return;
      setConfirmKill('agent');
    },
    killWorkflow: () => {
      if (!focused) return;
      setConfirmKill('workflow');
    },
    resumeFocused: () => {
      if (!focused) return;
      const canUseTool = context.canUseTool;
      if (!canUseTool) {
        onDone('resume needs canUseTool context; run /<name> resume from the main session.');
        return;
      }
      void svc
        .launch({ resumeFromRunId: focused.runId, name: focused.workflowName }, context, canUseTool)
        .catch(e => onDone(`resume failed: ${(e as Error).message}`));
    },
    newRun: () => onDone('Tip: start a named workflow with /<name>, or pass name via the Workflow tool.'),
    quit: () => {
      // In confirm mode q = cancel confirmation (routeWorkflowKey already routed to confirmNo);
      // only in non-confirm mode does it really exit the panel.
      if (confirmKill !== null) {
        setConfirmKill(null);
        return;
      }
      onDone();
    },
    confirmYes: () => {
      if (confirmKill === 'workflow' && focused) {
        svc.kill(focused.runId);
        // After killing the entire workflow, immediately return to the main chat: the run_done event -> the store reducer changes the status to
        // killed -> notifications.ts bridges enqueuePendingNotification, and the main chat shows
        // `Workflow "<name>" was stopped`. Staying on the panel would instead make the user miss the "stopped" feedback.
        setConfirmKill(null);
        onDone();
        return;
      } else if (confirmKill === 'agent' && focused) {
        if (selectedAgent) svc.killAgent(focused.runId, selectedAgent.id);
      }
      setConfirmKill(null);
    },
    confirmNo: () => setConfirmKill(null),
  };
  useWorkflowKeyboard(handlers, confirmKill !== null ? 'confirm' : 'normal');

  const running = runs.filter(r => r.status === 'running').length;
  const done = runs.length - running;
  const phaseHeader = selectedPhaseTitle ?? ALL_PHASE;
  const agentDone = focused ? focused.agents.filter(a => a.status === 'done').length : 0;
  // Refresh the header duration every second (shared clock; subscribing triggers re-render, duration follows wall clock).
  const [clockRef] = useAnimationFrame(1000);
  const elapsed = focused ? Date.now() - focused.startedAt : 0;

  return (
    <Box ref={clockRef} flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>{focused?.workflowName ?? 'Workflows'}</Text>
        {focused ? (
          <Text color="subtle">
            {agentDone}/{focused.agentCount} agents · {formatDuration(elapsed)} ·{' '}
            <Text color={RUN_STATUS_COLOR[focused.status] as keyof Theme}>{RUN_STATUS_TEXT[focused.status]}</Text>
          </Text>
        ) : (
          <Text color="subtle">
            {running} running · {done} done
          </Text>
        )}
      </Box>
      {focused?.description ? <Text color="subtle">{focused.description}</Text> : null}

      {activeRuns.length > 1 ? (
        <Box marginTop={1}>
          <TabsBar runs={activeRuns} activeRunId={activeRunId} />
        </Box>
      ) : null}

      <Box flexDirection="row" marginTop={1}>
        <Box width="25%" flexDirection="column">
          <Text color={effectiveFocus === 'phases' ? 'claude' : 'subtle'} bold>
            Phases
          </Text>
          <PhaseSidebar
            phases={phases}
            agents={focused?.agents ?? []}
            selectedIndex={clampedPhase}
            focused={effectiveFocus === 'phases'}
          />
        </Box>
        <Text color="subtle">│</Text>
        {effectiveFocus === 'detail' && selectedAgent ? (
          <Box flexGrow={1} flexDirection="column">
            <Text color="claude" bold>
              Agent {clampedAgent + 1}/{visibleAgents.length}
            </Text>
            <AgentDetail agent={selectedAgent} />
          </Box>
        ) : (
          <Box flexGrow={1} flexDirection="column">
            <Text color={effectiveFocus === 'agents' ? 'claude' : 'subtle'} bold>
              {phaseHeader} · {visibleAgents.length} agents
              {/* The failed bucket is `resultKind === 'dead'`, which also catches agents the
                  run reaped on its way down (⊘ stopped). Narrowing the predicate would hide
                  them from every filter, so the header names both instead. */}
              {statusFilter === 'all' ? null : (
                <Text color="warning"> · {statusFilter === 'failed' ? 'failed/stopped' : statusFilter} only</Text>
              )}
            </Text>
            <AgentList
              agents={visibleAgents}
              selectedIndex={clampedAgent}
              focused={effectiveFocus === 'agents'}
              emptyText={
                statusFilter === 'all' ? undefined : `(no ${statusFilter} agents — press f to change the filter)`
              }
            />
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color="subtle">
          {confirmKill !== null
            ? 'Confirm: y kill · n/Esc cancel'
            : effectiveFocus === 'detail'
              ? '↑/↓ prev/next agent · ← back to list · x kill agent · K kill workflow · r resume · q quit'
              : 'Tab switch run · ←/→ focus · ↵ agent detail · ↑/↓ move · f filter · x kill agent · K kill workflow · q quit'}
        </Text>
      </Box>

      {/* hideBorder: Dialog otherwise wraps itself in a Pane whose Divider spans the
          whole terminal. Inside this bordered, padded panel that divider overflows and
          wraps, printing a stray half-line and pushing the panel's own border out of
          alignment. The panel border is the single frame — see Pane's own doc comment. */}
      {confirmKill !== null ? (
        <Box marginTop={1} flexDirection="column">
          <Dialog
            title={
              confirmKill === 'workflow'
                ? `Kill workflow "${focused?.workflowName ?? ''}"?`
                : `Kill agent "${selectedAgent?.label ?? ''}"?`
            }
            subtitle={
              confirmKill === 'workflow'
                ? 'All in-flight agents will be aborted. Resume will replay from journal.'
                : 'Only this agent aborts; other agents in the workflow keep running.'
            }
            onCancel={() => setConfirmKill(null)}
            color="warning"
            hideBorder
          >
            <Text color="subtle">Press y to confirm, or n/Esc to cancel.</Text>
          </Dialog>
        </Box>
      ) : null}
    </Box>
  );
}
