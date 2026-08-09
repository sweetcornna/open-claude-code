import React, { useEffect, useRef, useState } from 'react';
import { Box, ScrollBox, Text, type ScrollBoxHandle, useAnimationFrame } from '@anthropic/ink';
import type { DOMElement, Theme } from '@anthropic/ink';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import type { AgentProgress, RunProgress } from '../progress/store.js';
import { AgentDetail } from './AgentDetail.js';
import { AgentList } from './AgentList.js';
import { PhaseSidebar } from './PhaseSidebar.js';
import {
  ALL_PHASE,
  type AgentStatusFilter,
  filterAgentsByPhase,
  filterAgentsByStatus,
  formatDuration,
  mergePhases,
  nextAgentStatusFilter,
} from './selectors.js';
import { NO_AGENT_SELECTED, resolveAgentSelection, windowAgents } from './state.js';
import { RUN_STATUS_COLOR, RUN_STATUS_TEXT } from './status.js';
import { TabsBar } from './TabsBar.js';
import {
  type FocusColumn,
  type WorkflowKeyboardHandlers,
  focusColumnLeftOf,
  focusColumnRightOf,
  useWorkflowKeyboard,
} from './useWorkflowKeyboard.js';

const WORKFLOW_PANEL_MAX_WIDTH = 110;
const WORKFLOW_PANEL_MAX_HEIGHT = 28;
const WIDE_LAYOUT_MIN = 78;
const MEDIUM_LAYOUT_MIN = 48;
const HEADER_ROWS = 4;
const FOOTER_ROWS = 2;
const FRAME_ROWS = 2;
const FRAME_COLUMNS = 4;

type PanelLayout = 'wide' | 'medium' | 'narrow';
type CancelTarget =
  | { kind: 'workflow'; runId: string; label: string }
  | { kind: 'agent'; runId: string; agentId: number; label: string };

type WorkflowRunPanelProps = {
  run: RunProgress | undefined;
  runs?: RunProgress[];
  onNextRun?: () => void;
  onPreviousRun?: () => void;
  onClose: () => void;
  onCancelAgent?: (runId: string, agentId: number) => void;
  onCancelRun?: (runId: string) => void;
  onResume?: (run: RunProgress) => void;
  onNewRun?: () => void;
  /** Test/layout probe; production adapters leave this unset. */
  panelRef?: (element: DOMElement | null) => void;
};

function workflowPanelSize(columns: number, rows: number): { width: number; height: number } {
  const safeColumns = Number.isFinite(columns) ? Math.max(1, Math.trunc(columns)) : WORKFLOW_PANEL_MAX_WIDTH;
  const safeRows = Number.isFinite(rows) ? Math.max(1, Math.trunc(rows)) : WORKFLOW_PANEL_MAX_HEIGHT;
  return {
    width: Math.min(WORKFLOW_PANEL_MAX_WIDTH, safeColumns),
    height: Math.min(WORKFLOW_PANEL_MAX_HEIGHT, safeRows),
  };
}

function workflowPanelLayout(width: number): PanelLayout {
  if (width >= WIDE_LAYOUT_MIN) return 'wide';
  if (width >= MEDIUM_LAYOUT_MIN) return 'medium';
  return 'narrow';
}

function sameSelection(
  left: { agentId: number | null; visualIndex: number },
  right: { agentId: number | null; visualIndex: number },
): boolean {
  return left.agentId === right.agentId && left.visualIndex === right.visualIndex;
}

function paneOrder(layout: PanelLayout): FocusColumn[] {
  if (layout === 'medium') return ['agents', 'detail'];
  return ['phases', 'agents', 'detail'];
}

function cyclePane(current: FocusColumn, layout: PanelLayout, delta: 1 | -1): FocusColumn {
  const panes = paneOrder(layout);
  const currentIndex = panes.indexOf(current);
  const start = currentIndex >= 0 ? currentIndex : 0;
  return panes[(start + delta + panes.length) % panes.length]!;
}

