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

test('AgentDetail explains a run-reaped agent in words, and does not call it a failure', async () => {
  // run_done stamps resultKind 'dead' with a `run-*` reason on whatever was still
  // running. Those keys had no copy, so the pane printed the raw internal string
  // under a red "Failure" heading — telling a user who had just pressed K that
  // their own kill had broken the agent.
  const out = await renderDetail({
    id: 6,
    label: 'review:api',
    status: 'done',
    resultKind: 'dead',
    failureReason: 'run-killed',
    startedAt: 1_000,
    endedAt: 4_000,
  });

  expect(out).toContain('stopped when the workflow was killed');
  expect(out).toContain('Stopped');
  expect(out).not.toContain('Failure');
  // The raw identifier never reaches the screen.
  expect(out).not.toContain('run-killed');
});

test('AgentDetail still reports a genuine engine failure as a failure', async () => {
  const out = await renderDetail({
    id: 7,
    label: 'review:api',
    status: 'done',
    resultKind: 'dead',
    failureReason: 'api-error',
    startedAt: 1_000,
    endedAt: 4_000,
  });

  expect(out).toContain('Failure');
  expect(out).toContain('terminal API error');
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

test('AgentDetail keeps the retry history after the backoff window closes', async () => {
  // The list row can only show a retry while the engine is actually sleeping — two
  // to eight seconds. Once the agent is moving again, this pane was the only place
  // the history could live, and it showed none of it: an agent that survived three
  // retries looked identical to one that sailed through, and lastFailureDetail had
  // no reader anywhere in the repo.
  const out = await renderDetail({
    id: 8,
    label: 'review:api',
    status: 'running',
    tokenCount: 3_200,
    startedAt: Date.now() - 40_000,
    retryCount: 2,
    retryLimit: 3,
    lastFailureReason: 'api-error',
    lastFailureDetail: 'upstream returned 529 overloaded_error',
    // Backoff already elapsed: the agent is running again.
    retryingSince: Date.now() - 30_000,
    retryDelayMs: 5_000,
  });

  expect(out).toContain('retries');
  expect(out).toContain('2/3');
  expect(out).toContain('api-error');
  expect(out).toContain('upstream returned 529');
  // Not in a backoff any more, so the live-counts line is the honest one.
  expect(out).toContain('token and tool counts update live');
});

test('AgentDetail says the engine is waiting while a backoff is in progress', async () => {
  const out = await renderDetail({
    id: 9,
    label: 'review:api',
    status: 'running',
    tokenCount: 3_200,
    startedAt: Date.now() - 9_000,
    retryCount: 2,
    retryLimit: 3,
    lastFailureReason: 'api-error',
    retryingSince: Date.now(),
    retryDelayMs: 30_000,
  });

  // Promising live counts while nothing is moving is what made a retrying agent
  // look hung — the numbers freeze and the copy insists they are updating.
  expect(out).toContain('Waiting to retry');
  expect(out).toContain('attempt 2/3');
  expect(out).toContain('30s backoff');
  expect(out).not.toContain('counts update live');
});

test('AgentDetail omits the retries row for an agent that never retried', async () => {
  const out = await renderDetail({
    id: 10,
    label: 'review:api',
    status: 'running',
    startedAt: Date.now() - 2_000,
  });

  expect(out).not.toContain('retries');
  expect(out).toContain('token and tool counts update live');
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
