import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import React from 'react';
import { Box, wrappedRender as render } from '@anthropic/ink';
import type { DOMElement } from '@anthropic/ink';
import type { LocalWorkflowTaskState } from '../../../tasks/LocalWorkflowTask/LocalWorkflowTask.js';
import type { MonitorMcpTaskState } from '../../../tasks/MonitorMcpTask/MonitorMcpTask.js';
import { MonitorMcpDetailDialog } from '../MonitorMcpDetailDialog.js';
import { WorkflowDetailDialog } from '../WorkflowDetailDialog.js';

/**
 * Mount a detail dialog and report what ink ended up focusing.
 *
 * These dialogs route their entire keymap through a DOM `onKeyDown` on their
 * root Box. Ink dispatches keys to `focusManager.activeElement` (falling back
 * to the root node) and only bubbles upward, so a dialog that never claims
 * focus receives nothing: entering the workflow view from the background-task
 * list unmounted the list, left activeElement null, and killed ←/↑/↓/↵/K/y/n
 * outright — only the globally-registered bindings (x, Esc) still answered.
 *
 * The probe Box is a plain sibling (no tabIndex, so it never competes for
 * focus) that hands the test a node to walk up from: focusManager lives on the
 * document root, reachable via parentNode like the browser's getRootNode().
 */
/**
 * Ink's Dialog registers Ctrl+C/D handling, which needs raw mode — a plain
 * PassThrough makes it tear the tree down and render an error screen instead.
 */
function fakeTty(): NodeJS.ReadStream {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

async function focusedNodeAfterMount(dialog: React.ReactNode): Promise<DOMElement | null> {
  const stream = new PassThrough();
  const stdout = stream as unknown as NodeJS.WriteStream;
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 40;
  stream.resume();
  const probe = React.createRef<DOMElement>();
  const instance = await render(
    <Box flexDirection="column">
      <Box ref={probe} />
      {dialog}
    </Box>,
    { stdout, stdin: fakeTty(), patchConsole: false },
  );
  try {
    await new Promise(r => setTimeout(r, 30));
    let node: DOMElement | undefined = probe.current ?? undefined;
    while (node?.parentNode) node = node.parentNode;
    return node?.focusManager?.activeElement ?? null;
  } finally {
    instance.unmount();
  }
}

function workflowTask(): LocalWorkflowTaskState {
  return {
    id: 'wf-1',
    type: 'local_workflow',
    status: 'running',
    description: 'audit the auth module',
    startTime: Date.now() - 4_000,
    outputFile: '/dev/null',
    outputOffset: 0,
    notified: false,
    runId: 'run-1',
    workflowName: 'audit',
    workflowFile: '/tmp/audit.ts',
  };
}

function monitorTask(): MonitorMcpTaskState {
  return {
    id: 'mcp-1',
    type: 'monitor_mcp',
    status: 'running',
    description: 'watch the build log',
    startTime: Date.now() - 4_000,
    outputFile: '/dev/null',
    outputOffset: 0,
    notified: false,
    serverName: 'builder',
    resourceUri: 'file:///tmp/build.log',
  };
}

test('WorkflowDetailDialog claims keyboard focus on mount', async () => {
  const focused = await focusedNodeAfterMount(
    <WorkflowDetailDialog task={workflowTask()} onBack={() => {}} onKillWorkflow={() => {}} />,
  );

  expect(focused).not.toBeNull();
  // Focus landed on the node that actually carries the keymap, not on some
  // incidental focusable descendant.
  expect(focused?._eventHandlers?.onKeyDown).toBeTypeOf('function');
});

test('MonitorMcpDetailDialog claims keyboard focus on mount', async () => {
  const focused = await focusedNodeAfterMount(
    <MonitorMcpDetailDialog task={monitorTask()} onBack={() => {}} onKill={() => {}} />,
  );

  expect(focused).not.toBeNull();
  expect(focused?._eventHandlers?.onKeyDown).toBeTypeOf('function');
});

test('the workflow detail view draws exactly one frame around itself', async () => {
  // Regression: the root Box drew its own round border while the inner Dialog
  // rendered a Pane whose Divider spans the whole terminal. Nested inside a
  // bordered, padded box that divider overflowed and wrapped, printing a stray
  // half-line above the title and knocking the border out of alignment.
  const stream = new PassThrough();
  const stdout = stream as unknown as NodeJS.WriteStream;
  (stdout as unknown as { columns: number }).columns = 60;
  (stdout as unknown as { rows: number }).rows = 40;
  let out = '';
  stream.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  const instance = await render(<WorkflowDetailDialog task={workflowTask()} onBack={() => {}} />, {
    stdout,
    stdin: fakeTty(),
    patchConsole: false,
  });
  let lines: string[];
  try {
    await new Promise(r => setTimeout(r, 30));
    const esc = String.fromCharCode(27);
    lines = out.replace(new RegExp(`${esc}\\[[0-9;?]*[a-zA-Z]`, 'g'), '').split('\n');
  } finally {
    instance.unmount();
  }

  // No box-drawing border characters: the Pane's rule is the only frame.
  expect(lines.join('\n')).not.toMatch(/[╭╮╰╯│]/);
  // And that rule fits the terminal instead of wrapping onto a second row.
  const rules = lines.filter(l => /^─+$/.test(l.trim()));
  expect(rules).toHaveLength(1);
  expect(rules[0]!.trim().length).toBe(60);
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
});
