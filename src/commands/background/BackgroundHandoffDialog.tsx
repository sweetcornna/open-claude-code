/**
 * Confirmation + execution for `/background`.
 *
 * The confirmation exists for one reason: the handover is a process handover,
 * so in-flight background tasks (shells, agents, workflows) die with this
 * process. Official checkpoints the adoptable ones into the new job's
 * `adopt.json` and tells the user how many carry over versus how many stop;
 * occ carries none over yet, so the dialog's job is to make the loss visible
 * and refusable instead of silent.
 */

import * as React from 'react';
import { Box, Dialog, Text } from '@anthropic/ink';
import { Select } from '../../components/CustomSelect/select.js';
import { Spinner } from '../../components/Spinner.js';
import type { BgEngine } from '../../cli/bg/engine.js';
import { formatHandoffHints, planHandoff, runHandoff } from '../../cli/bg/handoff.js';
import type { BackgroundTaskSummary } from './taskLabels.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { getOriginalCwd } from '../../bootstrap/state.js';
import { gracefulShutdown } from '../../utils/process/gracefulShutdown.js';
import { flushSessionStorage, getCurrentSessionTitle } from '../../utils/sessionStorage.js';
import { errorMessage } from '../../utils/runtime/errors.js';
import { randomUUID } from 'crypto';
import type { SessionId } from '../../types/ids.js';

/** How long the pre-handover flush is allowed to take before we give up. */
const FLUSH_TIMEOUT_MS = 10_000;

type Props = {
  sessionId: SessionId;
  prompt?: string;
  engine: BgEngine;
  tasks: BackgroundTaskSummary[];
  binName: string;
  onDone: LocalJSXCommandOnDone;
};

async function flushWithTimeout(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      flushSessionStorage(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out saving the conversation')), FLUSH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function BackgroundHandoffDialog({ sessionId, prompt, engine, tasks, binName, onDone }: Props): React.ReactNode {
  const [status, setStatus] = React.useState<'asking' | 'working'>('asking');

  async function handleConfirm(): Promise<void> {
    setStatus('working');

    // Serialize first, and abandon everything if it fails. A handover that
    // resumes from a half-written transcript loses the tail of the
    // conversation with no way to tell which part; official refuses here too
    // ("this conversation is still being saved").
    try {
      await flushWithTimeout();
    } catch (error) {
      onDone(
        `Not backgrounding: this conversation is still being saved (${errorMessage(error)}). Nothing was changed — try again in a moment.`,
        { display: 'system' },
      );
      return;
    }

    const plan = planHandoff({
      sessionId,
      prompt,
      cwd: getOriginalCwd(),
      interactive: engine.supportsInteractiveInput,
      forkSessionId: randomUUID(),
    });

    let hints: string;
    try {
      await runHandoff(plan, engine);
      hints = formatHandoffHints(plan, getCurrentSessionTitle(sessionId));
    } catch (error) {
      onDone(`Failed to start the background session: ${errorMessage(error)}`, {
        display: 'system',
      });
      return;
    }

    onDone(hints, { display: 'system' });
    // finalMessage lands on stderr after the alt screen is torn down, so the
    // hints are the last thing on the terminal the user gets back.
    await gracefulShutdown(0, 'prompt_input_exit', { finalMessage: hints });
  }

  if (status === 'working') {
    return (
      <Box flexDirection="row" marginY={1}>
        <Spinner />
        <Text>Saving the conversation and handing it over…</Text>
      </Box>
    );
  }

  const subtitleLines = [
    prompt
      ? `A new ${binName} process will resume this conversation in the background and run: ${prompt}`
      : `A new ${binName} process will resume this conversation in the background and this terminal will be freed.`,
    // Say the mechanism out loud. The handover is serialize-then-resume (this
    // is what official does too), so anything not yet written down does not
    // travel, and the resumed conversation is a fork with its own id.
    'The conversation is saved and resumed as a fork — everything said so far carries over, anything still in flight does not.',
  ];

  if (tasks.length > 0) {
    subtitleLines.push(
      `${tasks.length} background ${tasks.length === 1 ? 'task' : 'tasks'} will be stopped and will NOT carry over:`,
    );
    for (const task of tasks.slice(0, 5)) {
      subtitleLines.push(`  · ${task.label}`);
    }
    if (tasks.length > 5) {
      subtitleLines.push(`  · …and ${tasks.length - 5} more`);
    }
  }

  if (!engine.supportsInteractiveInput) {
    subtitleLines.push('No tmux available: the background session runs the prompt headlessly and writes to its log.');
  }

  return (
    <Dialog
      title="Send this session to the background?"
      subtitle={subtitleLines.join('\n')}
      onCancel={() => onDone('Stayed in the foreground.', { display: 'system' })}
    >
      <Select
        defaultFocusValue={tasks.length > 0 ? 'cancel' : 'background'}
        options={[
          {
            label: 'Background it',
            value: 'background',
            description: `Reattach later with \`${binName} daemon attach\`.`,
          },
          {
            label: 'Stay here',
            value: 'cancel',
            description: 'Nothing is started or stopped.',
          },
        ]}
        onChange={value => {
          if (value === 'background') void handleConfirm();
          else onDone('Stayed in the foreground.', { display: 'system' });
        }}
      />
    </Dialog>
  );
}
