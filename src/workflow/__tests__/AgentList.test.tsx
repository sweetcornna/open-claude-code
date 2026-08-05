import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import React from 'react';
import { Box, wrappedRender as render } from '@anthropic/ink';
import { AgentList, retryMetaText, truncateLabel } from '../panel/AgentList.js';
import { PhaseSidebar } from '../panel/PhaseSidebar.js';
import { TabsBar } from '../panel/TabsBar.js';
import type { AgentProgress, RunProgress } from '../progress/store.js';

/**
 * Render a panel column at a fixed terminal width and return every painted line.
 *
 * The whole class of bug these tests cover is a row that silently becomes two
 * rows once the terminal is narrow, so the assertions are about line counts and
 * line widths — which only a real render can report. Same PassThrough harness as
 * AgentDetail.test.tsx; the components here are presentational too (props in,
 * frame out), so there is no concurrent state for ink's test mode to pump.
 *
 * Blank lines are deliberately NOT filtered out. A component that reserves an
 * empty row it does not need is exactly one of the defects under test, and a
 * harness that drops blank lines cannot see the difference.
 */
async function renderAt(node: React.ReactNode, columns: number): Promise<string[]> {
  const stream = new PassThrough();
  const stdout = stream as unknown as NodeJS.WriteStream;
  (stdout as unknown as { columns: number }).columns = columns;
  (stdout as unknown as { rows: number }).rows = 40;
  let out = '';
  stream.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  const instance = await render(
    <Box width={columns} flexDirection="column">
      {node}
    </Box>,
    { stdout, patchConsole: false },
  );
  try {
    await new Promise(r => setTimeout(r, 30));
    // Read before unmounting: teardown writes one more frame to the stream.
    const esc = String.fromCharCode(27);
    return out.replace(new RegExp(`${esc}\\[[0-9;?]*[a-zA-Z]`, 'g'), '').split('\n');
  } finally {
    instance.unmount();
  }
}

/** Display width, the way the terminal counts it (CJK = 2 columns). */
function width(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    w += (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xff00 && cp <= 0xff60) ? 2 : 1;
  }
  return w;
}

function agent(overrides: Partial<AgentProgress> & { id: number }): AgentProgress {
  return { status: 'running', ...overrides };
}

// ─── truncateLabel measures columns, not code units ───

test('truncateLabel keeps its legacy behaviour for ASCII labels', () => {
  expect(truncateLabel('agent-1', 18)).toBe('agent-1');
  expect(truncateLabel('review:correctness', 18)).toBe('review:correctness');
  expect(truncateLabel('verify:correctness#0', 18)).toBe('verify:correctn…#0');
  expect(truncateLabel('verify:architecture#15', 18)).toBe('verify:archite…#15');
  expect(truncateLabel('a-very-long-label-no-suffix', 18)).toBe('a-very-long-label-');
});

test('truncateLabel budgets CJK labels by display width, not string length', () => {
  // 14 double-width chars = 28 columns. Counted by `.length` this is "14 chars"
  // and fits any budget ≥ 14 — which is how a label twice the width of its
  // column got handed to the renderer and wrapped onto a second line.
  const cjk = '审查中文标签超长测试用例名称';
  expect(cjk.length).toBe(14);
  expect(width(cjk)).toBe(28);
  expect(width(truncateLabel(cjk, 12))).toBeLessThanOrEqual(12);
  expect(truncateLabel(cjk, 12)).toBe('审查中文标签');
  // The `#n` suffix survives, and the elided result still fits the budget.
  const suffixed = `${cjk}#3`;
  expect(width(truncateLabel(suffixed, 14))).toBeLessThanOrEqual(14);
  expect(truncateLabel(suffixed, 14)).toBe('审查中文标…#3');
});

// ─── the selected row is exactly one line ───

test('a narrow terminal keeps every agent row on a single line', async () => {
  // Regression: the row box sized itself to its content, so at 40 columns the
  // `model · Nk tok` column wrapped underneath the label. The row's
  // selectionBg background then painted BOTH lines — a highlight broken into
  // two bars, which flickered on every tick as the live duration changed width.
  const lines = await renderAt(
    <AgentList
      agents={[
        agent({
          id: 1,
          label: 'verify:correctness#12',
          status: 'running',
          model: 'claude-sonnet-5-20260101',
          tokenCount: 22_900,
          startedAt: Date.now() - 5_000,
        }),
        agent({
          id: 2,
          label: 'review:api',
          status: 'done',
          resultKind: 'ok',
          model: 'claude-opus-5-20260101',
          tokenCount: 122_900,
          startedAt: 1_000,
          endedAt: 5_000,
        }),
      ]}
      selectedIndex={0}
      focused
    />,
    40,
  );

  expect(lines).toHaveLength(2);
  for (const line of lines) expect(width(line)).toBeLessThanOrEqual(40);
});