function runOutcomeText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function RunOutcome({ run }: { run: RunProgress }): React.ReactNode {
  if (run.error === undefined && run.returnValue === undefined) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {run.error !== undefined ? (
        <>
          <Text color="error" bold>
            Workflow error
          </Text>
          <Text color="error">{run.error}</Text>
        </>
      ) : null}
      {run.returnValue !== undefined ? (
        <>
          <Text bold>Workflow result</Text>
          <Text color="subtle">{runOutcomeText(run.returnValue)}</Text>
        </>
      ) : null}
    </Box>
  );
}

function EmptyDetail({ run, hasAgents }: { run: RunProgress | undefined; hasAgents: boolean }): React.ReactNode {
  if (!run) return <Text color="subtle">No active workflow runs.</Text>;
  return (
    <Box flexDirection="column">
      <Text color="subtle">
        {hasAgents ? 'No agent selected — x stops the whole run (↓ picks an agent).' : 'No agents have started yet.'}
      </Text>
      <RunOutcome run={run} />
    </Box>
  );
}

function VerticalDivider({ height }: { height: number }): React.ReactNode {
  return (
    <Box width={1} height={height} flexDirection="column" overflowY="hidden">
      {Array.from({ length: height }, (_, index) => (
        <Text color="subtle" key={index}>
          │
        </Text>
      ))}
    </Box>
  );
}

