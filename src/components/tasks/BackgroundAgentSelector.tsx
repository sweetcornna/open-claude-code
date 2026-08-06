import { Box, Text } from '@anthropic/ink';
import figures from 'figures';
import { useBackgroundAgentTasks } from '../../hooks/useBackgroundAgentTasks.js';
import { useElapsedTime } from '../../hooks/useElapsedTime.js';
import { useAppState } from '../../state/AppState.js';
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js';
import { formatTokens } from '../../utils/text/format.js';
import { getAgentRowDescription, getAgentStatusDotColor } from './taskStatusUtils.js';

/** Status dot. Always filled — the glyph carries status via color, not shape. */
const STATUS_DOT = '●';

const SELECTED_PREFIX = `${figures.pointer} `;
const UNSELECTED_PREFIX = '  ';

export function AgentRow({ task, selected }: { task: LocalAgentTaskState; selected: boolean }): React.ReactNode {
  const elapsed = useElapsedTime(task.startTime, task.status === 'running', 1000, 0, undefined, task.startTimeMono);
  const tokens = task.progress?.tokenCount ?? 0;
  return (
    <Box flexDirection="row" width="100%" justifyContent="space-between">
      <Box flexDirection="row" flexShrink={1}>
        <Text bold={selected}>{selected ? SELECTED_PREFIX : UNSELECTED_PREFIX}</Text>
        <Text color={getAgentStatusDotColor(task.status)}>{STATUS_DOT} </Text>
        <Text bold={selected} wrap="truncate-end">
          {task.agentType} <Text dimColor>{getAgentRowDescription(task)}</Text>
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor>
          {elapsed} · ↓ {formatTokens(tokens)} tokens
        </Text>
      </Box>
    </Box>
  );
}

function getHint(pillFocused: boolean, viewedTask: LocalAgentTaskState | null): string {
  if (pillFocused) return '↑/↓ to select · Enter to view';
  if (!viewedTask) return 'shift+↓ to manage background agents';
  return viewedTask.status === 'running' ? 'shift+↓ to manage · x to stop' : 'shift+↓ to manage · x to clear';
}

export function BackgroundAgentSelector(): React.ReactNode {
  const tasks = useBackgroundAgentTasks();
  const viewingId = useAppState(s => s.viewingAgentTaskId);
  const footerSelection = useAppState(s => s.footerSelection);
  const selectedBgIndex = useAppState(s => s.selectedBgAgentIndex);

  if (tasks.length === 0) return null;

  const pillFocused = footerSelection === 'bg_agent';
  const highlightedId = pillFocused
    ? selectedBgIndex === -1
      ? null
      : (tasks[selectedBgIndex]?.agentId ?? null)
    : (viewingId ?? null);
  const mainHighlighted = pillFocused ? selectedBgIndex === -1 : viewingId === undefined;
  const viewedTask = viewingId ? (tasks.find(t => t.agentId === viewingId) ?? null) : null;

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" width="100%" justifyContent="space-between">
        {/* Main row stays neutral — it has no agent status to report. */}
        <Text bold={mainHighlighted}>
          {mainHighlighted ? SELECTED_PREFIX : UNSELECTED_PREFIX}
          {STATUS_DOT} main
        </Text>
        <Text dimColor>{getHint(pillFocused, viewedTask)}</Text>
      </Box>
      {tasks.map(task => (
        <AgentRow key={task.agentId} task={task} selected={task.agentId === highlightedId} />
      ))}
    </Box>
  );
}
