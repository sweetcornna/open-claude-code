import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import React from 'react';
import stripAnsi from 'strip-ansi';
import {
  KeybindingSetup,
  type KeybindingsLoadResult,
  parseBindings,
  type ScrollBoxHandle,
  wrappedRender as render,
} from '@anthropic/ink';
import type { StructuredPatchHunk } from 'diff';
import { AppStoreContext, getDefaultAppState } from '../../../state/AppState.js';
import { createStore } from '../../../state/store.js';
import { applyDiffDetailScroll, moveDiffFileIndex, moveDiffSourceIndex } from '../DiffDialog.js';
import { DiffDetailView } from '../DiffDetailView.js';

const TEST_BINDINGS: KeybindingsLoadResult = {
  bindings: parseBindings([
    {
      context: 'DiffDialog',
      bindings: {
        left: 'diff:previousSource',
        right: 'diff:nextSource',
        up: 'diff:previousFile',
        down: 'diff:nextFile',
        enter: 'diff:viewDetails',
        pageup: 'diff:pageUp',
        pagedown: 'diff:pageDown',
        space: 'diff:fullPageDown',
        b: 'diff:fullPageUp',
        g: 'diff:top',
        'shift+g': 'diff:bottom',
        home: 'diff:top',
        end: 'diff:bottom',
      },
    },
  ]),
  warnings: [],
};

function fakeTty(): NodeJS.ReadStream {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30));
}

function longHunk(lineCount: number): StructuredPatchHunk {
  return {
    oldStart: 1,
    oldLines: lineCount,
    newStart: 1,
    newLines: lineCount,
    lines: Array.from({ length: lineCount }, (_, index) => ` line-${String(index).padStart(3, '0')}`),
  };
}

async function renderDetail(props: Partial<React.ComponentProps<typeof DiffDetailView>> = {}): Promise<{
  output: () => string;
  scroll: () => ScrollBoxHandle;
  unmount: () => void;
}> {
  const stdout = new PassThrough();
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  let output = '';
  stdout.on('data', chunk => {
    output += chunk.toString();
  });
  stdout.resume();

  const scrollRef = React.createRef<ScrollBoxHandle>();
  const store = createStore(getDefaultAppState());
  const instance = await render(
    <AppStoreContext.Provider value={store}>
      <KeybindingSetup loadBindings={() => TEST_BINDINGS} subscribeToChanges={() => () => {}}>
        <DiffDetailView
          filePath="src/long.ts"
          hunks={[longHunk(120)]}
          scrollRef={scrollRef}
          viewportHeight={6}
          {...props}
        />
      </KeybindingSetup>
    </AppStoreContext.Provider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: fakeTty(),
      patchConsole: false,
    },
  );
  await settle();

  return {
    output: () => stripAnsi(output),
    scroll: () => {
      if (!scrollRef.current) throw new Error('detail ScrollBox did not mount');
      return scrollRef.current;
    },
    unmount: instance.unmount,
  };
}

describe('DiffDetailView viewport', () => {
  test('long diffs use a bounded ScrollBox instead of expanding to all rows', async () => {
    const mounted = await renderDetail();
    try {
      expect(mounted.scroll().getViewportHeight()).toBe(6);
      expect(mounted.scroll().getScrollHeight()).toBeGreaterThan(100);
      expect(mounted.output()).toContain('line-000');
      expect(mounted.output()).not.toContain('line-119');
    } finally {
      mounted.unmount();
    }
  });

  test('truncated and binary detail states remain visible', async () => {
    const truncated = await renderDetail({ isTruncated: true });
    try {
      expect(truncated.output()).toContain('(truncated)');
      applyDiffDetailScroll(truncated.scroll(), 'bottom');
      await settle();
      expect(truncated.output()).toContain('diff truncated (exceeded 400 line limit)');
    } finally {
      truncated.unmount();
    }

    const binary = await renderDetail({ hunks: [], isBinary: true });
    try {
      expect(binary.output()).toContain('Binary file - cannot display diff');
    } finally {
      binary.unmount();
    }

    const large = await renderDetail({ hunks: [], isLargeFile: true });
    try {
      expect(large.output()).toContain('Large file - diff exceeds 1 MB limit');
    } finally {
      large.unmount();
    }
  });
});

describe('list/detail focus isolation', () => {
  test('source navigation wraps only in list view', () => {
    expect(moveDiffSourceIndex(0, 3, -1, 'list')).toBe(2);
    expect(moveDiffSourceIndex(2, 3, 1, 'list')).toBe(0);
    expect(moveDiffSourceIndex(1, 3, 1, 'detail')).toBe(1);
  });

  test('file navigation clamps in list view and does not move selection in detail view', () => {
    expect(moveDiffFileIndex(0, 3, -1, 'list')).toBe(0);
    expect(moveDiffFileIndex(2, 3, 1, 'list')).toBe(2);
    expect(moveDiffFileIndex(1, 3, 1, 'detail')).toBe(1);
  });
});

describe('diff detail scrolling', () => {
  test('line, half-page, full-page, top, and bottom actions use viewport-relative offsets', () => {
    let top = 10;
    const calls: string[] = [];
    const handle = {
      getViewportHeight: () => 9,
      getScrollTop: () => top,
      getPendingDelta: () => 0,
      getScrollHeight: () => 100,
      scrollBy: (delta: number) => {
        top += delta;
        calls.push(`by:${delta}`);
      },
      scrollTo: (value: number) => {
        top = value;
        calls.push(`to:${value}`);
      },
      scrollToBottom: () => calls.push('bottom'),
    } as unknown as ScrollBoxHandle;

    applyDiffDetailScroll(handle, 'lineUp');
    applyDiffDetailScroll(handle, 'lineDown');
    applyDiffDetailScroll(handle, 'pageUp');
    applyDiffDetailScroll(handle, 'pageDown');
    applyDiffDetailScroll(handle, 'fullPageUp');
    applyDiffDetailScroll(handle, 'fullPageDown');
    applyDiffDetailScroll(handle, 'top');
    applyDiffDetailScroll(handle, 'bottom');

    expect(calls).toEqual(['by:-1', 'by:1', 'by:-4', 'by:4', 'by:-9', 'by:9', 'to:0', 'bottom']);
  });
});
