/**
 * Rendering coverage for the FleetView list body.
 *
 * `FleetList` is presentational on purpose, so this renders it with the repo's
 * static Ink renderer against fabricated rows — no polling, no timers, no
 * mocks. Multi-keystroke interaction is not exercised here: Ink's test mode
 * does not pump concurrent state updates, which makes keypress tests in this
 * repo unreliable (see WorkspaceKeyInput.test.tsx).
 */
import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToString } from '../../../utils/terminal/staticRender.js';
import { FleetList, flattenFleetGroups, windowItems } from '../FleetList.js';
import { type FleetGroup, groupRowsByProject, joinFleetRows } from '../fleetRows.js';

const NOW = 1_000_000;

function groups(): FleetGroup[] {
  const rows = joinFleetRows(
    [
      {
        pid: 101,
        sessionId: 'live-1',
        cwd: '/repo/alpha',
        startedAt: NOW - 90_000,
        status: 'busy',
      },
      { pid: 102, sessionId: 'fresh-1', cwd: '/repo/alpha', startedAt: NOW - 2_000 },
    ],
    [
      {
        sessionId: 'live-1',
        summary: 'wire up the fleet view',
        cwd: '/repo/alpha',
        gitBranch: 'feat/fleet',
        lastModified: NOW - 5_000,
      },
      {
        sessionId: 'dead-1',
        summary: 'yesterdays refactor',
        cwd: '/repo/beta',
        lastModified: NOW - 7_200_000,
      },
    ],
  );
  return groupRowsByProject(rows, { currentCwd: '/repo/alpha' });
}

describe('FleetList', () => {
  test('renders one row per session under its project heading', async () => {
    const out = await renderToString(<FleetList groups={groups()} selectedId="live-1" now={NOW} />, 100);
    expect(out).toContain('/repo/alpha');
    expect(out).toContain('/repo/beta');
    expect(out).toContain('wire up the fleet view');
    expect(out).toContain('yesterdays refactor');
    expect(out).toContain('new session');
  });

  test('each of the three states reports itself in the meta column', async () => {
    const out = await renderToString(<FleetList groups={groups()} selectedId="live-1" now={NOW} />, 100);
    // live rows show their pushed activity, not a generic verb
    expect(out).toContain('busy');
    expect(out).toContain('starting');
    expect(out).toContain('ended');
  });

  test('branch and highest-unit age ride along on the row itself', async () => {
    // One row must occupy exactly one line: a wrapped row would desynchronise
    // the drawn list from the selection index.
    const out = await renderToString(<FleetList groups={groups()} selectedId="live-1" now={NOW} />, 100);
    const liveLine = out.split('\n').find(line => line.includes('wire up the fleet view'));
    expect(liveLine).toContain('feat/fleet');
    expect(liveLine).toContain('1m'); // live-1 started 90s ago
    const endedLine = out.split('\n').find(line => line.includes('yesterdays refactor'));
    expect(endedLine).toContain('2h'); // dead-1 last written 2h ago
  });

  test('a very long label truncates instead of wrapping the row', async () => {
    const long = joinFleetRows(
      [],
      [
        {
          sessionId: 'long-1',
          summary: 'x'.repeat(400),
          cwd: '/repo/alpha',
          lastModified: NOW - 60_000,
        },
      ],
    );
    const out = await renderToString(<FleetList groups={groupRowsByProject(long)} selectedId="long-1" now={NOW} />, 60);
    const rowLines = out.split('\n').filter(line => line.includes('x'));
    expect(rowLines).toHaveLength(1);
    expect(rowLines[0]).toContain('ended');
    expect(rowLines[0]).toContain('1m');
  });

  test('the selection pointer marks exactly one row', async () => {
    const out = await renderToString(<FleetList groups={groups()} selectedId="dead-1" now={NOW} />, 100);
    const pointerLines = out.split('\n').filter(line => line.includes('❯'));
    expect(pointerLines).toHaveLength(1);
    expect(pointerLines[0]).toContain('yesterdays refactor');
  });

  test('an empty fleet says so instead of rendering a bare frame', async () => {
    const out = await renderToString(<FleetList groups={[]} selectedId={null} now={NOW} />, 100);
    expect(out).toContain('No sessions found.');
  });
});

describe('flattenFleetGroups', () => {
  test('emits a heading before each group and counts its rows', () => {
    const items = flattenFleetGroups(groups());
    expect(items[0]).toMatchObject({ kind: 'heading', label: '/repo/alpha', count: 2 });
    expect(items.filter(item => item.kind === 'heading')).toHaveLength(2);
    expect(items.filter(item => item.kind === 'row')).toHaveLength(3);
  });
});

describe('windowItems', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'];

  test('returns everything when it fits', () => {
    expect(windowItems(items, 0, 10)).toEqual(items);
  });

  test('keeps the selection inside the window as it moves down', () => {
    expect(windowItems(items, 0, 3)).toEqual(['a', 'b', 'c']);
    expect(windowItems(items, 3, 3)).toEqual(['c', 'd', 'e']);
    expect(windowItems(items, 5, 3)).toEqual(['d', 'e', 'f']);
  });

  test('never runs off either end', () => {
    expect(windowItems(items, -1, 3)).toEqual(['a', 'b', 'c']);
    expect(windowItems(items, 99, 3)).toEqual(['d', 'e', 'f']);
  });
});
