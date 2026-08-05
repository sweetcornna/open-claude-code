import React from 'react';
import type { DeepImmutable } from 'src/types/utils.js';
import { useElapsedTime } from '../../hooks/useElapsedTime.js';
import { Box, Text, type KeyboardEvent } from '@anthropic/ink';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import type { MonitorMcpTaskState } from '../../tasks/MonitorMcpTask/MonitorMcpTask.js';
import { Byline } from '../design-system/Byline.js';
import { Dialog } from '../design-system/Dialog.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';

type Props = {
  task: DeepImmutable<MonitorMcpTaskState>;
  onBack?: () => void;
  onKill?: () => void;
};

/**
 * Detail dialog for MCP monitor tasks shown in the Shift+Down background
 * tasks overlay. Displays the server name, resource URI, and current status.
 * Follows the DreamDetailDialog/ShellDetailDialog pattern.
 */
export function MonitorMcpDetailDialog({ task, onBack, onKill }: Props): React.ReactNode {
  const elapsedTime = useElapsedTime(task.startTime, task.status === 'running', 1000, 0);

  const killShortcut = useShortcutDisplay('taskDetail:kill', 'TaskDetail', 'x');

  // Returning false leaves the key unconsumed so it keeps propagating, matching
  // the old raw handler which simply didn't call preventDefault when not running.
  useKeybindings(
    {
      'taskDetail:kill': () => {
        if (task.status !== 'running' || !onKill) return false;
        onKill();
      },
    },
    { context: 'TaskDetail' },
  );

  // left (back) stays raw — generic dialog navigation, see the TaskDetail block
  // in defaultBindings.ts.
  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'left' && onBack) {
      e.preventDefault();
      onBack();
    }
  };

  // autoFocus + no border, for the same two reasons as WorkflowDetailDialog:
  // ink only dispatches keys to the focused node (so ← would never arrive), and
  // the inner Dialog's Pane draws a terminal-wide Divider that overflows when
  // wrapped in a bordered box.
  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title="MCP Monitor"
        subtitle={
          <Text dimColor>
            {elapsedTime} · {task.serverName}:{task.resourceUri}
          </Text>
        }
        onCancel={onBack ?? (() => {})}
        inputGuide={() => (
          <Byline>
            {onBack && <KeyboardShortcutHint shortcut="←" action="go back" />}
            <KeyboardShortcutHint shortcut="Esc" action="close" />
            {task.status === 'running' && onKill && <KeyboardShortcutHint shortcut={killShortcut} action="stop" />}
          </Byline>
        )}
      >
        <Box flexDirection="column" gap={1}>
          <Text>
            <Text bold>Status:</Text>{' '}
            {task.status === 'running' ? (
              <Text color="ansi:green">running</Text>
            ) : task.status === 'completed' ? (
              <Text color="ansi:green">{task.status}</Text>
            ) : (
              <Text color="ansi:red">{task.status}</Text>
            )}
          </Text>
          <Text>
            <Text bold>Description:</Text> {task.description}
          </Text>
          <Text>
            <Text bold>Server:</Text> {task.serverName}
          </Text>
          <Text>
            <Text bold>Resource:</Text> {task.resourceUri}
          </Text>
          {task.command && (
            <Text>
              <Text bold>Command:</Text> {task.command}
            </Text>
          )}
        </Box>
      </Dialog>
    </Box>
  );
}
