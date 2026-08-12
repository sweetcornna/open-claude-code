/**
 * FleetView — the interactive `occ agents` list.
 *
 * Layout follows `LogSelector.tsx` (title, body, Byline footer), interaction
 * follows `BackgroundTasksDialog.tsx` (per-row actions on a single selection),
 * and the row itself follows `BackgroundAgentSelector`'s `AgentRow`.
 *
 * Every action is wired to something occ already had — attach/kill/logs are the
 * existing `src/cli/bg.ts` handlers, and Enter on a finished session goes down
 * the `--resume` path. The component itself performs none of them: it resolves
 * `onDone` with the chosen action so the caller can unmount Ink first. Attach
 * and resume both hand the terminal to a child process, and doing that under a
 * live Ink root leaves the alternate screen and raw mode fighting over stdin.
 */

import figures from 'figures';
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Byline, Divider, KeyboardShortcutHint, Text, useInput, useTerminalSize } from '@anthropic/ink';
import { BIN_NAME } from '../../constants/brand.js';
import { FleetList } from './FleetList.js';
import { type FleetRow, isAttachableRow, isResumableRow } from './fleetRows.js';
import { useFleetSessions } from './useFleetSessions.js';

export type FleetAction =
  | { type: 'attach'; row: FleetRow }
  | { type: 'resume'; row: FleetRow }
  | { type: 'kill'; row: FleetRow }
  | { type: 'logs'; row: FleetRow };

/** Rows reserved for title, divider, footer and breathing room. */
const CHROME_ROWS = 8;
const MIN_LIST_ROWS = 5;
const AGE_TICK_MS = 1000;

export function FleetView({
  onDone,
  currentCwd,
}: {
  onDone: (action: FleetAction | null) => void;
  currentCwd?: string;
}): React.ReactNode {
  const { rows, groups, loading, error, refresh } = useFleetSessions({ currentCwd });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { rows: terminalRows } = useTerminalSize();

  // Ages are read from timestamps, so they only look live if something
  // re-renders. The poll is 2s; this keeps the seconds column honest.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // ↑/↓ must walk the list the way it is drawn. `rows` is sorted running-first
  // for the counters, but the body is grouped by project — navigating the flat
  // order would make the cursor jump between distant groups.
  const orderedRows = useMemo(() => groups.flatMap(group => group.rows), [groups]);

  // Selection follows the row id, not the index: the 2s poll can insert a
  // newly-started session above the cursor, and an index would silently move
  // the selection onto a different session between keypress and action.
  useEffect(() => {
    if (orderedRows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId === null || !orderedRows.some(row => row.id === selectedId)) {
      setSelectedId(orderedRows[0]!.id);
    }
  }, [orderedRows, selectedId]);

  const selectedIndex = useMemo(() => orderedRows.findIndex(row => row.id === selectedId), [orderedRows, selectedId]);
  const selected = selectedIndex >= 0 ? orderedRows[selectedIndex] : undefined;

  function move(delta: number): void {
    if (orderedRows.length === 0) return;
    const base = selectedIndex < 0 ? 0 : selectedIndex;
    const next = Math.min(orderedRows.length - 1, Math.max(0, base + delta));
    setSelectedId(orderedRows[next]!.id);
  }

  useInput((input, key) => {
    if (key.upArrow || (key.ctrl && input === 'p')) {
      move(-1);
      return;
    }
    if (key.downArrow || (key.ctrl && input === 'n')) {
      move(1);
      return;
    }
    if (key.escape || input === 'q') {
      onDone(null);
      return;
    }
    if (input === 'r') {
      refresh();
      return;
    }
    if (!selected) return;
    if (key.return) {
      // A live session that is not a background session has nothing to hand
      // over: no pane, no managed log, and its transcript is still being
      // written by the process that owns it.
      if (isResumableRow(selected)) onDone({ type: 'resume', row: selected });
      else if (isAttachableRow(selected)) onDone({ type: 'attach', row: selected });
      return;
    }
    if (input === 'k' && selected.state !== 'ended') {
      onDone({ type: 'kill', row: selected });
      return;
    }
    if (input === 'l' && isAttachableRow(selected)) {
      onDone({ type: 'logs', row: selected });
    }
  });

  const liveCount = rows.filter(row => row.state !== 'ended').length;
  const maxRows = Math.max(MIN_LIST_ROWS, terminalRows - CHROME_ROWS);

  const actions = [
    <KeyboardShortcutHint key="move" shortcut="↑/↓" action="select" />,
    ...(selected && isResumableRow(selected)
      ? [<KeyboardShortcutHint key="open" shortcut="Enter" action="resume" />]
      : []),
    ...(selected && isAttachableRow(selected)
      ? [
          <KeyboardShortcutHint key="open" shortcut="Enter" action="attach" />,
          <KeyboardShortcutHint key="logs" shortcut="l" action="logs" />,
        ]
      : []),
    ...(selected && selected.state !== 'ended' ? [<KeyboardShortcutHint key="kill" shortcut="k" action="kill" />] : []),
    <KeyboardShortcutHint key="refresh" shortcut="r" action="refresh" />,
    <KeyboardShortcutHint key="quit" shortcut="esc" action="quit" />,
  ];

  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Text bold>
        {figures.pointer} {BIN_NAME} sessions
      </Text>
      <Text dimColor>
        {loading
          ? 'Loading sessions…'
          : `${liveCount} running · ${rows.length - liveCount} resumable · refreshing every 2s`}
      </Text>
      <Divider />
      {error ? <Text color="error">Could not read sessions: {error}</Text> : null}
      <FleetList groups={groups} selectedId={selectedId} now={now} maxRows={maxRows} />
      <Divider />
      <Text dimColor>
        <Byline>{actions}</Byline>
      </Text>
    </Box>
  );
}
