import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import React from 'react';
import { wrappedRender as render } from '@anthropic/ink';
import { AgentDetail } from '../panel/AgentDetail.js';
import type { AgentProgress } from '../progress/store.js';

/**
 * Render AgentDetail to a throwaway stream and return everything it wrote.
 *
 * AgentDetail is purely presentational (props in, frame out) so a real render
 * is safe here — unlike the stateful panel, there is no concurrent state
 * update for ink's test mode to fail to pump.
 */
async function renderDetail(agent: AgentProgress): Promise<string> {
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  const instance = await render(React.createElement(AgentDetail, { agent }), {
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

test('AgentDetail surfaces the failure reason a dead agent row cannot show', async () => {
  // The list can only render an unexplained ✗. Before this view the only way
  // to learn why an agent died was to read the run journal by hand.
  const out = await renderDetail({
    id: 1,
    label: 'verify:auth',
    phase: 'Verify',
    status: 'done',
    resultKind: 'dead',
    failureReason: 'prompt-too-long',
    failureDetail: 'context window exceeded',
    retryable: false,
    startedAt: 1_000,
    endedAt: 4_000,
  });

  expect(out).toContain('verify:auth');
  expect(out).toContain('failed');
  expect(out).toContain('prompt exceeded the context window');
  expect(out).toContain('context window exceeded');
  // retryable:false is the actionable bit — it says a retry cannot help.
  expect(out).toContain('Deterministic');
});

test('AgentDetail shows the result preview for a successful agent', async () => {
  const out = await renderDetail({
    id: 2,
    label: 'review:api',
    phase: 'Review',
    status: 'done',
    resultKind: 'ok',
    outputShape: 'object',
    outputPreview: '{"findings":[]}',
    outputTokens: 120,
    model: 'claude-sonnet-5-20260101',
    tokenCount: 22_900,
    toolCount: 7,
    startedAt: 1_000,
    endedAt: 3_500,
  });

  expect(out).toContain('review:api');
  expect(out).toContain('done');
  expect(out).toContain('{"findings":[]}');
  // The model id is shortened the same way the list shortens it.
  expect(out).toContain('sonnet-5');
  // Tool count moved off the list row into here, so it must actually appear.
  expect(out).toContain('7');
});

test('AgentDetail marks a skipped agent as skipped, not as a success', async () => {
  const out = await renderDetail({
    id: 3,
    label: 'fix:lint',
    status: 'done',
    resultKind: 'skipped',
    startedAt: 1_000,
    endedAt: 1_100,
  });

  expect(out).toContain('skipped');
  expect(out).not.toContain('Failure');
});

test('AgentDetail renders a running agent without timings or a result', async () => {
  const out = await renderDetail({
    id: 4,
    label: 'find:bugs',
    status: 'running',
    tokenCount: 500,
    startedAt: Date.now() - 2_000,
  });

  expect(out).toContain('find:bugs');
  expect(out).toContain('running');
  expect(out).toContain('Still running');
});

test('AgentDetail tolerates an agent with no timestamps or model', async () => {
  // Runs persisted before startedAt existed hydrate without timings; the pane
  // must degrade to a placeholder rather than rendering an epoch-0 duration.
  const out = await renderDetail({ id: 5, status: 'running' });

  expect(out).toContain('agent-5');
  expect(out).toContain('(not recorded)');
  expect(out).toContain('(pending)');
});
