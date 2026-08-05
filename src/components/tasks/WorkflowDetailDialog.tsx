import React, { useCallback, useState, useSyncExternalStore } from 'react';
import type { DeepImmutable } from 'src/types/utils.js';
import { useElapsedTime } from '../../hooks/useElapsedTime.js';
import { Box, Text, type KeyboardEvent } from '@anthropic/ink';
import type { Theme } from '@anthropic/ink';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js';
import { AgentDetail } from '../../workflow/panel/AgentDetail.js';
import { AgentList } from '../../workflow/panel/AgentList.js';
import type { RunProgress } from '../../workflow/progress/store.js';
import { peekWorkflowService } from '../../workflow/service.js';
import { Byline } from '../design-system/Byline.js';
import { Dialog } from '../design-system/Dialog.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';
import { clampAgentIndex, routeWorkflowDetailKey, windowAgents } from './workflowDetailData.js';
import {
  workflowAgentLine,
  workflowFallbackLine,
  workflowPhaseRows,
  workflowStatusLine,
} from './workflowTaskSummaryData.js';

type Props = {
  task: DeepImmutable<LocalWorkflowTaskState>;
  onBack: () => void;
  /** Kill the whole workflow. Undefined once the task left `running`. */
  onKillWorkflow?: (() => void) | undefined;
};

/** Which kill is awaiting confirmation. Agent id is captured at request time so the
 * store appending new agents between request and confirm can't retarget the kill. */
type ConfirmKill = { kind: 'workflow' } | { kind: 'agent'; agentId: number; label: string };

/** Stable empty snapshot — useSyncExternalStore must not see a fresh array each call. */
const NO_RUNS: RunProgress[] = [];

/**
 * Full workflow detail view inside the Shift+Down background tasks dialog.
 *
 * Mirrors the /workflows panel's live view (phase rows + per-agent spinner rows
 * fed by the same ProgressStore) in the dialog's single-column layout, so
 * checking on a workflow doesn't require leaving the tasks overlay. Interactive
 * like the panel: ↑/↓ selects an agent, x kills it, K kills the run — both
 * behind a y/n confirmation. Uses `peekWorkflowService` so opening the dialog
 * never instantiates the service for a session that never ran a workflow.
 */
