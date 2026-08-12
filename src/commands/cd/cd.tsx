import chalk from 'chalk';
import figures from 'figures';
import React, { useEffect } from 'react';
import { resolve } from 'path';
import { Box, Link, Text } from '@anthropic/ink';
import { MessageResponse } from '../../components/MessageResponse.js';
import { Select } from '../../components/CustomSelect/index.js';
import { PermissionDialog } from '../../components/permissions/PermissionDialog.js';
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js';
import { isPathTrusted } from '../../utils/config/config.js';
import { getCwd } from '../../utils/filesystem/cwd.js';
import { findCanonicalGitRoot } from '../../utils/git/git.js';
import { logForDebugging } from '../../utils/telemetry/debug.js';
import { relocateSession } from './relocate.js';
import { setPathTrusted } from './trust.js';
import { cdFailureMessage, validateCdTarget } from './validation.js';

function CdError({ message, args, onDone }: { message: string; args: string; onDone: () => void }): React.ReactNode {
  useEffect(() => {
    // Deferred like /add-dir's error view: returning null synchronously would
    // unmount before the message ever renders.
    const timer = setTimeout(onDone, 0);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {figures.pointer} /cd {args}
      </Text>
      <MessageResponse>
        <Text>{message}</Text>
      </MessageResponse>
    </Box>
  );
}

export function CdTrustPrompt({
  directory,
  trustRoot,
  onConfirm,
  onCancel,
}: {
  directory: string;
  trustRoot?: string;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactNode {
  return (
    <PermissionDialog color="warning" titleColor="warning" title="Moving to a new directory:">
      <Box flexDirection="column" gap={1} paddingTop={1}>
        <Text bold>{directory}</Text>

        {trustRoot != null && (
          <Text>
            This directory is part of the repository at <Text bold>{trustRoot}</Text>. Trusting it trusts that whole
            repository, including its other worktrees and subdirectories.
          </Text>
        )}

        <Text>This session hasn&apos;t worked here before. Is this a directory you created or one you trust?</Text>
        <Text>Claude Code will be able to read, edit, and run commands in this folder.</Text>

        <Text dimColor>
          <Link url="https://code.claude.com/docs/en/security">Security guide</Link>
        </Text>

        <Select
          options={[
            { label: 'Yes, move here', value: 'yes' },
            { label: 'No, stay put', value: 'no' },
          ]}
          defaultValue="no"
          onChange={value => (value === 'yes' ? onConfirm() : onCancel())}
          onCancel={onCancel}
        />

        <Text dimColor>Enter to confirm · Esc to cancel</Text>
      </Box>
    </PermissionDialog>
  );
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const directoryPath = (args ?? '').trim();

  if (!directoryPath) {
    const usage = 'Usage: /cd <path>';
    return <CdError message={usage} args="" onDone={() => onDone(usage)} />;
  }

  const target = await validateCdTarget(directoryPath);

  if (target.result !== 'ok') {
    const message = cdFailureMessage(target);
    return <CdError message={message} args={directoryPath} onDone={() => onDone(message)} />;
  }

  const directory = target.directory;

  const move = async (): Promise<void> => {
    try {
      const { modelMessage } = await relocateSession(directory, 'cd_command');
      onDone(`Moved to ${chalk.bold(directory)}`, {
        display: 'system',
        metaMessages: [modelMessage],
      });
    } catch (e) {
      logForDebugging(`/cd relocate failed: ${e instanceof Error ? e.message : String(e)}`, { level: 'error' });
      onDone(
        `Couldn't move to ${chalk.bold(directory)} — the directory may no longer exist, or the session couldn't be moved. Staying in ${chalk.bold(getCwd())}.`,
      );
    }
  };

  // Moving the session into a directory grants it read/edit/execute reach
  // there, so an untrusted target has to clear the same bar as startup trust.
  if (isPathTrusted(directory)) {
    await move();
    return null;
  }

  const gitRoot = findCanonicalGitRoot(resolve(directory));
  return (
    <CdTrustPrompt
      directory={directory}
      trustRoot={gitRoot != null && gitRoot !== resolve(directory) ? gitRoot : undefined}
      onConfirm={() => {
        setPathTrusted(directory);
        void move();
      }}
      onCancel={() => {
        onDone(`Staying in ${chalk.bold(getCwd())}`);
      }}
    />
  );
}
