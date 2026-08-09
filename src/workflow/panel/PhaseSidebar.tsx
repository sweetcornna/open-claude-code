import React from 'react';
import { Box, Text, stringWidth, useAnimationFrame } from '@anthropic/ink';
import type { Theme } from '@anthropic/ink';
import { truncateToWidth } from '../../utils/text/truncate.js';
import type { AgentProgress } from '../progress/store.js';
import { PHASE_COLOR, PHASE_MARK, type PhaseStatus } from './status.js';
import { ALL_PHASE, type MergedPhase } from './selectors.js';

const SPINNER_FRAMES = ['·', '✢', '✱', '✶', '✻', '✽'];
const FRAME_MS = 120;

type PhaseRow = {
  title: string;
  status?: PhaseStatus;
  done: number;
  total: number;
};

/**
 * Left phase sidebar: the first row is All (aggregating done/total), followed by the merged phases (including pending ○).
 * Selected row: only when this column has focus (focused=true) does it paint a selectionBg background (keeps fg, not inverse color) + a `>` marker;
 * when focus is not on this column it does not paint the background color, to avoid a "fake focus". The status mark of a running phase is driven by useAnimationFrame via a spinner animation.
 * Style aligns with the reference image: `> ✓ Scan  3/3`.
 */
export function PhaseSidebar({
  phases,
  agents,
  selectedIndex,
  focused,
  width,
  maxRows,
}: {
  phases: MergedPhase[];
  agents: AgentProgress[];
  selectedIndex: number;
  focused: boolean;
  width: number;
  maxRows?: number;
}): React.ReactNode {
  const [ref, time] = useAnimationFrame(FRAME_MS);
  const frame = SPINNER_FRAMES[Math.floor(time / FRAME_MS) % SPINNER_FRAMES.length];
  const totalAgents = agents.length;
  const doneAgents = agents.filter(a => a.status === 'done').length;
  const rows: PhaseRow[] = [{ title: ALL_PHASE, done: doneAgents, total: totalAgents }, ...phases];
  const rowBudget = Math.max(1, Math.trunc(maxRows ?? rows.length));
  const contentBudget = rows.length > rowBudget ? Math.max(1, rowBudget - 2) : rowBudget;
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(contentBudget / 2)),
    Math.max(0, rows.length - contentBudget),
  );
  const visible = rows.slice(start, start + contentBudget);
  const hiddenAbove = start;
  const hiddenBelow = rows.length - start - visible.length;
  const rowWidth = Math.max(1, Math.trunc(width));

  return (
    <Box ref={ref} width={rowWidth} flexDirection="column" height={rowBudget} overflowY="hidden">
      {hiddenAbove > 0 ? (
        <Text color="subtle" wrap="truncate-end">
          {truncateToWidth(`… ${hiddenAbove} earlier`, rowWidth)}
        </Text>
      ) : null}
      {visible.map((row, localIndex) => {
        const i = start + localIndex;
        const selected = i === selectedIndex;
        const highlighted = selected && focused;
        const running = row.status === 'running';
        const mark = running ? frame : row.status ? PHASE_MARK[row.status] : ' ';
        const color = (row.status ? PHASE_COLOR[row.status] : 'subtle') as keyof Theme;
        const rawCounter = `${row.done}/${row.total}`;
        const counterBudget = Math.max(0, rowWidth - 5);
        const counter = counterBudget > 0 ? truncateToWidth(rawCounter, counterBudget) : '';
        const counterGap = counter === '' ? 0 : 1;
        const titleBudget = Math.max(0, rowWidth - 4 - counterGap - stringWidth(counter));
        const title = titleBudget > 0 ? truncateToWidth(row.title, titleBudget) : '';
        return (
          <Box
            key={row.title}
            width="100%"
            backgroundColor={highlighted ? 'selectionBg' : undefined}
            justifyContent="space-between"
          >
            {/* One line per row, always: the sidebar is 25% of the terminal, so a long
                (or CJK, i.e. double-width) phase title used to wrap and the selection
                background painted both lines. The title yields first; the counter only
                truncates once the sidebar is narrower than the counter itself. Both need
                truncate-end — the default wrap is what put the row on two lines. */}
            <Box flexShrink={1}>
              <Text wrap="truncate-end">
                <Text color={selected ? 'claude' : undefined}>{highlighted ? '>' : ' '}</Text>{' '}
                <Text color={color}>{mark}</Text> {title}
              </Text>
            </Box>
            {counter === '' ? null : (
              <Box flexShrink={0} marginLeft={1}>
                <Text color="subtle" wrap="truncate-end">
                  {counter}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}
      {hiddenBelow > 0 ? (
        <Text color="subtle" wrap="truncate-end">
          {truncateToWidth(`… ${hiddenBelow} more`, rowWidth)}
        </Text>
      ) : null}
    </Box>
  );
}