export function WorkflowRunPanel({
  run,
  runs,
  onNextRun,
  onPreviousRun,
  onClose,
  onCancelAgent,
  onCancelRun,
  onResume,
  onNewRun,
  panelRef,
}: WorkflowRunPanelProps): React.ReactNode {
  const { columns, rows } = useTerminalSize();
  const { width, height } = workflowPanelSize(columns, rows);
  const layout = workflowPanelLayout(width);
  const innerWidth = Math.max(1, width - FRAME_COLUMNS);
  const bodyHeight = Math.max(1, height - HEADER_ROWS - FOOTER_ROWS - FRAME_ROWS);
  const paneContentHeight = Math.max(1, bodyHeight - 1);

  const [activePane, setActivePane] = useState<FocusColumn>('agents');
  const [selection, setSelection] = useState({ agentId: null as number | null, visualIndex: 0 });
  const [selectedPhase, setSelectedPhase] = useState<string>(run?.currentPhase ?? ALL_PHASE);
  const [statusFilter, setStatusFilter] = useState<AgentStatusFilter>('all');
  const [confirmTarget, setConfirmTarget] = useState<CancelTarget | null>(null);
  const detailScrollRef = useRef<ScrollBoxHandle | null>(null);
  const runIdRef = useRef(run?.runId);

  useEffect(() => {
    if (runIdRef.current === run?.runId) return;
    runIdRef.current = run?.runId;
    setSelection({ agentId: null, visualIndex: 0 });
    setSelectedPhase(run?.currentPhase ?? ALL_PHASE);
    setStatusFilter('all');
    setActivePane('agents');
    setConfirmTarget(null);
  }, [run?.runId, run?.currentPhase]);

  useEffect(() => {
    if (layout === 'medium' && activePane === 'phases') setActivePane('agents');
  }, [activePane, layout]);

  const allAgents = run?.agents ?? [];
  const phases = run ? mergePhases(run) : [];
  const phaseTitles = [ALL_PHASE, ...phases.map(phase => phase.title)];
  const selectedPhaseIndex = Math.max(0, phaseTitles.indexOf(selectedPhase));
  const selectedPhaseTitle = phaseTitles[selectedPhaseIndex];
  const visibleAgents = filterAgentsByStatus(filterAgentsByPhase(allAgents, selectedPhaseTitle), statusFilter);
  const resolvedSelection = resolveAgentSelection(visibleAgents, selection);
  const selectedAgent = resolvedSelection.agent;

  useEffect(() => {
    setSelection(current => (sameSelection(current, resolvedSelection.next) ? current : resolvedSelection.next));
  }, [resolvedSelection.next.agentId, resolvedSelection.next.visualIndex]);

  useEffect(() => {
    detailScrollRef.current?.scrollTo(0);
  }, [run?.runId, selectedAgent?.id]);

  const agentRowBudget = Math.max(1, paneContentHeight - 2);
  const agentWindow = windowAgents(visibleAgents, resolvedSelection.index, agentRowBudget);

  const requestCancel = (): void => {
    if (!run || run.status !== 'running') return;
    if (activePane === 'phases' || !selectedAgent) {
      if (!onCancelRun) return;
      setConfirmTarget({ kind: 'workflow', runId: run.runId, label: run.workflowName });
      return;
    }
    if (selectedAgent.status !== 'running' || !onCancelAgent) return;
    setConfirmTarget({
      kind: 'agent',
      runId: run.runId,
      agentId: selectedAgent.id,
      label: selectedAgent.label ?? `agent-${selectedAgent.id}`,
    });
  };

  const confirmCancel = (): void => {
    if (!confirmTarget) return;
    if (confirmTarget.kind === 'workflow') onCancelRun?.(confirmTarget.runId);
    else onCancelAgent?.(confirmTarget.runId, confirmTarget.agentId);
    setConfirmTarget(null);
  };

  const moveAgent = (delta: 1 | -1): void => {
    if (visibleAgents.length === 0) return;
    const from = resolvedSelection.index;
    // ↑ off the top of the list parks on "nothing selected" instead of sticking to
    // row 0. That row is the only run-level cancel target in the 48–77 column layout,
    // which has no phases pane to focus.
    if (delta === -1 && from <= 0) {
      setSelection({ agentId: null, visualIndex: NO_AGENT_SELECTED });
      return;
    }
    const index = Math.min(visibleAgents.length - 1, Math.max(0, from + delta));
    const agent = visibleAgents[index];
    setSelection({ agentId: agent?.id ?? null, visualIndex: index });
  };

  const movePhase = (delta: 1 | -1): void => {
    const index = Math.min(phaseTitles.length - 1, Math.max(0, selectedPhaseIndex + delta));
    setSelectedPhase(phaseTitles[index] ?? ALL_PHASE);
  };

  const moveFocusedSelection = (delta: 1 | -1): void => {
    if (activePane === 'phases') movePhase(delta);
    else if (activePane === 'agents') moveAgent(delta);
  };

  const movePane = (direction: 'left' | 'right'): void => {
    if (layout === 'narrow') {
      setActivePane(current => cyclePane(current, layout, direction === 'right' ? 1 : -1));
      return;
    }
    if (layout === 'medium') {
      setActivePane(direction === 'right' ? 'detail' : 'agents');
      return;
    }
    setActivePane(current => (direction === 'right' ? focusColumnRightOf(current) : focusColumnLeftOf(current)));
  };

  const handlers: WorkflowKeyboardHandlers = {
    nextPane: () => setActivePane(current => cyclePane(current, layout, 1)),
    prevPane: () => setActivePane(current => cyclePane(current, layout, -1)),
    nextRun: () => onNextRun?.(),
    prevRun: () => onPreviousRun?.(),
    focusLeft: () => movePane('left'),
    focusRight: () => movePane('right'),
    moveUp: () => moveFocusedSelection(-1),
    moveDown: () => moveFocusedSelection(1),
    openDetail: () => {
      if (selectedAgent) setActivePane('detail');
    },
    cycleStatusFilter: () => setStatusFilter(current => nextAgentStatusFilter(current)),
    cancelTarget: requestCancel,
    pageUp: () => detailScrollRef.current?.scrollBy(-Math.max(1, paneContentHeight - 2)),
    pageDown: () => detailScrollRef.current?.scrollBy(Math.max(1, paneContentHeight - 2)),
    resumeFocused: () => {
      if (run) onResume?.(run);
    },
    newRun: () => onNewRun?.(),
    quit: () => {
      if (confirmTarget) setConfirmTarget(null);
      else onClose();
    },
    confirmYes: confirmCancel,
    confirmNo: () => setConfirmTarget(null),
  };
  useWorkflowKeyboard(handlers, confirmTarget ? 'confirm' : 'normal');

  const [clockRef] = useAnimationFrame(1000);
  const elapsed = run ? Math.max(0, (run.status === 'running' ? Date.now() : run.updatedAt) - run.startedAt) : 0;
  const doneAgents = run?.agents.filter(agent => agent.status === 'done').length ?? 0;
  const statusText = run
    ? `${doneAgents}/${run.agentCount} agents · ${formatDuration(elapsed)} · ${RUN_STATUS_TEXT[run.status]}`
    : 'no active runs';

  const phaseWidth = Math.max(16, Math.floor(innerWidth * 0.2));
  const agentWidthWide = Math.max(28, Math.floor(innerWidth * 0.35));
  const detailWidthWide = Math.max(1, innerWidth - phaseWidth - agentWidthWide - 2);
  const agentWidthMedium = Math.max(22, Math.floor(innerWidth * 0.44));
  const detailWidthMedium = Math.max(1, innerWidth - agentWidthMedium - 1);
  const phasePaneWidth = layout === 'narrow' ? innerWidth : phaseWidth;
  const agentPaneWidth = layout === 'wide' ? agentWidthWide : layout === 'medium' ? agentWidthMedium : innerWidth;

  const phasePane = (
    <Box width="100%" height={bodyHeight} flexDirection="column" overflow="hidden">
      <Text color={activePane === 'phases' ? 'claude' : 'subtle'} bold wrap="truncate-end">
        Workflow phases
      </Text>
      <PhaseSidebar
        phases={phases}
        agents={allAgents}
        selectedIndex={selectedPhaseIndex}
        focused={activePane === 'phases'}
        width={phasePaneWidth}
        maxRows={paneContentHeight}
      />
    </Box>
  );

  const agentPane = (
    <Box width="100%" height={bodyHeight} flexDirection="column" overflow="hidden">
      <Text color={activePane === 'agents' ? 'claude' : 'subtle'} bold wrap="truncate-end">
        Agents · {visibleAgents.length}
        {statusFilter === 'all' ? '' : ` · ${statusFilter}`}
      </Text>
      <Box height={paneContentHeight} flexDirection="column" overflowY="hidden">
        {agentWindow.hiddenAbove > 0 ? <Text color="subtle">… {agentWindow.hiddenAbove} earlier</Text> : null}
        <AgentList
          agents={agentWindow.visible}
          selectedIndex={agentWindow.selectedInWindow}
          focused={activePane === 'agents'}
          width={agentPaneWidth}
          emptyText={statusFilter === 'all' ? undefined : `(no ${statusFilter} agents — press f)`}
        />
        {agentWindow.hiddenBelow > 0 ? <Text color="subtle">… {agentWindow.hiddenBelow} more</Text> : null}
      </Box>
    </Box>
  );

  const detailPane = (
    <Box width="100%" height={bodyHeight} flexDirection="column" overflow="hidden">
      <Text color={activePane === 'detail' ? 'claude' : 'subtle'} bold wrap="truncate-end">
        {selectedAgent ? `Agent ${resolvedSelection.index + 1}/${visibleAgents.length}` : 'Agent detail'}
      </Text>
      <ScrollBox ref={detailScrollRef} width="100%" height={paneContentHeight}>
        {selectedAgent ? (
          <Box flexDirection="column">
            <AgentDetail agent={selectedAgent} />
            {run ? <RunOutcome run={run} /> : null}
          </Box>
        ) : (
          <EmptyDetail run={run} hasAgents={visibleAgents.length > 0} />
        )}
      </ScrollBox>
    </Box>
  );

  const normalBody =
    layout === 'wide' ? (
      <Box height={bodyHeight} overflow="hidden">
        <Box width={phaseWidth}>{phasePane}</Box>
        <VerticalDivider height={bodyHeight} />
        <Box width={agentWidthWide}>{agentPane}</Box>
        <VerticalDivider height={bodyHeight} />
        <Box width={detailWidthWide}>{detailPane}</Box>
      </Box>
    ) : layout === 'medium' ? (
      <Box height={bodyHeight} overflow="hidden">
        <Box width={agentWidthMedium}>{agentPane}</Box>
        <VerticalDivider height={bodyHeight} />
        <Box width={detailWidthMedium}>{detailPane}</Box>
      </Box>
    ) : (
      <Box height={bodyHeight} overflow="hidden">
        {activePane === 'phases' ? phasePane : activePane === 'detail' ? detailPane : agentPane}
      </Box>
    );

  // Mirrors requestCancel exactly — the footer promising `x stop <agent>` while the
  // key aimed at the run (or at nothing) is how the missing run-level target stayed
  // invisible in the medium layout.
  const targetText =
    run?.status !== 'running'
      ? 'none'
      : activePane === 'phases' || !selectedAgent
        ? 'workflow'
        : selectedAgent.status === 'running'
          ? (selectedAgent.label ?? `agent-${selectedAgent.id}`)
          : 'none';

  return (
    <Box
      ref={element => {
        clockRef(element);
        panelRef?.(element);
      }}
      width={width}
      height={height}
      flexDirection="column"
      borderStyle="round"
      borderColor="claude"
      paddingX={1}
      overflow="hidden"
      tabIndex={0}
      autoFocus
    >
      <Box height={HEADER_ROWS} flexDirection="column" overflow="hidden">
        <Box height={1} justifyContent="space-between" overflow="hidden">
          <Box flexShrink={1} overflow="hidden">
            <Text bold wrap="truncate-end">
              {run?.workflowName ?? 'Workflows'}
            </Text>
          </Box>
          <Box flexShrink={0} marginLeft={1}>
            <Text color={run ? (RUN_STATUS_COLOR[run.status] as keyof Theme) : 'subtle'} wrap="truncate-end">
              {statusText}
            </Text>
          </Box>
        </Box>
        <Box height={1} overflow="hidden">
          <Text color="subtle" wrap="truncate-end">
            {run?.description ?? ' '}
          </Text>
        </Box>
        <Box height={2} overflow="hidden">
          {runs && runs.length > 0 ? (
            <TabsBar runs={runs} activeRunId={run?.runId ?? null} maxWidth={innerWidth} />
          ) : (
            <Text color="subtle" wrap="truncate-end">
              {run ? `run ${run.runId}` : ' '}
            </Text>
          )}
        </Box>
      </Box>

      <Box height={bodyHeight} overflow="hidden">
        {confirmTarget ? (
          <Box width="100%" height={bodyHeight} flexDirection="column" justifyContent="center" alignItems="center">
            <Text color="warning" bold wrap="truncate-end">
              Stop{' '}
              {confirmTarget.kind === 'workflow'
                ? `workflow “${confirmTarget.label}”`
                : `agent “${confirmTarget.label}”`}
              ?
            </Text>
            <Text color="subtle" wrap="truncate-end">
              {confirmTarget.kind === 'workflow'
                ? 'All in-flight agents will stop; the durable run can still be resumed.'
                : 'Other agents in this workflow will keep running.'}
            </Text>
          </Box>
        ) : (
          normalBody
        )}
      </Box>

      <Box height={FOOTER_ROWS} flexDirection="column" overflow="hidden">
        <Text color="subtle" wrap="truncate-end">
          {confirmTarget ? 'y/Enter stop · n/Esc cancel' : '↑/↓ select row · ←/→/Tab pane · [/] run · PgUp/PgDn detail'}
        </Text>
        <Text color="subtle" wrap="truncate-end">
          {confirmTarget ? `Target: ${confirmTarget.label}` : `f filter · x stop ${targetText} · r resume · Esc close`}
        </Text>
      </Box>
    </Box>
  );
}