test('the meta column stays intact and the label yields when width runs out', async () => {
  // Truncation policy: the right column carries the numbers the user is
  // watching, so it never shrinks; the label gives up columns instead.
  const lines = await renderAt(
    <AgentList
      agents={[
        agent({
          id: 1,
          label: 'verify:a-very-long-agent-label-that-cannot-fit',
          model: 'claude-sonnet-5-20260101',
          tokenCount: 22_900,
          startedAt: 1_000,
          endedAt: 4_000,
          status: 'done',
          resultKind: 'ok',
        }),
      ]}
      selectedIndex={0}
      focused
    />,
    44,
  );

  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('sonnet-5 · 22.9k tok');
  expect(lines[0]).toContain('…');
});

test('the row survives a pane narrower than the meta column itself', async () => {
  // The label column shrinking to nothing is not the end of it: below ~26 columns
  // the meta+time column is what no longer fits, and with the default wrap it
  // folded onto a second line — putting the two-bar highlight straight back.
  // /workflows gives the agent pane ~75%, so a 30-column terminal reaches here.
  for (const columns of [16, 18, 22, 26]) {
    const lines = await renderAt(
      <AgentList
        agents={[
          agent({
            id: 1,
            label: 'verify:correctness',
            model: 'claude-sonnet-5-20260101',
            tokenCount: 22_900,
            startedAt: Date.now() - 5_000,
          }),
        ]}
        selectedIndex={0}
        focused
      />,
      columns,
    );

    expect(lines).toHaveLength(1);
    expect(width(lines[0]!)).toBeLessThanOrEqual(columns);
  }
});

test('the phase sidebar survives a pane narrower than its counter', async () => {
  // Same failure mode one column over: `111/444` is 7 wide, so under 8 columns the
  // counter itself wrapped and each sidebar row became two.
  for (const columns of [4, 5, 6, 7]) {
    const lines = await renderAt(
      <PhaseSidebar
        phases={[{ title: 'Review', status: 'running', done: 111, total: 444 }]}
        agents={[agent({ id: 1 })]}
        selectedIndex={1}
        focused
      />,
      columns,
    );

    // All + 1 phase = 2 rows.
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(width(line)).toBeLessThanOrEqual(columns);
  }
});

test('a CJK label does not wrap the row it sits on', async () => {
  const lines = await renderAt(
    <AgentList
      agents={[
        agent({
          id: 1,
          label: '审查中文标签超长测试用例名称abcdef',
          model: 'claude-opus-5-20260101',
          tokenCount: 1_200,
          startedAt: 1_000,
          endedAt: 3_000,
          status: 'done',
          resultKind: 'ok',
        }),
      ]}
      selectedIndex={0}
      focused
    />,
    40,
  );

  expect(lines).toHaveLength(1);
  expect(width(lines[0]!)).toBeLessThanOrEqual(40);
});

// ─── retry backoff is visible on the row ───

test('retryMetaText reports a backoff in progress and nothing once it has elapsed', () => {
  const retrying = agent({
    id: 1,
    retryCount: 2,
    retryLimit: 3,
    lastFailureReason: 'api-error',
    retryingSince: 10_000,
    retryDelayMs: 5_000,
  });
  expect(retryMetaText(retrying, 12_000)).toBe('↻ 2/3 api-error');
  // The store never clears retryingSince (the engine only announces the start
  // of a backoff), so the elapsed check is what ends the retry display. Exactly
  // at the end of the window the backoff is over, not still pending.
  expect(retryMetaText(retrying, 15_000)).toBeNull();
  expect(retryMetaText(retrying, 99_000)).toBeNull();
  // A finished agent is never "retrying", whatever the leftover fields say —
  // agent_done leaves retryingSince in place, so without the status guard a
  // completed row would keep advertising a retry forever.
  expect(retryMetaText({ ...retrying, status: 'done' }, 12_000)).toBeNull();
  expect(retryMetaText({ ...retrying, status: 'done', resultKind: 'ok' }, 12_000)).toBeNull();
  // A zero-length backoff never shows: the engine retried immediately.
  expect(retryMetaText({ ...retrying, retryDelayMs: 0 }, 10_000)).toBeNull();
  expect(retryMetaText({ ...retrying, retryDelayMs: undefined }, 10_000)).toBeNull();
  expect(retryMetaText(agent({ id: 2 }), 12_000)).toBeNull();
});

test('retryMetaText degrades when the engine reports a partial retry record', () => {
  // retryLimit/lastFailureReason are optional on the wire; the marker must not
  // render `↻ 2/undefined` or a trailing space.
  expect(retryMetaText(agent({ id: 1, retryCount: 2, retryingSince: 0, retryDelayMs: 1_000 }), 500)).toBe('↻ 2');
  expect(retryMetaText(agent({ id: 1, retryingSince: 0, retryDelayMs: 1_000, lastFailureReason: 'threw' }), 500)).toBe(
    '↻ 1 threw',
  );
});

