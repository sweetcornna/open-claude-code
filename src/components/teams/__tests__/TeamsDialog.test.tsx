import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import React, { useState } from 'react';
import stripAnsi from 'strip-ansi';
import { KeybindingSetup, type KeybindingsLoadResult, parseBindings, wrappedRender as render } from '@anthropic/ink';
import { type AppState, AppStoreContext, getDefaultAppState } from '../../../state/AppState.js';
import { createStore } from '../../../state/store.js';
import { TeamsDialog } from '../TeamsDialog.js';

const TEAM_NAME = 'alpha';
const TEAMMATE_NAME = 'worker';
const TEAMMATE_PROMPT = 'Inspect the authentication path';
const TEST_BINDINGS: KeybindingsLoadResult = {
  bindings: parseBindings([
    {
      context: 'Confirmation',
      bindings: { escape: 'confirm:no' },
    },
  ]),
  warnings: [],
};

let configDir: string;
let previousConfigDir: string | undefined;
let previousOccConfigDir: string | undefined;

beforeEach(() => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  previousOccConfigDir = process.env.OCC_CONFIG_DIR;
  configDir = join(tmpdir(), `teams-dialog-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  process.env.CLAUDE_CONFIG_DIR = configDir;
  process.env.OCC_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  }
  if (previousOccConfigDir === undefined) {
    delete process.env.OCC_CONFIG_DIR;
  } else {
    process.env.OCC_CONFIG_DIR = previousOccConfigDir;
  }
  rmSync(configDir, { recursive: true, force: true });
});

function fakeTty(): NodeJS.ReadStream {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

function writeTeamFile(): string {
  const teamDir = join(configDir, 'teams', TEAM_NAME);
  const teamFilePath = join(teamDir, 'config.json');
  mkdirSync(teamDir, { recursive: true });
  writeFileSync(
    teamFilePath,
    JSON.stringify({
      name: TEAM_NAME,
      createdAt: Date.now(),
      leadAgentId: `team-lead@${TEAM_NAME}`,
      members: [
        {
          agentId: `team-lead@${TEAM_NAME}`,
          name: 'team-lead',
          joinedAt: Date.now(),
          tmuxPaneId: '',
          cwd: configDir,
          subscriptions: [],
        },
        {
          agentId: `${TEAMMATE_NAME}@${TEAM_NAME}`,
          name: TEAMMATE_NAME,
          prompt: TEAMMATE_PROMPT,
          joinedAt: Date.now(),
          tmuxPaneId: 'in-process',
          cwd: configDir,
          subscriptions: [],
          backendType: 'in-process',
        },
      ],
    }),
  );
  return teamFilePath;
}

async function waitFor(condition: () => boolean, message: string, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function DialogHarness({ onDone }: { onDone: () => void }): React.ReactNode {
  const [open, setOpen] = useState(true);
  if (!open) return null;

  return (
    <TeamsDialog
      initialTeams={[{ name: TEAM_NAME, memberCount: 1, runningCount: 1, idleCount: 0 }]}
      onDone={() => {
        setOpen(false);
        onDone();
      }}
    />
  );
}

describe('TeamsDialog', () => {
  test('returns to an empty list when the selected teammate disappears without dismissing the overlay', async () => {
    const teamFilePath = writeTeamFile();
    const initialState: AppState = {
      ...getDefaultAppState(),
      teamContext: {
        teamName: TEAM_NAME,
        teamFilePath,
        leadAgentId: `team-lead@${TEAM_NAME}`,
        isLeader: true,
        teammates: {
          [`${TEAMMATE_NAME}@${TEAM_NAME}`]: {
            name: TEAMMATE_NAME,
            tmuxSessionName: 'in-process',
            tmuxPaneId: 'in-process',
            cwd: configDir,
            spawnedAt: Date.now(),
          },
        },
      },
    };
    let currentState = initialState;
    const store = createStore(initialState, ({ newState }) => {
      currentState = newState;
    });
    const stdout = new PassThrough();
    (stdout as unknown as { columns: number }).columns = 100;
    (stdout as unknown as { rows: number }).rows = 40;
    let output = '';
    stdout.on('data', chunk => {
      output += chunk.toString();
    });
    stdout.resume();
    const stdin = fakeTty() as unknown as PassThrough;
    let doneCalls = 0;
    const instance = await render(
      <AppStoreContext.Provider value={store}>
        <KeybindingSetup loadBindings={() => TEST_BINDINGS} subscribeToChanges={() => () => {}}>
          <DialogHarness
            onDone={() => {
              doneCalls += 1;
            }}
          />
        </KeybindingSetup>
      </AppStoreContext.Provider>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        patchConsole: false,
      },
    );

    try {
      await waitFor(
        () => currentState.activeOverlays.has('teams-dialog') && stripAnsi(output).includes(`@${TEAMMATE_NAME}`),
        'Teams dialog did not mount with its teammate',
      );

      output = '';
      stdin.write('\r');
      await waitFor(() => stripAnsi(output).includes(TEAMMATE_PROMPT), 'Teammate detail did not open');

      output = '';
      rmSync(join(configDir, 'teams', TEAM_NAME), { recursive: true, force: true });
      store.setState(prev => ({ ...prev, teamContext: undefined }));
      await waitFor(() => stripAnsi(output).includes('No teammates'), 'Teams dialog did not return to the empty list');

      expect(doneCalls).toBe(0);
      expect(currentState.teamContext).toBeUndefined();
      expect(currentState.activeOverlays.has('teams-dialog')).toBe(true);

      stdin.write('\u001b');
      await waitFor(
        () => doneCalls === 1 && !currentState.activeOverlays.has('teams-dialog'),
        'Escape did not dismiss the normalized teams dialog',
      );
    } finally {
      instance.unmount();
    }
  });
});
