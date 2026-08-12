/**
 * FleetView's list body — presentational only.
 *
 * Kept separate from `FleetView.tsx` so the rendering can be pinned with the
 * repo's static Ink renderer (`renderToString`) against fabricated rows: no
 * polling, no timers, no mocks. Row shape follows `BackgroundAgentSelector`'s
 * `AgentRow` (pointer, status dot, label, right-aligned meta) and the grouping
 * follows the official view, which uses cwd as a heading rather than a column.
 */

import figures from 'figures';
import { Box, Text } from '@anthropic/ink';
import {
  describeFleetRowState,
  fleetRowAgeMs,
  formatAge,
  type FleetGroup,
  type FleetRow,
  type FleetRowState,
} from './fleetRows.js';

/** Always filled — the glyph carries state via color, not shape (as AgentRow). */
const STATUS_DOT = '●';
const SELECTED_PREFIX = `${figures.pointer} `;
const UNSELECTED_PREFIX = '  ';

type SemanticColor = 'success' | 'warning' | 'error' | 'background' | 'suggestion';

function fleetStateColor(state: FleetRowState): SemanticColor | undefined {
  switch (state) {
    case 'live':
      return 'success';
    case 'starting':
      return 'warning';
    case 'ended':
      return undefined;
  }
}

/**
 * Slice a window of `maxRows` display lines that keeps `selectedIndex` visible.
 * Group headings count as lines, so a group that scrolls out takes its heading
 * with it — which is why the window is computed over flattened items.
 */
export function windowItems<T>(items: readonly T[], selectedIndex: number, maxRows: number): T[] {
  if (maxRows <= 0 || items.length <= maxRows) return [...items];
  const half = Math.floor(maxRows / 2);
  const start = Math.min(Math.max(0, selectedIndex - half), items.length - maxRows);
  return items.slice(start, start + maxRows);
}

type DisplayItem = { kind: 'heading'; key: string; label: string; count: number } | { kind: 'row'; row: FleetRow };

export function flattenFleetGroups(groups: readonly FleetGroup[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const group of groups) {
    items.push({
      kind: 'heading',
      key: `heading:${group.cwd}`,
      label: group.label,
      count: group.rows.length,
    });
    for (const row of group.rows) items.push({ kind: 'row', row });
  }
  return items;
}

function FleetRowLine({ row, selected, now }: { row: FleetRow; selected: boolean; now: number }): React.ReactNode {
  const ageMs = fleetRowAgeMs(row, now);
  const meta = [describeFleetRowState(row), row.gitBranch, ageMs === undefined ? undefined : formatAge(ageMs)]
    .filter(Boolean)
    .join(' · ');
  return (
    <Box flexDirection="row" width="100%" justifyContent="space-between">
      <Box flexDirection="row" flexShrink={1}>
        <Text bold={selected}>{selected ? SELECTED_PREFIX : UNSELECTED_PREFIX}</Text>
        <Text color={fleetStateColor(row.state)} dimColor={row.state === 'ended'}>
          {STATUS_DOT}{' '}
        </Text>
        <Text bold={selected} wrap="truncate-end">
          {row.label}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor> {meta}</Text>
      </Box>
    </Box>
  );
}

export function FleetList({
  groups,
  selectedId,
  now,
  maxRows = 20,
}: {
  groups: FleetGroup[];
  selectedId: string | null;
  now: number;
  maxRows?: number;
}): React.ReactNode {
  const items = flattenFleetGroups(groups);
  if (items.length === 0) {
    return <Text dimColor>No sessions found.</Text>;
  }
  const selectedIndex = items.findIndex(item => item.kind === 'row' && item.row.id === selectedId);
  const visible = windowItems(items, selectedIndex < 0 ? 0 : selectedIndex, maxRows);

  return (
    <Box flexDirection="column" width="100%">
      {visible.map(item =>
        item.kind === 'heading' ? (
          <Text key={item.key} dimColor>
            <Text bold>{item.label}</Text> ({item.count})
          </Text>
        ) : (
          <FleetRowLine key={item.row.id} row={item.row} selected={item.row.id === selectedId} now={now} />
        ),
      )}
    </Box>
  );
}
