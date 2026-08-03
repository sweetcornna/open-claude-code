import React, { useCallback, useState, useSyncExternalStore } from 'react';
import type { DeepImmutable } from 'src/types/utils.js';
import { useElapsedTime } from '../../hooks/useElapsedTime.js';
import { Box, Text, type KeyboardEvent } from '@anthropic/ink';
import type { Theme } from '@anthropic/ink';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js';
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

  const elapsedTime = useElapsedTime(task.startTime, task.status === 'running', 1000, 0, task.endTime);
  const killShortcut = useShortcutDisplay('taskDetail:kill', 'TaskDetail', 'x');

  const agents = run?.agents ?? [];
  const clamped = clampAgentIndex(selectedAgent, agents.length);
  const { visible, selectedInWindow, hiddenAbove, hiddenBelow } = windowAgents(agents, clamped);

  const header = workflowStatusLine(task, run);
  const phases = workflowPhaseRows(run);

  const selectedRow = agents[clamped];
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
      case 'killWorkflow':
        if (onKillWorkflow) setConfirmKill({ kind: 'workflow' });
        break;
      case 'back':
        onBack();
        break;
      case 'confirmYes':
        if (confirmKill) executeConfirmed(confirmKill);
        break;
      case 'confirmNo':
        setConfirmKill(null);
        break;
    }
  };

  return (
    <Box flexDirection="column" tabIndex={0} borderStyle="round" onKeyDown={handleKeyDown}>
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
            <KeyboardShortcutHint shortcut="←" action="go back" />
            <KeyboardShortcutHint shortcut="Esc" action="close" />
            {agents.length > 1 && <KeyboardShortcutHint shortcut="↑/↓" action="select agent" />}
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

          {agents.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {hiddenAbove > 0 && <Text color="subtle"> … {hiddenAbove} earlier</Text>}
              <AgentList agents={visible} selectedIndex={selectedInWindow} focused={confirmKill === null} />
              {hiddenBelow > 0 && <Text color="subtle"> … {hiddenBelow} more</Text>}
            </Box>
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
