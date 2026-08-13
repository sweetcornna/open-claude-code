import type { StructuredPatchHunk } from 'diff';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { useModalOrTerminalSize } from '../../context/modalContext.js';
import { useNotifications } from '../../context/notifications.js';
import { useRegisterOverlay } from '../../context/overlayContext.js';
import { type DiffData, useDiffData } from '../../hooks/useDiffData.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { type TurnDiff, useTurnDiffs } from '../../hooks/useTurnDiffs.js';
import { Box, type ScrollBoxHandle, Text } from '@anthropic/ink';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import type { Message } from '../../types/message.js';
import { plural } from '../../utils/text/stringUtils.js';
import { Byline, Dialog } from '@anthropic/ink';
import { DiffDetailView } from './DiffDetailView.js';
import { DiffFileList } from './DiffFileList.js';

type Props = {
  messages: Message[];
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void;
};

type ViewMode = 'list' | 'detail';

type DiffSource = { type: 'current' } | { type: 'turn'; turn: TurnDiff };

type DetailScrollAction =
  | 'lineUp'
  | 'lineDown'
  | 'pageUp'
  | 'pageDown'
  | 'fullPageUp'
  | 'fullPageDown'
  | 'top'
  | 'bottom';

const DETAIL_CHROME_ROWS = 8;
const MIN_DETAIL_VIEWPORT_ROWS = 3;
const MAX_DETAIL_VIEWPORT_ROWS = 24;

export function moveDiffSourceIndex(current: number, count: number, direction: -1 | 1, viewMode: ViewMode): number {
  if (viewMode !== 'list' || count <= 1) return current;
  return (current + direction + count) % count;
}

export function moveDiffFileIndex(current: number, count: number, direction: -1 | 1, viewMode: ViewMode): number {
  if (viewMode !== 'list' || count === 0) return current;
  return Math.max(0, Math.min(count - 1, current + direction));
}

export function applyDiffDetailScroll(handle: ScrollBoxHandle, action: DetailScrollAction): void {
  const viewportHeight = Math.max(1, handle.getViewportHeight());
  switch (action) {
    case 'lineUp':
      handle.scrollBy(-1);
      break;
    case 'lineDown':
      handle.scrollBy(1);
      break;
    case 'pageUp':
      handle.scrollBy(-Math.max(1, Math.floor(viewportHeight / 2)));
      break;
    case 'pageDown':
      handle.scrollBy(Math.max(1, Math.floor(viewportHeight / 2)));
      break;
    case 'fullPageUp':
      handle.scrollBy(-viewportHeight);
      break;
    case 'fullPageDown':
      handle.scrollBy(viewportHeight);
      break;
    case 'top':
      handle.scrollTo(0);
      break;
    case 'bottom':
      handle.scrollToBottom();
      break;
  }
}