test('retryMetaText bounds the reason so it cannot eat the label column', () => {
  const text = retryMetaText(
    agent({
      id: 1,
      retryCount: 1,
      retryLimit: 5,
      lastFailureReason: 'a-really-long-engine-failure-reason',
      retryingSince: 0,
      retryDelayMs: 60_000,
    }),
    1_000,
  );
  expect(text).toBe('↻ 1/5 a-really-long…');
});

test('a retrying agent renders ↻ instead of a spinner and still fits one line', async () => {
  // "the agent looks like it died instantly": during a backoff the row used to
  // keep spinning with a frozen token count, indistinguishable from progress.
  const lines = await renderAt(
    <AgentList
      agents={[
        agent({
          id: 1,
          label: 'review:api',
          startedAt: Date.now() - 9_000,
          tokenCount: 900,
          retryCount: 2,
          retryLimit: 3,
          lastFailureReason: 'overloaded',
          retryingSince: Date.now(),
          retryDelayMs: 30_000,
        }),
      ]}
      selectedIndex={0}
      focused
    />,
    60,
  );

  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('↻ 2/3 overloaded');
  expect(lines[0]).toStartWith('↻');
  // The elapsed column keeps counting across the whole retry chain.
  expect(lines[0]).toContain('9s');
});

// ─── phase sidebar: same row invariant, quarter of the width ───

test('a long phase title truncates instead of wrapping the sidebar row', async () => {
  const lines = await renderAt(
    <PhaseSidebar
      phases={[
        { title: '扫描阶段名称非常长', status: 'done', done: 3, total: 3 },
        { title: 'Review', status: 'running', done: 1, total: 4 },
      ]}
      agents={[agent({ id: 1, status: 'done' }), agent({ id: 2 })]}
      selectedIndex={1}
      focused
    />,
    20,
  );

  // All + 2 phases = 3 rows, never 4.
  expect(lines).toHaveLength(3);
  for (const line of lines) expect(width(line)).toBeLessThanOrEqual(20);
  // The counter is the column that must survive.
  expect(lines[1]).toContain('3/3');
  expect(lines[1]).toContain('…');
  // The selection marker still leads the highlighted row.
  expect(lines[1]).toStartWith('>');
});

// ─── tab bar: underline measured in columns, and no reserved blank rows ───

function run(runId: string, workflowName: string, status: RunProgress['status'] = 'running'): RunProgress {
  return {
    runId,
    workflowName,
    status,
    phases: [],
    declaredPhases: [],
    currentPhase: null,
    agents: [],
    agentCount: 0,
    startedAt: 0,
    updatedAt: 0,
  };
}

test('the active tab underline spans the full displayed width of a CJK tab', async () => {
  const lines = await renderAt(
    <TabsBar
      runs={[run('aaaabbbb', '中文工作流名称'), run('ccccdddd', 'audit', 'completed')]}
      activeRunId="aaaabbbb"
    />,
    60,
  );

  expect(lines).toHaveLength(2);
  const underline = lines[1]!.trim();
  expect(underline).toMatch(/^═+$/);
  // dot + space + label. `.length` reported 13 for this tab; the label alone is
  // 18 columns wide, so the underline used to stop under its middle.
  const tabWidth = width('● 中文工作流名称#bbb');
  expect(underline.length).toBe(tabWidth);
});

test('an overflowing tab bar with no active run stays one line tall', async () => {
  // MAX_TABS is 6, so 8 runs fold the surplus into a `+2` column. That column used
  // to carry a `<Text> </Text>` spacer, and a Text holding a space is a full row —
  // so the bar grew a blank line under it. (An *empty* Text is zero rows, which is
  // why the per-tab branch never contributed one; only this column did.) With no
  // active run there is no underline to hide the extra row behind.
  const runs = Array.from({ length: 8 }, (_, i) => run(`run-000${i}`, `wf${i}`));
  const lines = await renderAt(<TabsBar runs={runs} activeRunId={null} />, 120);

  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('+2');
  expect(lines[0]).toContain('wf0#000');
  // The 7th and 8th runs are folded away, not rendered.
  expect(lines[0]).not.toContain('wf6');
});

test('an overflowing tab bar with an active run is exactly two lines', async () => {
  const runs = Array.from({ length: 8 }, (_, i) => run(`run-000${i}`, `wf${i}`));
  const lines = await renderAt(<TabsBar runs={runs} activeRunId="run-0000" />, 120);

  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain('+2');
  // Second line is the underline under the first tab and nothing else.
  expect(lines[1]!.trim()).toMatch(/^═+$/);
});

test('a single inactive tab renders one line, with no placeholder underline row', async () => {
  const lines = await renderAt(<TabsBar runs={[run('aaaabbbb', 'audit')]} activeRunId={null} />, 60);

  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('audit#bbbb');
});

test('the empty tab bar is a single line', async () => {
  const lines = await renderAt(<TabsBar runs={[]} activeRunId={null} />, 60);

  expect(lines).toEqual(['(no runs)']);
});
