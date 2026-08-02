import * as React from 'react';
import { useEffect, type RefObject } from 'react';
import { Box, Text } from '@anthropic/ink';
import { useSearchInput } from '../../hooks/useSearchInput.js';
import type { JumpHandle } from '../../components/VirtualMessageList.js';

/** less-style / bar. 1-row, same border-top styling as TranscriptModeFooter
 *  so swapping them in the bottom slot doesn't shift ScrollBox height.
 *  useSearchInput handles readline editing; we report query changes and
 *  render the counter. Incremental — re-search + highlight per keystroke. */
export function TranscriptSearchBar({
  jumpRef,
  count,
  current,
  onClose,
  onCancel,
  setHighlight,
  initialQuery,
}: {
  jumpRef: RefObject<JumpHandle | null>;
  count: number;
  current: number;
  /** Enter — commit. Query persists for n/N. */
  onClose: (lastQuery: string) => void;
  /** Esc/ctrl+c/ctrl+g — undo to pre-/ state. */
  onCancel: () => void;
  setHighlight: (query: string) => void;
  // Seed with the previous query (less: / shows last pattern). Mount-fire
  // of the effect re-scans with the same query — idempotent (same matches,
  // nearest-ptr, same highlights). User can edit or clear.
  initialQuery: string;
}): React.ReactNode {
  const { query, cursorOffset } = useSearchInput({
    isActive: true,
    initialQuery,
    onExit: () => onClose(query),
    onCancel,
  });
  // Index warm-up runs before the query effect so it measures the real
  // cost — otherwise setSearchQuery fills the cache first and warm
  // reports ~0ms while the user felt the actual lag.
  // First / in a transcript session pays the extractSearchText cost.
  // Subsequent / return 0 immediately (indexWarmed ref in VML).
  // Transcript is frozen at ctrl+o so the cache stays valid.
  // Initial 'building' so warmDone is false on mount — the [query] effect
  // waits for the warm effect's first resolve instead of racing it. With
  // null initial, warmDone would be true on mount → [query] fires →
  // setSearchQuery fills cache → warm reports ~0ms while the user felt
  // the real lag.
  const [indexStatus, setIndexStatus] = React.useState<'building' | { ms: number } | null>('building');
  React.useEffect(() => {
    let alive = true;
    let hideTimeout: ReturnType<typeof setTimeout> | undefined;
    const warm = jumpRef.current?.warmSearchIndex;
    if (!warm) {
      setIndexStatus(null); // VML not mounted yet — rare, skip indicator
      return;
    }
    setIndexStatus('building');
    warm().then(ms => {
      if (!alive) return;
      // <20ms = imperceptible. No point showing "indexed in 3ms".
      if (ms < 20) {
        setIndexStatus(null);
      } else {
        setIndexStatus({ ms });
        hideTimeout = setTimeout(() => alive && setIndexStatus(null), 2000);
      }
    });
    return () => {
      alive = false;
      if (hideTimeout) clearTimeout(hideTimeout);
    };
  }, [jumpRef]); // mount-only per stable search bar ref
  // Gate the query effect on warm completion. setHighlight stays instant
  // (screen-space overlay, no indexing). setSearchQuery (the scan) waits.
  const warmDone = indexStatus !== 'building';
  useEffect(() => {
    if (!warmDone) return;
    jumpRef.current?.setSearchQuery(query);
    setHighlight(query);
  }, [jumpRef, query, setHighlight, warmDone]);
  const off = cursorOffset;
  const cursorChar = off < query.length ? query[off] : ' ';
  return (
    <Box
      borderTopDimColor
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderStyle="single"
      marginTop={1}
      paddingLeft={2}
      width="100%"
      // applySearchHighlight scans the whole screen buffer. The query
      // text rendered here IS on screen — /foo matches its own 'foo' in
      // the bar. With no content matches that's the ONLY visible match →
      // gets CURRENT → underlined. noSelect makes searchHighlight.ts:76
      // skip these cells (same exclusion as gutters). You can't text-
      // select the bar either; it's transient chrome, fine.
      noSelect
    >
      <Text>/</Text>
      <Text>{query.slice(0, off)}</Text>
      <Text inverse>{cursorChar}</Text>
      {off < query.length && <Text>{query.slice(off + 1)}</Text>}
      <Box flexGrow={1} />
      {indexStatus === 'building' ? (
        <Text dimColor>indexing… </Text>
      ) : indexStatus ? (
        <Text dimColor>indexed in {indexStatus.ms}ms </Text>
      ) : count === 0 && query ? (
        <Text color="error">no matches </Text>
      ) : count > 0 ? (
        // Engine-counted (indexOf on extractSearchText). May drift from
        // render-count for ghost/phantom messages — badge is a rough
        // location hint. scanElement gives exact per-message positions
        // but counting ALL would cost ~1-3ms × matched-messages.
        <Text dimColor>
          {current}/{count}
          {'  '}
        </Text>
      ) : null}
    </Box>
  );
}
