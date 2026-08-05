import React from 'react';
import { Box, Text, stringWidth, useAnimationFrame } from '@anthropic/ink';
import type { Theme } from '@anthropic/ink';
import { truncateToWidth, truncateToWidthNoEllipsis } from '../../utils/text/truncate.js';
import type { AgentProgress } from '../progress/store.js';
import { agentElapsedMs, formatDuration } from './selectors.js';
import { agentMetaText, agentVisual, isRetryBackoffActive } from './status.js';

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
 * Width budget for the retry reason in the meta column. The reason replaces
 * `model · Nk tok` during a backoff, so it has to stay inside that column's
 * share of an 80-column terminal (the panel gives the agent pane ~75%).
 */
const RETRY_REASON_MAX = 14;

/**
 * Truncate the label to at most max display columns. Preserves the trailing `#number` suffix (the audit workflow
 * `verify:${dim}#${findingIdx}` format) - so verify agent labels with multiple findings under the same dimension
 * stay distinguishable (the prefix is elided with `…`). When there is no suffix, truncates from the right (legacy behavior).
 *
 * Measured in display columns, not code units: a CJK label counted by `.length` reports half its real width, so the
 * row it produced overflowed the container and wrapped — which is exactly what the selection highlight then painted
 * across two lines.
 *
 * Exported for unit test coverage.
 */
export function truncateLabel(raw: string, max: number): string {
  if (stringWidth(raw) <= max) return raw;
  const m = raw.match(/#\d+$/);
  if (!m) return truncateToWidthNoEllipsis(raw, max);
  const suffix = m[0]; // includes the # sign
  const prefix = raw.slice(0, raw.length - suffix.length);
  const available = max - stringWidth(suffix) - 1; // -1 reserved for …
  // A suffix wider than the whole budget leaves nothing to elide into; fall
  // back to a plain right-truncation rather than emitting a bare `…#12345`.
  if (available <= 0) return truncateToWidthNoEllipsis(raw, max);
  return `${truncateToWidthNoEllipsis(prefix, available)}…${suffix}`;
}

/**
 * Meta text for an agent parked in a retry backoff, or null when it is running normally.
 *
 * Without it the row shows a spinner and a frozen token count while the engine is asleep,
 * which is what made a retried agent look like it had died instantly. The backoff window
 * itself is decided by isRetryBackoffActive (see there for why the clock is involved).
 *
 * Exported for unit test coverage.
 */
export function retryMetaText(a: AgentProgress, now: number): string | null {
  if (!isRetryBackoffActive(a, now)) return null;
  const attempt = a.retryCount ?? 1;
  const of = a.retryLimit === undefined ? '' : `/${a.retryLimit}`;
  const reason = a.lastFailureReason ? ` ${truncateToWidth(a.lastFailureReason, RETRY_REASON_MAX)}` : '';
  return `↻ ${attempt}${of}${reason}`;
}

/**
 * Right-side agent list (already filtered by the selected phase).
 * Selected row: only when this column has focus (focused=true) does it paint a selectionBg background (keeps fg, not inverse color);
 * when focus is not on this column it does not paint the background color, to avoid a "fake focus".
 * The status mark of a running agent is driven by useAnimationFrame via a spinner animation (shared clock, globally synchronized);
 * the right side `model · Nk tok` is refreshed in real time by agent_progress / agent_done,
 * and is replaced by `↻ n/m reason` while the engine sits in a retry backoff.
 *
 * Row layout invariant: every row is exactly one terminal line. Both columns declare `truncate-end`, so when the
 * pane is too narrow they give up columns instead of wrapping — the label first (it shrinks), the meta text only
 * once the pane is narrower than the meta+time column itself. Without that, the right column wrapped onto a second
 * line which the selection background then painted too: a highlight broken into two bars, flickering as the live
 * token/duration text changed width. `width="100%"` is about the background, not the wrapping — it makes the
 * highlight span the pane rather than stopping at the end of the text.
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
        const retry = retryMetaText(a, now);
        // A backoff is not progress — freezing the spinner on ↻ is the whole
        // point: the row stops looking busy while nothing is happening.
        const mark = retry !== null ? '↻' : running ? frame : v.mark;
        const markColor = (retry !== null ? 'warning' : v.color) as keyof Theme;
        const label = truncateLabel(a.label ?? `agent-${a.id}`, LABEL_MAX);
        const elapsed = agentElapsedMs(a, now);
        return (
          <Box
            key={a.id}
            width="100%"
            backgroundColor={highlighted ? 'selectionBg' : undefined}
            justifyContent="space-between"
          >
            <Box flexShrink={1}>
              <Text wrap="truncate-end">
                <Text color={markColor}>{mark}</Text> {label}
              </Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              {/* truncate-end here too: flexShrink={0} keeps this column from yielding to
                  the label, but a pane narrower than the column itself still squeezes it,
                  and the default wrap would put the row back on two lines. */}
              <Text color={retry !== null ? 'warning' : 'subtle'} wrap="truncate-end">
                {retry ?? agentMetaText(a)}
              </Text>
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
