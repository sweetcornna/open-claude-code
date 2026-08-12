/**
 * `/background [prompt]` — hand this conversation to a new process and give
 * the terminal back.
 *
 * The guards run here, before any UI: every one of them is a reason the
 * handover cannot honestly be offered, and the dialog should never appear only
 * to fail. The handover itself lives in `BackgroundHandoffDialog` because it
 * needs a confirmation first — background tasks do not carry over, and losing
 * them silently is the one outcome this command must not have.
 */

import * as React from 'react';
import { BackgroundHandoffDialog } from './BackgroundHandoffDialog.js';
import { type BackgroundTaskSummary, describeTask } from './taskLabels.js';
import { selectEngine } from '../../cli/bg/engines/index.js';
import { BIN_NAME } from '../../constants/brand.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { getSessionId, isSessionPersistenceDisabled } from '../../bootstrap/state.js';
import { isBgSession } from '../../utils/session/concurrentSessions.js';
import { sessionIdExists } from '../../utils/sessionStorage.js';
import { isBackgroundTask } from '../../tasks/types.js';

function collectBackgroundTasks(context: LocalJSXCommandContext): BackgroundTaskSummary[] {
  const tasks = Object.values(context.getAppState().tasks ?? {});
  return tasks.filter(isBackgroundTask).map(task => ({
    id: task.id,
    type: task.type,
    label: describeTask(task),
  }));
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const prompt = args.trim() || undefined;

  if (isBgSession()) {
    onDone('This session is already running in the background.', { display: 'system' });
    return null;
  }

  if (isSessionPersistenceDisabled()) {
    onDone(
      'Cannot background this session: transcript persistence is disabled, so there would be nothing for the background process to resume from.',
      { display: 'system' },
    );
    return null;
  }

  const sessionId = getSessionId();
  if (!sessionIdExists(sessionId)) {
    onDone('Nothing to hand over yet — send at least one message first, then run /background.', { display: 'system' });
    return null;
  }

  // Engine choice decides whether the background session can host a REPL at
  // all. Without tmux occ has no PTY (it does not vendor one, by design), so a
  // prompt-less handover would resume into a process with no terminal.
  const engine = await selectEngine();
  if (!engine.supportsInteractiveInput && !prompt) {
    onDone(
      [
        'Cannot background an interactive session without tmux: the fallback engine has no terminal for the resumed REPL.',
        '',
        `  /background <prompt>   run one prompt in the background instead`,
        process.platform === 'win32'
          ? ''
          : `  ${process.platform === 'darwin' ? 'brew install tmux' : 'sudo apt install tmux'}   then /background works interactively`,
      ]
        .filter(Boolean)
        .join('\n'),
      { display: 'system' },
    );
    return null;
  }

  return (
    <BackgroundHandoffDialog
      sessionId={sessionId}
      prompt={prompt}
      engine={engine}
      tasks={collectBackgroundTasks(context)}
      binName={BIN_NAME}
      onDone={onDone}
    />
  );
}
