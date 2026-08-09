import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { type DOMElement, wrappedRender as render } from '@anthropic/ink';
import type { RunProgress } from '../progress/store.js';
import { WorkflowRunPanel } from '../panel/WorkflowRunPanel.js';

function fakeTty(): NodeJS.ReadStream {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

function workflowRun(overrides: Partial<RunProgress> = {}): RunProgress {
  return {
    runId: 'run-1',
    workflowName: 'audit',
    status: 'running',
    phases: [{ title: 'Scan', status: 'running' }],
    declaredPhases: ['Scan', 'Verify'],
    currentPhase: 'Scan',
    agents: [
      {
        id: 1,
        label: 'scan:auth',
        phase: 'Scan',
        status: 'running',
        startedAt: Date.now() - 1_000,
      },
    ],
    agentCount: 1,
    startedAt: Date.now() - 2_000,
    updatedAt: Date.now(),
    description: 'Audit authentication behavior',
    ...overrides,
  };
}

async function renderPanel(
  columns: number,
  rows: number,
  run: RunProgress,
  callbacks: {
    runs?: RunProgress[];
    onNextRun?: () => void;
    onPreviousRun?: () => void;
    onCancelAgent?: (runId: string, agentId: number) => void;
    onCancelRun?: (runId: string) => void;
  } = {},
): Promise<{
  root: () => DOMElement | null;
  stdin: PassThrough;
  output: () => string;
  /** Drop everything rendered so far, so the next assertion sees only new frames. */
  clearOutput: () => void;
  rerender: (next: RunProgress) => void;
  unmount: () => void;
}> {
  const stdout = new PassThrough();
  (stdout as unknown as { columns: number }).columns = columns;
  (stdout as unknown as { rows: number }).rows = rows;
  let output = '';
  stdout.on('data', chunk => {
    output += chunk.toString();
  });
  stdout.resume();
  const stdin = fakeTty() as unknown as PassThrough;
  let root: DOMElement | null = null;
  const panel = (current: RunProgress) => (
    <WorkflowRunPanel
      run={current}
      runs={callbacks.runs}
      onNextRun={callbacks.onNextRun}
      onPreviousRun={callbacks.onPreviousRun}
      onClose={() => {}}
      onCancelAgent={callbacks.onCancelAgent ?? (() => {})}
      onCancelRun={callbacks.onCancelRun ?? (() => {})}
      panelRef={element => {
        root = element;
      }}
    />
  );
  const instance = await render(panel(run), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  return {
    root: () => root,
    stdin,
    output: () => output,
    clearOutput: () => {
      output = '';
    },
    rerender: next => instance.rerender(panel(next)),
    unmount: instance.unmount,
  };
}

for (const [columns, rows, expectedWidth, expectedHeight] of [
  [160, 50, 110, 28],
  [110, 28, 110, 28],
  [80, 24, 80, 24],
  [40, 18, 40, 18],
] as const) {
  test(`WorkflowRunPanel in ${columns}x${rows} uses a ${expectedWidth}x${expectedHeight} frame`, async () => {
    const mounted = await renderPanel(columns, rows, workflowRun());
    try {
      expect(mounted.root()?.yogaNode?.getComputedWidth()).toBe(expectedWidth);
      expect(mounted.root()?.yogaNode?.getComputedHeight()).toBe(expectedHeight);
    } finally {
      mounted.unmount();
    }
  });
}

test('Tab cycles pane focus and phase arrows filter the agent list', async () => {
  const run = workflowRun({
    declaredPhases: ['Scan', 'Verify'],
    agents: [
      {
        id: 1,
        label: 'scan:auth',
        phase: 'Scan',
        status: 'running',
        startedAt: Date.now() - 1_000,
      },
      {
        id: 2,
        label: 'verify:api',
        phase: 'Verify',
        status: 'running',
        startedAt: Date.now() - 1_000,
      },
    ],
    agentCount: 2,
  });
  const mounted = await renderPanel(110, 28, run);
  try {
    expect(stripAnsi(mounted.output())).toContain('scan:auth');
    expect(stripAnsi(mounted.output())).not.toContain('verify:api');

    mounted.clearOutput();
    mounted.stdin.write('\t');
    await new Promise(resolve => setTimeout(resolve, 20));
    mounted.stdin.write('\t');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(stripAnsi(mounted.output())).toContain('x stop workflow');

    mounted.clearOutput();
    mounted.stdin.write('\u001b[A');
    await new Promise(resolve => setTimeout(resolve, 30));
    const allPhaseFrame = stripAnsi(mounted.output());
    expect(allPhaseFrame).toContain('scan:auth');
    expect(allPhaseFrame).toContain('verify:api');

    mounted.clearOutput();
    mounted.stdin.write('\u001b[B');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(stripAnsi(mounted.output())).toContain('scan:auth');

    mounted.clearOutput();
    mounted.stdin.write('\u001b[B');
    await new Promise(resolve => setTimeout(resolve, 30));
    const verifyPhaseFrame = stripAnsi(mounted.output());
    expect(verifyPhaseFrame).toContain('verify:api');
    expect(verifyPhaseFrame).not.toContain('scan:auth');
  } finally {
    mounted.unmount();
  }
});

test('[ and ] switch runs while Tab leaves run selection unchanged', async () => {
  let nextRuns = 0;
  let previousRuns = 0;
  const run = workflowRun();
  const mounted = await renderPanel(110, 28, run, {
    runs: [run],
    onNextRun: () => {
      nextRuns += 1;
    },
    onPreviousRun: () => {
      previousRuns += 1;
    },
  });
  try {
    mounted.stdin.write('\t');
    mounted.stdin.write('\t');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(nextRuns).toBe(0);
    expect(previousRuns).toBe(0);

    mounted.stdin.write(']');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(nextRuns).toBe(1);
    mounted.stdin.write('[');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(previousRuns).toBe(1);
  } finally {
    mounted.unmount();
  }
});

test('long agent/result/error content and agent churn do not resize the frame', async () => {
  const longAgents = Array.from({ length: 60 }, (_, index) => ({
    id: index + 1,
    label: `verify:${'very-long-dimension-'.repeat(4)}#${index}`,
    phase: index % 2 === 0 ? 'Scan' : 'Verify',
    status: index === 0 ? ('running' as const) : ('done' as const),
    outputPreview: 'result '.repeat(200),
  }));
  const mounted = await renderPanel(
    80,
    24,
    workflowRun({
      agents: longAgents,
      agentCount: longAgents.length,
      error: 'failure detail '.repeat(200),
      returnValue: { output: 'workflow result '.repeat(200) },
    }),
  );
  try {
    expect(mounted.root()?.yogaNode?.getComputedWidth()).toBe(80);
    expect(mounted.root()?.yogaNode?.getComputedHeight()).toBe(24);

    mounted.rerender(
      workflowRun({
        agents: [{ id: 999, status: 'running', label: 'new' }, ...longAgents.slice(1)],
        agentCount: longAgents.length,
      }),
    );
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(mounted.root()?.yogaNode?.getComputedWidth()).toBe(80);
    expect(mounted.root()?.yogaNode?.getComputedHeight()).toBe(24);
  } finally {
    mounted.unmount();
  }
});

test('x cancels the selected agent by run id and confirmation does not resize the frame', async () => {
  const canceled: Array<[string, number]> = [];
  const mounted = await renderPanel(80, 24, workflowRun({ runId: 'durable-run' }), {
    onCancelAgent: (runId, agentId) => canceled.push([runId, agentId]),
  });
  try {
    mounted.stdin.write('x');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(stripAnsi(mounted.output())).toContain('Stop agent');
    expect(mounted.root()?.yogaNode?.getComputedWidth()).toBe(80);
    expect(mounted.root()?.yogaNode?.getComputedHeight()).toBe(24);

    mounted.stdin.write('y');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(canceled).toEqual([['durable-run', 1]]);
  } finally {
    mounted.unmount();
  }
});

test('at 60 columns ↑ off the list gives x a run-level target', async () => {
  // 48–77 columns drops the phases pane, and the agents pane always kept an agent
  // selected — so the whole run was uncancellable at that width. ↑ past the first
  // row deselects, which is what makes x aim at the run again.
  const canceledRuns: string[] = [];
  const mounted = await renderPanel(60, 24, workflowRun({ runId: 'durable-run' }), {
    onCancelRun: runId => canceledRuns.push(runId),
  });
  try {
    expect(stripAnsi(mounted.output())).toContain('x stop scan:auth');

    mounted.clearOutput();
    mounted.stdin.write('\u001b[A');
    await new Promise(resolve => setTimeout(resolve, 30));
    // The footer has to say the target changed, or deselecting is invisible.
    expect(stripAnsi(mounted.output())).toContain('x stop workflow');

    mounted.clearOutput();
    mounted.stdin.write('x');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(stripAnsi(mounted.output())).toContain('Stop workflow');
    mounted.stdin.write('y');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(canceledRuns).toEqual(['durable-run']);

    // ↓ comes back to the first agent rather than staying parked.
    mounted.clearOutput();
    mounted.stdin.write('\u001b[B');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(stripAnsi(mounted.output())).toContain('x stop scan:auth');
  } finally {
    mounted.unmount();
  }
});

test('x on the phases pane cancels the whole workflow by run id', async () => {
  const canceledRuns: string[] = [];
  const mounted = await renderPanel(110, 28, workflowRun({ runId: 'durable-run' }), {
    onCancelRun: runId => canceledRuns.push(runId),
  });
  try {
    mounted.stdin.write('\u001b[D');
    await new Promise(resolve => setTimeout(resolve, 20));
    mounted.stdin.write('x');
    await new Promise(resolve => setTimeout(resolve, 20));
    mounted.stdin.write('y');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(canceledRuns).toEqual(['durable-run']);
  } finally {
    mounted.unmount();
  }
});