function turnDiffToDiffData(turn: TurnDiff): DiffData {
  const files = Array.from(turn.files.values())
    .map(f => ({
      path: f.filePath,
      linesAdded: f.linesAdded,
      linesRemoved: f.linesRemoved,
      isBinary: false,
      isLargeFile: false,
      isTruncated: false,
      isNewFile: f.isNewFile,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const hunks = new Map<string, StructuredPatchHunk[]>();
  for (const f of turn.files.values()) {
    hunks.set(f.filePath, f.hunks);
  }

  return {
    stats: {
      filesCount: turn.stats.filesChanged,
      linesAdded: turn.stats.linesAdded,
      linesRemoved: turn.stats.linesRemoved,
    },
    files,
    hunks,
    loading: false,
  };
}

export function DiffDialog({ messages, onDone }: Props): React.ReactNode {
  const gitDiffData = useDiffData();
  const turnDiffs = useTurnDiffs(messages);
  const { setDiffPanelVisible } = useNotifications();

  useEffect(() => {
    setDiffPanelVisible(true);
    return () => setDiffPanelVisible(false);
  }, [setDiffPanelVisible]);

  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [sourceIndex, setSourceIndex] = useState<number>(0);
  const detailScrollRef = useRef<ScrollBoxHandle>(null);
  const { rows } = useModalOrTerminalSize(useTerminalSize());
  const detailViewportHeight = Math.max(
    MIN_DETAIL_VIEWPORT_ROWS,
    Math.min(MAX_DETAIL_VIEWPORT_ROWS, rows - DETAIL_CHROME_ROWS),
  );

  const sources: DiffSource[] = useMemo(
    () => [{ type: 'current' }, ...turnDiffs.map((turn): DiffSource => ({ type: 'turn', turn }))],
    [turnDiffs],
  );

  const currentSource = sources[sourceIndex];
  const currentTurn = currentSource?.type === 'turn' ? currentSource.turn : null;

  const diffData = useMemo((): DiffData => {
    return currentTurn ? turnDiffToDiffData(currentTurn) : gitDiffData;
  }, [currentTurn, gitDiffData]);

  const selectedFile = diffData.files[selectedIndex];
  const selectedHunks = useMemo(() => {
    return selectedFile ? diffData.hunks.get(selectedFile.path) || [] : [];
  }, [selectedFile, diffData.hunks]);

  // Clamp sourceIndex when sources shrink (e.g., conversation rewind)
  useEffect(() => {
    if (sourceIndex >= sources.length) {
      setSourceIndex(Math.max(0, sources.length - 1));
    }
  }, [sources.length, sourceIndex]);

  // Reset file selection when source changes
  const prevSourceIndex = useRef(sourceIndex);
  useEffect(() => {
    if (prevSourceIndex.current !== sourceIndex) {
      setSelectedIndex(0);
      prevSourceIndex.current = sourceIndex;
    }
  }, [sourceIndex]);

  // Register as modal overlay so Chat keybindings and CancelRequestHandler
  // are disabled while DiffDialog is showing
  useRegisterOverlay('diff-dialog');

  function scrollDetail(action: DetailScrollAction): void {
    if (viewMode !== 'detail' || !detailScrollRef.current) return;
    applyDiffDetailScroll(detailScrollRef.current, action);
  }

  // Diff dialog navigation keybindings. Source switching wraps exactly like
  // upstream and is disabled in detail mode, where arrows belong to scrolling.
  // Escape remains owned by Dialog's confirm:no handler; diff:dismiss exists so
  // its configurable shortcut can still be displayed.
  useKeybindings(
    {
      'diff:previousSource': () => {
        setSourceIndex(prev => moveDiffSourceIndex(prev, sources.length, -1, viewMode));
      },
      'diff:nextSource': () => {
        setSourceIndex(prev => moveDiffSourceIndex(prev, sources.length, 1, viewMode));
      },
      'diff:back': () => {
        if (viewMode === 'detail') setViewMode('list');
      },
      'diff:viewDetails': () => {
        if (viewMode === 'list' && selectedFile) setViewMode('detail');
      },
      'diff:previousFile': () => {
        if (viewMode === 'detail') {
          scrollDetail('lineUp');
        } else {
          setSelectedIndex(prev => moveDiffFileIndex(prev, diffData.files.length, -1, viewMode));
        }
      },
      'diff:nextFile': () => {
        if (viewMode === 'detail') {
          scrollDetail('lineDown');
        } else {
          setSelectedIndex(prev => moveDiffFileIndex(prev, diffData.files.length, 1, viewMode));
        }
      },
      'diff:pageUp': () => scrollDetail('pageUp'),
      'diff:pageDown': () => scrollDetail('pageDown'),
      'diff:fullPageUp': () => scrollDetail('fullPageUp'),
      'diff:fullPageDown': () => scrollDetail('fullPageDown'),
      'diff:top': () => scrollDetail('top'),
      'diff:bottom': () => scrollDetail('bottom'),
    },
    { context: 'DiffDialog' },
  );

  const subtitle = diffData.stats ? (
    <Text dimColor>
      {diffData.stats.filesCount} {plural(diffData.stats.filesCount, 'file')} changed
      {diffData.stats.linesAdded > 0 && <Text color="diffAddedWord"> +{diffData.stats.linesAdded}</Text>}
      {diffData.stats.linesRemoved > 0 && <Text color="diffRemovedWord"> -{diffData.stats.linesRemoved}</Text>}
    </Text>
  ) : null;

  // Build header based on current source
  const headerTitle = currentTurn ? `Turn ${currentTurn.turnIndex}` : 'Uncommitted changes';
  const headerSubtitle = currentTurn
    ? currentTurn.userPromptPreview
      ? `"${currentTurn.userPromptPreview}"`
      : ''
    : '(git diff HEAD)';

  // Source selector pills
  const sourceSelector =
    sources.length > 1 ? (
      <Box>
        {sourceIndex > 0 && <Text dimColor>◀ </Text>}
        {sources.map((source, i) => {
          const isSelected = i === sourceIndex;
          const label = source.type === 'current' ? 'Current' : `T${source.turn.turnIndex}`;
          return (
            <Text key={i} dimColor={!isSelected} bold={isSelected}>
              {i > 0 ? ' · ' : ''}
              {label}
            </Text>
          );
        })}
        {sourceIndex < sources.length - 1 && <Text dimColor> ▶</Text>}
      </Box>
    ) : null;

  const dismissShortcut = useShortcutDisplay('diff:dismiss', 'DiffDialog', 'esc');
  // Determine the appropriate message when no files are shown
  const emptyMessage = (() => {
    if (diffData.loading) {
      return 'Loading diff…';
    }
    if (currentTurn) {
      return 'No file changes in this turn';
    }
    // Check if we have stats but no files (too many files case)
    if (diffData.stats && diffData.stats.filesCount > 0 && diffData.files.length === 0) {
      return 'Too many files to display details';
    }
    return 'Working tree is clean';
  })();

  // Build title with header subtitle inline
  const title = (
    <Text>
      {headerTitle}
      {headerSubtitle && <Text dimColor> {headerSubtitle}</Text>}
    </Text>
  );

  // Handle cancel/dismiss - in detail mode goes back, in list mode dismisses
  function handleCancel(): void {
    if (viewMode === 'detail') {
      setViewMode('list');
    } else {
      onDone('Diff dialog dismissed', { display: 'system' });
    }
  }

  return (
    <Dialog
      title={title}
      onCancel={handleCancel}
      color="background"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : viewMode === 'list' ? (
          <Byline>
            {sources.length > 1 && <Text>←/→ source</Text>}
            <Text>↑/↓ select</Text>
            <Text>Enter view</Text>
            <Text>{dismissShortcut} close</Text>
          </Byline>
        ) : (
          <Byline>
            <Text>↑/↓ scroll</Text>
            <Text>PgUp/PgDn page</Text>
            <Text>{dismissShortcut} back</Text>
          </Byline>
        )
      }
    >
      {sourceSelector}
      {subtitle}
      {diffData.files.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>{emptyMessage}</Text>
        </Box>
      ) : viewMode === 'list' ? (
        <Box flexDirection="column" marginTop={1}>
          <DiffFileList files={diffData.files} selectedIndex={selectedIndex} />
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <DiffDetailView
            filePath={selectedFile?.path || ''}
            hunks={selectedHunks}
            isLargeFile={selectedFile?.isLargeFile}
            isBinary={selectedFile?.isBinary}
            isTruncated={selectedFile?.isTruncated}
            isUntracked={selectedFile?.isUntracked}
            scrollRef={detailScrollRef}
            viewportHeight={detailViewportHeight}
          />
        </Box>
      )}
    </Dialog>
  );
}
