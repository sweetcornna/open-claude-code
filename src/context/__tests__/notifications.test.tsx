import { afterEach, describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import React, { useLayoutEffect } from 'react';
import { Text, wrappedRender as render } from '@anthropic/ink';
import {
  type Notification,
  type NotificationState,
  removeNotificationFromState,
  useNotifications,
} from '../notifications.js';
import { AppStoreContext, NotificationTimerContext, useAppStateStore } from '../../state/AppState.js';
import { getDefaultAppState } from '../../state/AppStateStore.js';
import { createStore } from '../../state/store.js';

const mountedInstances: Array<Awaited<ReturnType<typeof render>>> = [];

function textNotification(
  key: string,
  priority: Notification['priority'] = 'medium',
  extra: Partial<Notification> = {},
): Notification {
  return { key, text: key, priority, ...extra } as Notification;
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

type NotificationApi = ReturnType<typeof useNotifications>;
type Harness = {
  api: NotificationApi;
  getState: () => ReturnType<typeof getDefaultAppState>;
};

async function mountHarness(options?: {
  notifications?: NotificationState;
  diffPanelVisible?: boolean;
  onReady?: (harness: Harness) => void;
}): Promise<Harness> {
  let resolveHarness: (harness: Harness) => void = () => {};
  const ready = new Promise<Harness>(resolve => {
    resolveHarness = resolve;
  });

  function Probe(): React.ReactNode {
    const api = useNotifications();
    const store = useAppStateStore();
    useLayoutEffect(() => {
      const harness = { api, getState: store.getState };
      options?.onReady?.(harness);
      resolveHarness(harness);
    }, [api, store]);
    return <Text>notification probe</Text>;
  }

  const initialState = {
    ...getDefaultAppState(),
    notifications: options?.notifications ?? {
      current: null,
      queue: [],
      pinned: [],
    },
    diffPanelVisible: options?.diffPanelVisible ?? false,
  };
  const output = new PassThrough();
  output.resume();
  const input = new PassThrough();
  const store = createStore(initialState);
  const timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null> = { current: null };
  const instance = await render(
    <AppStoreContext.Provider value={store}>
      <NotificationTimerContext.Provider value={timerRef}>
        <Probe />
      </NotificationTimerContext.Provider>
    </AppStoreContext.Provider>,
    {
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: output as unknown as NodeJS.WriteStream,
      stdin: input as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  mountedInstances.push(instance);
  return Promise.race([
    ready,
    new Promise<never>((_, reject) => setTimeout(reject, 1000, new Error('notification harness did not mount'))),
  ]);
}

afterEach(() => {
  for (const instance of mountedInstances.splice(0)) {
    instance.unmount();
    instance.cleanup();
  }
});

describe('notification state machine', () => {
  test('requeues a non-immediate current notification when priority preempts it', async () => {
    const harness = await mountHarness({
      notifications: {
        current: textNotification('reading', 'low', { timeoutMs: 60_000 }),
        queue: [],
        pinned: [],
      },
    });

    harness.api.addNotification(textNotification('urgent', 'immediate', { timeoutMs: 60_000 }));

    expect(harness.getState().notifications.current?.key).toBe('urgent');
    expect(harness.getState().notifications.queue.map(notification => notification.key)).toEqual(['reading']);
  });

  test('folds and invalidates notifications in current, queue, and pinned', async () => {
    const fold = (existing: Notification): Notification => {
      const text = 'text' in existing ? existing.text : '';
      return textNotification(existing.key, existing.priority, {
        text: `${text}+folded`,
        fold,
        pinned: existing.pinned,
        timeoutMs: 60_000,
      });
    };
    const harness = await mountHarness({
      notifications: {
        current: textNotification('current', 'medium', { fold, timeoutMs: 60_000 }),
        queue: [textNotification('queued', 'low', { fold })],
        pinned: [textNotification('pinned', 'high', { fold, pinned: true })],
      },
    });

    harness.api.addNotification(textNotification('current', 'medium', { fold, timeoutMs: 60_000 }));
    harness.api.addNotification(textNotification('queued', 'low', { fold }));
    harness.api.addNotification(textNotification('pinned', 'high', { fold, pinned: true }));

    expect((harness.getState().notifications.current as { text: string }).text).toBe('current+folded');
    expect((harness.getState().notifications.queue[0] as { text: string }).text).toBe('queued+folded');
    expect((harness.getState().notifications.pinned[0] as { text: string }).text).toBe('pinned+folded');

    harness.api.addNotification(
      textNotification('replacement', 'low', {
        invalidates: ['current', 'queued', 'pinned'],
      }),
    );

    const keys = [
      harness.getState().notifications.current?.key,
      ...harness.getState().notifications.queue.map(notification => notification.key),
      ...harness.getState().notifications.pinned.map(notification => notification.key),
    ].filter(Boolean);
    expect(keys).not.toContain('current');
    expect(keys).not.toContain('queued');
    expect(keys).not.toContain('pinned');
  });

  test('holds an ordinary immediate notification during diff and restores it exactly once', async () => {
    const harness = await mountHarness({ diffPanelVisible: true });

    harness.api.addNotification(textNotification('ordinary', 'immediate', { timeoutMs: 60_000 }));
    expect(harness.getState().notifications.current).toBeNull();
    expect(harness.getState().notifications.queue).toHaveLength(1);
    expect(harness.getState().notifications.queue[0]?.heldDuringDiffPanel).toBe(true);

    harness.api.setDiffPanelVisible(false);
    expect(harness.getState().notifications.current?.key).toBe('ordinary');
    expect(harness.getState().notifications.current?.heldDuringDiffPanel).toBeUndefined();
    expect(harness.getState().notifications.queue).toHaveLength(0);

    harness.api.processQueue();
    expect(harness.getState().notifications.current?.key).toBe('ordinary');
    expect(harness.getState().notifications.queue).toHaveLength(0);
  });

  test('keeps pinned and exempt safety notifications available while diff is open', async () => {
    const harness = await mountHarness({ diffPanelVisible: true });
    harness.api.addNotification(textNotification('permission', 'immediate', { pinned: true }));
    harness.api.addNotification(
      textNotification('error', 'immediate', {
        exemptFromDiffPanelHold: true,
        timeoutMs: 60_000,
      }),
    );

    expect(harness.getState().notifications.pinned.map(notification => notification.key)).toEqual(['permission']);
    expect(harness.getState().notifications.current?.key).toBe('error');
  });

  test('multiple providers own independent timers', async () => {
    const callbacks: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((callback: () => void) => {
      callbacks.push(callback);
      return callback as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

    try {
      const first = await mountHarness();
      const second = await mountHarness();
      const callbackCountBeforeNotifications = callbacks.length;
      first.api.addNotification(textNotification('first', 'immediate'));
      second.api.addNotification(textNotification('second', 'immediate'));
      const notificationCallbacks = callbacks.slice(callbackCountBeforeNotifications);
      expect(notificationCallbacks).toHaveLength(2);

      notificationCallbacks[0]?.();
      expect(first.getState().notifications.current).toBeNull();
      expect(second.getState().notifications.current?.key).toBe('second');
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test('provider unmount clears its timer', async () => {
    const cleared: unknown[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const timer = { timer: true } as unknown as ReturnType<typeof setTimeout>;
    globalThis.setTimeout = (() => timer) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      cleared.push(id);
    }) as typeof clearTimeout;

    try {
      const harness = await mountHarness();
      harness.api.addNotification(textNotification('temporary', 'immediate'));
      mountedInstances.pop()?.unmount();
      await waitFor(() => cleared.includes(timer), 'notification timer was not cleared on unmount');
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test('remove helper removes the same key from every notification location', () => {
    const notification = textNotification('same');
    expect(
      removeNotificationFromState(
        {
          current: notification,
          queue: [notification],
          pinned: [notification],
        },
        'same',
      ),
    ).toEqual({ current: null, queue: [], pinned: [] });
  });
});
