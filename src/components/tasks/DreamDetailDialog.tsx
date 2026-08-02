import React from 'react';
import type { DeepImmutable } from 'src/types/utils.js';
import { useElapsedTime } from '../../hooks/useElapsedTime.js';
import { type KeyboardEvent, Box, Text } from '@anthropic/ink';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import type { DreamTaskState } from '../../tasks/DreamTask/DreamTask.js';
import { plural } from '../../utils/text/stringUtils.js';
import { Byline, Dialog, KeyboardShortcutHint } from '@anthropic/ink';

type Props = {
  task: DeepImmutable<DreamTaskState>;
  onDone: () => void;
  onBack?: () => void;
  onKill?: () => void;
};

// How many recent turns to render. Earlier turns collapse to a count.
const VISIBLE_TURNS = 6;

export function DreamDetailDialog({ task, onDone, onBack, onKill }: Props): React.ReactNode {
  const elapsedTime = useElapsedTime(task.startTime, task.status === 'running', 1000, 0);
  const killShortcut = useShortcutDisplay('taskDetail:kill', 'TaskDetail', 'x');

  // Dialog handles confirm:no (Esc) → onCancel. Wire confirm:yes (Enter) too.
  useKeybindings({ 'confirm:yes': onDone }, { context: 'Confirmation' });

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

  // space (close) and left (back) stay raw — generic dialog navigation, see the
  // TaskDetail block in defaultBindings.ts.
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault();
      onDone();
    } else if (e.key === 'left' && onBack) {
      e.preventDefault();
      onBack();
    }
  };

  // Turns with text to show. Tool-only turns (text='') are dropped entirely —
  // the per-turn toolUseCount already captures that work.
  const visibleTurns = task.turns.filter(t => t.text !== '');
  const shown = visibleTurns.slice(-VISIBLE_TURNS);
  const hidden = visibleTurns.length - shown.length;

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title="Memory consolidation"
        subtitle={
          <Text dimColor>
            {elapsedTime} · reviewing {task.sessionsReviewing} {plural(task.sessionsReviewing, 'session')}
            {task.filesTouched.length > 0 && (
              <>
                {' '}
                · {task.filesTouched.length} {plural(task.filesTouched.length, 'file')} touched
              </>
            )}
          </Text>
        }
        onCancel={onDone}
        color="background"
        inputGuide={exitState =>
          exitState.pending ? (
            <Text>Press {exitState.keyName} again to exit</Text>
          ) : (
            <Byline>
              {onBack && <KeyboardShortcutHint shortcut="←" action="go back" />}
              <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />
              {task.status === 'running' && onKill && <KeyboardShortcutHint shortcut={killShortcut} action="stop" />}
            </Byline>
          )
        }
      >
        <Box flexDirection="column" gap={1}>
          <Text>
            <Text bold>Status:</Text>{' '}
            {task.status === 'running' ? (
              <Text color="background">running</Text>
            ) : task.status === 'completed' ? (
              <Text color="success">{task.status}</Text>
            ) : (
              <Text color="error">{task.status}</Text>
            )}
          </Text>

          {shown.length === 0 ? (
            <Text dimColor>{task.status === 'running' ? 'Starting…' : '(no text output)'}</Text>
          ) : (
            <>
              {hidden > 0 && (
                <Text dimColor>
                  ({hidden} earlier {plural(hidden, 'turn')})
                </Text>
              )}
              {shown.map((turn, i) => (
                <Box key={i} flexDirection="column">
                  <Text wrap="wrap">{turn.text}</Text>
                  {turn.toolUseCount > 0 && (
                    <Text dimColor>
                      {'  '}({turn.toolUseCount} {plural(turn.toolUseCount, 'tool')})
                    </Text>
                  )}
                </Box>
              ))}
            </>
          )}
        </Box>
      </Dialog>
    </Box>
  );
}
