import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import React from 'react';
import { wrappedRender as render } from '@anthropic/ink';
import { type SelectNavigation, useSelectNavigation } from '../use-select-navigation.js';

const options = Array.from({ length: 10 }, (_, index) => ({
  label: `Option ${index}`,
  value: index,
}));

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function mountNavigation(
  visibleOptionCount: number,
  initialFocusValue: number,
): Promise<{
  current: () => SelectNavigation<number>;
  rerender: (nextVisibleOptionCount: number) => Promise<void>;
  unmount: () => void;
}> {
  let navigation: SelectNavigation<number> | undefined;

  function Probe({ count }: { count: number }): React.ReactNode {
    navigation = useSelectNavigation({
      options,
      visibleOptionCount: count,
      initialFocusValue,
    });
    return null;
  }

  const stdout = new PassThrough();
  stdout.resume();
  const instance = await render(<Probe count={visibleOptionCount} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  });
  await settle();

  return {
    current: () => {
      if (!navigation) throw new Error('navigation hook did not render');
      return navigation;
    },
    rerender: async nextVisibleOptionCount => {
      instance.rerender(<Probe count={nextVisibleOptionCount} />);
      await settle();
    },
    unmount: instance.unmount,
  };
}

test('resizing recomputes an exact window and keeps focus visible', async () => {
  const mounted = await mountNavigation(5, 8);
  try {
    expect(mounted.current().visibleOptions.map(option => option.index)).toEqual([4, 5, 6, 7, 8]);

    await mounted.rerender(2);
    expect(mounted.current().visibleOptions.map(option => option.index)).toEqual([7, 8]);

    await mounted.rerender(6);
    expect(mounted.current().visibleOptions.map(option => option.index)).toEqual([4, 5, 6, 7, 8, 9]);
  } finally {
    mounted.unmount();
  }
});

test('page down uses the resized visible option count', async () => {
  const mounted = await mountNavigation(5, 0);
  try {
    await mounted.rerender(2);
    mounted.current().focusNextPage();
    await settle();

    expect(mounted.current().focusedValue).toBe(2);
    expect(mounted.current().visibleOptions.map(option => option.index)).toEqual([1, 2]);
  } finally {
    mounted.unmount();
  }
});
