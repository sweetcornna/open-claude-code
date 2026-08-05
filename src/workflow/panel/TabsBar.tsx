import React from 'react';
import { Box, Text, stringWidth } from '@anthropic/ink';
import type { Theme } from '@anthropic/ink';
import type { RunProgress } from '../progress/store.js';
import { RUN_STATUS_COLOR, STATUS_DOT } from './status.js';
import { capTabsForDisplay, tabLabel } from './selectors.js';
import { truncateLabel } from './AgentList.js';

/**
 * Per-tab name width budget. Long workflow names truncate (keeping the `#xxxx` short-code suffix so
 * same-name runs stay distinguishable). Sized for a ~120-col terminal: ~6 tabs fit per row.
 */
const TAB_LABEL_MAX = 18;

/**
 * Hard ceiling on simultaneously rendered tabs. Defensive fallback: even if active runs accumulate
 * (long-lived session, runaway launcher), the row must never overflow the terminal width and
 * re-introduce the garbled overlapping render seen previously. Surplus runs are folded into `+N`.
 */
const MAX_TABS = 6;

/**
 * Top run tab row: one tab per run (status dot + name + #short code).
 * The current tab is highlighted with an orange ═ underline.
 *
 * Defenses against overflow:
 * - Per-tab name truncated via truncateLabel (keeps `#xxxx` suffix for disambiguation).
 * - Row capped at MAX_TABS; remainder rendered as a `+N` marker so total width is bounded.
 */
export function TabsBar({ runs, activeRunId }: { runs: RunProgress[]; activeRunId: string | null }): React.ReactNode {
  if (runs.length === 0) {
    return <Text color="subtle">(no runs)</Text>;
  }
  const { runs: visible, overflow } = capTabsForDisplay(runs, MAX_TABS);
  return (
    <Box>
      {visible.map(r => {
        const active = r.runId === activeRunId;
        const label = truncateLabel(tabLabel(r.workflowName, r.runId), TAB_LABEL_MAX);
        // Display columns, not code units: `.length` under-counts CJK (and the `…`
        // that truncateLabel inserts), so the underline stopped short of the label
        // it is supposed to sit under.  +2 covers the status dot and its space.
        const underline = '═'.repeat(stringWidth(label) + 2);
        return (
          <Box key={r.runId} flexDirection="column" marginRight={2}>
            <Box>
              <Text color={RUN_STATUS_COLOR[r.status] as keyof Theme}>{STATUS_DOT[r.status]}</Text>
              <Text> </Text>
              <Text color={active ? 'claude' : undefined} bold={active}>
                {label}
              </Text>
            </Box>
            {/* Underline row, active tab only. (Rendering `<Text>{''}</Text>` for the
                inactive ones was equivalent — ink gives an empty Text zero rows — but
                saying so with `null` keeps it from reading like a height placeholder.) */}
            {active ? <Text color="claude">{underline}</Text> : null}
          </Box>
        );
      })}
      {overflow > 0 ? (
        <Box flexDirection="column" marginRight={2}>
          {/* No second row here: this column used to carry a `<Text> </Text>` spacer,
              and a Text holding a *space* is one row tall — so whenever runs overflowed,
              the tab bar grew a blank line under it. The row Box stretches the columns
              to equal height on its own. */}
          <Text color="subtle">+{overflow}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
