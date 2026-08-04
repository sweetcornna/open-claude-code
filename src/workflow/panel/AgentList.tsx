import React from 'react';
import { Box, Text, useAnimationFrame } from '@anthropic/ink';
import type { Theme } from '@anthropic/ink';
import type { AgentProgress } from '../progress/store.js';
import { agentElapsedMs, formatDuration } from './selectors.js';
import { agentMetaText, agentVisual } from './status.js';

const SPINNER_FRAMES = ['·', '✢', '✱', '✶', '✻', '✽'];
const FRAME_MS = 120;
/**
 * Label budget. Widened from 18 once the per-row tool count moved into the
 * detail view: agent labels carry the meaning (`verify:src/foo.ts#3`) and at
 * 18 chars every row in a fan-out phase truncated to the same prefix.
 */
const LABEL_MAX = 28;
/** Width of the time column, sized for the widest formatDuration output (`12h34m`). */
const TIME_COL = 6;

/**
 * Truncate the label to at most max characters. Preserves the trailing `#number` suffix (the audit workflow
 * `verify:${dim}#${findingIdx}` format) - so verify agent labels with multiple findings under the same dimension
 * stay distinguishable (the prefix is elided with `…`). When there is no suffix, truncates from the right (legacy behavior).
 * Exported for unit test coverage.
 */
export function truncateLabel(raw: string, max: number): string {
  if (raw.length <= max) return raw;
  const m = raw.match(/#\d+$/);
  if (!m) return raw.slice(0, max);
  const suffix = m[0]; // includes the # sign
  const prefix = raw.slice(0, raw.length - suffix.length);
  const available = max - suffix.length - 1; // -1 reserved for …
  return `${prefix.slice(0, available)}…${suffix}`;
}

/**
 * Right-side agent list (already filtered by the selected phase).
 * Selected row: only when this column has focus (focused=true) does it paint a selectionBg background (keeps fg, not inverse color);
 * when focus is not on this column it does not paint the background color, to avoid a "fake focus".
 * The status mark of a running agent is driven by useAnimationFrame via a spinner animation (shared clock, globally synchronized);
 * the right side `model · Nk tok · N tool` is refreshed in real time by agent_progress / agent_done.
 */
export function AgentList({
  agents,
  selectedIndex,
  focused,
  emptyText,
}: {
  agents: AgentProgress[];
  selectedIndex: number;
  focused: boolean;
  /** Override for the empty state — a status filter emptying the list is not the same as an empty phase. */
  emptyText?: string;
}): React.ReactNode {
  // Subscribe once to the animation frame at the top level: all running agents share the same frame (synchronized animation, avoids a per-row hook).
  const [ref, time] = useAnimationFrame(FRAME_MS);
  const frame = SPINNER_FRAMES[Math.floor(time / FRAME_MS) % SPINNER_FRAMES.length];

  if (agents.length === 0) {
    return <Text color="subtle">{emptyText ?? '(no agents in this phase)'}</Text>;
  }
  // One clock read per render, so every row's live duration ticks together
  // rather than drifting apart across the map.
  const now = Date.now();
  return (
    <Box ref={ref} flexDirection="column">
      {agents.map((a, i) => {
        const v = agentVisual(a);
        const selected = i === selectedIndex;
        const highlighted = selected && focused;
        const running = a.status === 'running';
        const mark = running ? frame : v.mark;
        const label = truncateLabel(a.label ?? `agent-${a.id}`, LABEL_MAX);
        const elapsed = agentElapsedMs(a, now);
        return (
          <Box key={a.id} backgroundColor={highlighted ? 'selectionBg' : undefined} justifyContent="space-between">
            <Box>
              <Text color={v.color as keyof Theme}>{mark}</Text>
              <Text> {label}</Text>
            </Box>
            <Box>
              <Text color="subtle">{agentMetaText(a)}</Text>
              <Box width={TIME_COL} justifyContent="flex-end">
                <Text color="subtle">{elapsed === null ? '–' : formatDuration(elapsed)}</Text>
              </Box>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
