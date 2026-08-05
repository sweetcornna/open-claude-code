import React from 'react';
import { Box, Text, useAnimationFrame } from '@anthropic/ink';
import type { Theme } from '@anthropic/ink';
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
}: {
  phases: MergedPhase[];
  agents: AgentProgress[];
  selectedIndex: number;
  focused: boolean;
}): React.ReactNode {
  const [ref, time] = useAnimationFrame(FRAME_MS);
  const frame = SPINNER_FRAMES[Math.floor(time / FRAME_MS) % SPINNER_FRAMES.length];
  const totalAgents = agents.length;
  const doneAgents = agents.filter(a => a.status === 'done').length;
  const rows: PhaseRow[] = [{ title: ALL_PHASE, done: doneAgents, total: totalAgents }, ...phases];

  return (
    <Box ref={ref} flexDirection="column">
      {rows.map((row, i) => {
        const selected = i === selectedIndex;
        const highlighted = selected && focused;
        const running = row.status === 'running';
        const mark = running ? frame : row.status ? PHASE_MARK[row.status] : ' ';
        const color = (row.status ? PHASE_COLOR[row.status] : 'subtle') as keyof Theme;
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
                <Text color={color}>{mark}</Text> {row.title}
              </Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <Text color="subtle" wrap="truncate-end">
                {row.done}/{row.total}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
