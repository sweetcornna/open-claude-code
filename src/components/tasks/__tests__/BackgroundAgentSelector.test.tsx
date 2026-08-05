import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import React from 'react';
import { wrappedRender as render } from '@anthropic/ink';
import type { LocalAgentTaskState } from '../../../tasks/LocalAgentTask/LocalAgentTask.js';
import { AgentRow } from '../BackgroundAgentSelector.js';
import { getAgentRowDescription, getAgentStatusDotColor } from '../taskStatusUtils.js';

function makeTask(overrides: Partial<LocalAgentTaskState> = {}): LocalAgentTaskState {
  return {
    id: 'agent-1',
    type: 'local_agent',
    status: 'running',
    description: 'Refactor auth',
    startTime: Date.now(),
    agentId: 'agent-1',
    prompt: 'do it',
    agentType: 'general-purpose',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...overrides,
  } as LocalAgentTaskState;
}

// ─── C2: the dot encodes status, not selection ───

test('status dot colors: running is a neutral gray, terminal states are semantic', () => {
  // Before this, the dot was green whenever the agent was running and
  // colorless otherwise — a failed agent looked exactly like a completed one.
  expect(getAgentStatusDotColor('running')).toBe('inactive');
  expect(getAgentStatusDotColor('pending')).toBe('inactive');
  expect(getAgentStatusDotColor('completed')).toBe('success');
  expect(getAgentStatusDotColor('failed')).toBe('error');
  expect(getAgentStatusDotColor('killed')).toBe('warning');
});

test('status dot color never depends on selection', () => {
  const failed = makeTask({ status: 'failed' });
  expect(getAgentStatusDotColor(failed.status)).toBe('error');
  // Selection is carried by the pointer/bold, so the same task selected or
  // not resolves to the same color.
  expect(getAgentStatusDotColor(makeTask({ status: 'failed' }).status)).toBe('error');
});

// ─── C3: the row shows what the agent is doing now ───

test('row description prefers the live tool activity over the spawn description', () => {
  const task = makeTask({
    description: 'Refactor auth',
    progress: {
      toolUseCount: 3,
      tokenCount: 100,
      lastActivity: { toolName: 'Read', input: {}, activityDescription: 'Reading src/foo.ts' },
    },
  });
  expect(getAgentRowDescription(task)).toBe('Reading src/foo.ts');
});

test('row description prefers the AI summary when one exists', () => {
  const task = makeTask({
    description: 'Refactor auth',
    progress: {
      toolUseCount: 3,
      tokenCount: 100,
      summary: 'Wiring the new token refresh path',
      lastActivity: { toolName: 'Read', input: {}, activityDescription: 'Reading src/foo.ts' },
    },
  });
  expect(getAgentRowDescription(task)).toBe('Wiring the new token refresh path');
});

test('row description falls back to the spawn description before any activity', () => {
  expect(getAgentRowDescription(makeTask())).toBe('Refactor auth');
});

test.each([
  'completed',
  'failed',
  'killed',
] as const)('a %s agent shows what it was asked to do, not its last tool call', status => {
  // A finished row reading "Reading src/foo.ts" is a frozen snapshot of the
  // last thing it did and reads like it is still running.
  const task = makeTask({
    status,
    description: 'Refactor auth',
    progress: {
      toolUseCount: 3,
      tokenCount: 100,
      summary: 'Wiring the new token refresh path',
      lastActivity: { toolName: 'Read', input: {}, activityDescription: 'Reading src/foo.ts' },
    },
  });
  expect(getAgentRowDescription(task)).toBe('Refactor auth');
});

async function renderRow(task: LocalAgentTaskState, selected: boolean): Promise<string> {
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  const instance = await render(React.createElement(AgentRow, { task, selected }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  });
  try {
    await new Promise(r => setTimeout(r, 30));
    return out;
  } finally {
    instance.unmount();
  }
}

test('a running agent row renders the AI recap in preference to the tool activity', async () => {
  // End of the recap chain: startAgentSummarization → updateAgentSummary →
  // task.progress.summary → useBackgroundAgentTasks → this row. The recap is
  // the 3-5 word present-continuous phrase the summarizer produces.
  const out = await renderRow(
    makeTask({
      description: 'Refactor auth',
      progress: {
        toolUseCount: 4,
        tokenCount: 900,
        summary: 'Verifying runtime sampler',
        lastActivity: { toolName: 'Grep', input: {}, activityDescription: 'Searching for useAuth' },
      },
    }),
    false,
  );

  expect(out).toContain('Verifying runtime sampler');
  expect(out).not.toContain('Searching for useAuth');
  expect(out).not.toContain('Refactor auth');
});

test('a running agent row renders its current activity, not its spawn description', async () => {
  const out = await renderRow(
    makeTask({
      description: 'Refactor auth',
      progress: {
        toolUseCount: 1,
        tokenCount: 42,
        lastActivity: { toolName: 'Grep', input: {}, activityDescription: 'Searching for useAuth' },
      },
    }),
    false,
  );

  expect(out).toContain('Searching for useAuth');
  expect(out).not.toContain('Refactor auth');
});