export function WorkflowDetailDialog({ task, onBack, onKillWorkflow }: Props): React.ReactNode {
  const service = peekWorkflowService();
  const subscribe = useCallback((onChange: () => void) => service?.subscribe(onChange) ?? (() => {}), [service]);
  const getSnapshot = useCallback(() => service?.listRuns() ?? NO_RUNS, [service]);
  const runs = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // A resumed run keeps its original runId while getting a new task id, so runId is the
  // correlation key; fall back to the id for tasks registered before it was stamped.
  const run = runs.find(r => r.runId === (task.runId ?? task.id));

  const [selectedAgent, setSelectedAgent] = useState(0);
  const [confirmKill, setConfirmKill] = useState<ConfirmKill | null>(null);
  /** Whether the dialog is drilled into the selected agent's status view. */
  const [showAgentDetail, setShowAgentDetail] = useState(false);

  const elapsedTime = useElapsedTime(task.startTime, task.status === 'running', 1000, 0, task.endTime);
  const killShortcut = useShortcutDisplay('taskDetail:kill', 'TaskDetail', 'x');

  const agents = run?.agents ?? [];
  const clamped = clampAgentIndex(selectedAgent, agents.length);
  const { visible, selectedInWindow, hiddenAbove, hiddenBelow } = windowAgents(agents, clamped);

  const header = workflowStatusLine(task, run);
  const phases = workflowPhaseRows(run);

  const selectedRow = agents[clamped];
  // The store can drop the row out from under an open detail view (run killed,
  // agents cleared) — fall back to the list rather than an empty pane.
  const agentDetailOpen = showAgentDetail && selectedRow !== undefined;
  const canKillAgent =
    run?.status === 'running' && selectedRow !== undefined && selectedRow.status === 'running' && service !== null;

  const executeConfirmed = (pending: ConfirmKill): void => {
    if (pending.kind === 'workflow') {
      onKillWorkflow?.();
    } else if (run && service) {
      service.killAgent(run.runId, pending.agentId);
    }
    setConfirmKill(null);
  };

  // x flows through the configurable taskDetail:kill binding like every other
  // detail dialog; returning false leaves the key unconsumed when inapplicable.
  useKeybindings(
    {
      'taskDetail:kill': () => {
        if (confirmKill !== null || !canKillAgent || !selectedRow) return false;
        setConfirmKill({
          kind: 'agent',
          agentId: selectedRow.id,
          label: selectedRow.label ?? `agent-${selectedRow.id}`,
        });
      },
    },
    { context: 'TaskDetail' },
  );

  // Esc routes through Dialog's confirm:no keybinding (outer dialog disabled via
  // isCancelActive while the confirmation is open); everything else stays raw.
  const handleKeyDown = (e: KeyboardEvent): void => {
    const action = routeWorkflowDetailKey(e.key, confirmKill !== null ? 'confirm' : 'normal');
    if (action === null) return;
    e.preventDefault();
    switch (action) {
      case 'moveUp':
        setSelectedAgent(clampAgentIndex(clamped - 1, agents.length));
        break;
      case 'moveDown':
        setSelectedAgent(clampAgentIndex(clamped + 1, agents.length));
        break;
      case 'openAgent':
        if (selectedRow) setShowAgentDetail(true);
        break;
      case 'killWorkflow':
        if (onKillWorkflow) setConfirmKill({ kind: 'workflow' });
        break;
      case 'back':
        // ← steps out of the agent view first; only from the list does it
        // leave the dialog. Esc always closes outright.
        if (agentDetailOpen) setShowAgentDetail(false);
        else onBack();
        break;
      case 'confirmYes':
        if (confirmKill) executeConfirmed(confirmKill);
        break;
      case 'confirmNo':
        setConfirmKill(null);
        break;
    }
  };

  // autoFocus is load-bearing, not decoration: ink dispatches keys to
  // focusManager.activeElement (falling back to the root node) and only bubbles
  // upward. Arriving here from the task list unmounts the list, leaving
  // activeElement null — without autoFocus every key routed through onKeyDown
  // (←/↑/↓/↵/K/y/n) is dead on arrival and only the globally-registered
  // bindings (x, Esc) still respond. Every sibling *DetailDialog does the same.
  //
  // No borderStyle here either: the inner Dialog renders a Pane whose Divider is
  // terminal-wide by design. Nesting that inside a bordered, padded box made the
  // divider overflow and wrap, which is what drew the stray line above the title
  // and knocked the border out of alignment. The Pane is the single frame.
  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title={task.workflowName}
        subtitle={
          <Text dimColor>
            {elapsedTime} · {task.description}
          </Text>
        }
        onCancel={onBack}
        isCancelActive={confirmKill === null}
        inputGuide={() => (
          <Byline>
            <KeyboardShortcutHint shortcut="←" action={agentDetailOpen ? 'back to list' : 'go back'} />
            <KeyboardShortcutHint shortcut="Esc" action="close" />
            {agents.length > 1 && <KeyboardShortcutHint shortcut="↑/↓" action="select agent" />}
            {!agentDetailOpen && agents.length > 0 && <KeyboardShortcutHint shortcut="↵" action="agent detail" />}
            {canKillAgent && <KeyboardShortcutHint shortcut={killShortcut} action="stop agent" />}
            {onKillWorkflow && <KeyboardShortcutHint shortcut="K" action="stop workflow" />}
          </Byline>
        )}
      >
        <Box flexDirection="column">
          <Box>
            <Text color={header.color as keyof Theme}>{header.glyph}</Text>
            <Text color="subtle"> {header.text}</Text>
            <Text color="subtle"> · {workflowAgentLine(task, run)}</Text>
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

          {agentDetailOpen && selectedRow ? (
            <Box flexDirection="column" marginTop={1}>
              <AgentDetail agent={selectedRow} />
            </Box>
          ) : (
            agents.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                {hiddenAbove > 0 && <Text color="subtle"> … {hiddenAbove} earlier</Text>}
                <AgentList agents={visible} selectedIndex={selectedInWindow} focused={confirmKill === null} />
                {hiddenBelow > 0 && <Text color="subtle"> … {hiddenBelow} more</Text>}
              </Box>
            )
          )}

          {task.error ? <Text color="error">{task.error}</Text> : null}
        </Box>
      </Dialog>

      {confirmKill !== null ? (
        <Dialog
          title={
            confirmKill.kind === 'workflow'
              ? `Kill workflow "${task.workflowName}"?`
              : `Kill agent "${confirmKill.label}"?`
          }
          subtitle={
            confirmKill.kind === 'workflow'
              ? 'All in-flight agents will be aborted. Resume will replay from journal.'
              : 'Only this agent aborts; other agents in the workflow keep running.'
          }
          onCancel={() => setConfirmKill(null)}
          color="warning"
        >
          <Text color="subtle">Press y to confirm, or n/Esc to cancel.</Text>
        </Dialog>
      ) : null}
    </Box>
  );
}
