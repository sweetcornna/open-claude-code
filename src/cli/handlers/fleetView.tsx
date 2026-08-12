/**
 * `occ agents` on a TTY — mount FleetView, then run whatever the user picked.
 *
 * Dynamically imported from the `agents` action so the print-mode path never
 * pays for the Ink tree (see `src/cli/program/run.tsx`).
 *
 * Actions are deliberately thin: attach/kill/logs are the same `src/cli/bg.ts`
 * handlers `occ daemon attach|kill|logs` already use, and resume re-execs the
 * CLI through `buildCliLaunch()`. Nothing here reimplements a capability.
 */

import { existsSync } from 'fs';
import React from 'react';
import { type Instance, wrappedRender as render } from '@anthropic/ink';
import type { FleetAction } from '../../components/fleet/FleetView.js';
import type { FleetRow } from '../../components/fleet/fleetRows.js';
import { fleetRowTarget } from '../../components/fleet/fleetRows.js';
import { FleetView } from '../../components/fleet/FleetView.js';
import { buildCliLaunch, spawnCli } from '../../utils/process/cliLaunch.js';

async function mountFleetView(): Promise<FleetAction | null> {
  // Boxed so TypeScript does not narrow the closure assignment away.
  const picked: { action: FleetAction | null } = { action: null };
  let instance: Instance | undefined;

  // Rendered without AppStateProvider / KeybindingSetup on purpose: FleetView
  // reads neither, and AppStateProvider drags in the voice context, whose
  // feature-gated noop branch is not safe to mount outside the REPL bootstrap.
  instance = await render(
    <FleetView
      currentCwd={process.cwd()}
      onDone={action => {
        picked.action = action;
        instance?.unmount();
      }}
    />,
    { exitOnCtrlC: true },
  );

  await instance.waitUntilExit();
  return picked.action;
}

/**
 * Re-exec the CLI with `--resume <id>` in the session's own directory, handing
 * it this terminal. `--resume` resolves the transcript relative to cwd, so a
 * session from another project only reopens if we spawn there.
 */
async function resumeSession(row: FleetRow): Promise<void> {
  if (!row.sessionId) {
    console.error('This session has no transcript to resume.');
    process.exitCode = 1;
    return;
  }
  const cwd = row.cwd && existsSync(row.cwd) ? row.cwd : process.cwd();
  const spec = buildCliLaunch(['--resume', row.sessionId]);
  const child = spawnCli(spec, { stdio: 'inherit', cwd });
  const code = await new Promise<number>(resolve => {
    child.on('error', error => {
      console.error(error instanceof Error ? error.message : String(error));
      resolve(1);
    });
    child.on('exit', exitCode => resolve(exitCode ?? 0));
  });
  if (code !== 0) process.exitCode = code;
}

export async function fleetViewHandler(): Promise<void> {
  const action = await mountFleetView();
  if (!action) return;

  if (action.type === 'resume') {
    await resumeSession(action.row);
    return;
  }

  const target = fleetRowTarget(action.row);
  if (!target) {
    console.error('That session has no id or PID to act on.');
    process.exitCode = 1;
    return;
  }

  const { attachHandler, killHandler, logsHandler } = await import('../bg.js');
  switch (action.type) {
    case 'attach':
      await attachHandler(target);
      return;
    case 'kill':
      await killHandler(target);
      return;
    case 'logs':
      await logsHandler(target);
      return;
  }
}
