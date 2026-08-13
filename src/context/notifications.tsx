import type * as React from 'react';
import { useCallback, useContext, useEffect, useRef } from 'react';
import { NotificationTimerContext, useAppStateStore, useSetAppState } from 'src/state/AppState.js';
import type { Theme } from '../utils/terminal/theme.js';

export type NotificationPriority = 'low' | 'medium' | 'high' | 'immediate';

type BaseNotification = {
  key: string;
  /**
   * Keys of notifications that this notification invalidates.
   * Invalidations apply to the current, queued, and pinned notifications.
   */
  invalidates?: string[];
  priority: NotificationPriority;
  timeoutMs?: number;
  /** Keep this notification visible until it is explicitly removed. */
  pinned?: boolean;
  /**
   * Preserve an immediate notification that arrived while the diff panel was
   * open. Internal state used to restore it after the panel closes.
   */
  heldDuringDiffPanel?: boolean;
  /** Allow this notification to remain visible while the diff panel is open. */
  exemptFromDiffPanelHold?: boolean;
  /** Preserve an immediate notification if another immediate one preempts it. */
  requeueOnPreempt?: boolean;
  /**
   * Combine notifications with the same key, like Array.reduce().
   * Called as fold(accumulator, incoming) wherever the matching notification
   * currently lives: current, queue, or pinned.
   */
  fold?: (accumulator: Notification, incoming: Notification) => Notification;
};

type TextNotification = BaseNotification & {
  text: string;
  color?: keyof Theme;
};

type JSXNotification = BaseNotification & {
  jsx: React.ReactNode;
};

type AddNotificationFn = (content: Notification) => void;
type RemoveNotificationFn = (key: string) => void;
type SetDiffPanelVisibleFn = (visible: boolean) => void;

export type Notification = TextNotification | JSXNotification;

export type NotificationState = {
  current: Notification | null;
  queue: Notification[];
  pinned: Notification[];
};

const DEFAULT_TIMEOUT_MS = 8000;

const PRIORITIES: Record<NotificationPriority, number> = {
  immediate: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function compareNotificationPriority(a: Notification, b: Notification): number {
  return PRIORITIES[a.priority] - PRIORITIES[b.priority];
}

export function sortPinnedNotifications(notifications: Notification[]): Notification[] {
  return notifications.slice().sort(compareNotificationPriority);
}

export function shouldDisplayNotification(notification: Notification | null, diffPanelVisible: boolean): boolean {
  return notification !== null && (!diffPanelVisible || notification.exemptFromDiffPanelHold === true);
}

export function removeNotificationFromState(state: NotificationState, key: string): NotificationState {
  const removesCurrent = state.current?.key === key;
  const removesQueued = state.queue.some(notification => notification.key === key);
  const removesPinned = state.pinned.some(notification => notification.key === key);

  if (!removesCurrent && !removesQueued && !removesPinned) return state;

  return {
    current: removesCurrent ? null : state.current,
    queue: removesQueued ? state.queue.filter(notification => notification.key !== key) : state.queue,
    pinned: removesPinned ? state.pinned.filter(notification => notification.key !== key) : state.pinned,
  };
}

function applyInvalidations(state: NotificationState, notification: Notification): NotificationState {
  if (!notification.invalidates?.length) return state;

  const invalidated = new Set(notification.invalidates);
  const current = state.current && invalidated.has(state.current.key) ? null : state.current;
  const queue = state.queue.filter(existing => !invalidated.has(existing.key));
  const pinned = state.pinned.filter(existing => !invalidated.has(existing.key));

  if (current === state.current && queue.length === state.queue.length && pinned.length === state.pinned.length) {
    return state;
  }

  return { current, queue, pinned };
}

function shouldKeepOnPreempt(existing: Notification, incoming: Notification): boolean {
  return (
    (existing.priority !== 'immediate' ||
      existing.requeueOnPreempt === true ||
      existing.heldDuringDiffPanel === true) &&
    !incoming.invalidates?.includes(existing.key)
  );
}

function withoutDiffHold(notification: Notification): Notification {
  if (notification.heldDuringDiffPanel !== true) return notification;
  const { heldDuringDiffPanel: _heldDuringDiffPanel, ...rest } = notification;
  return rest;
}

export function useNotifications(): {
  addNotification: AddNotificationFn;
  removeNotification: RemoveNotificationFn;
  processQueue: () => void;
  setDiffPanelVisible: SetDiffPanelVisibleFn;
} {
  const store = useAppStateStore();
  const setAppState = useSetAppState();
  const sharedTimerRef = useContext(NotificationTimerContext);
  const localTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerRef = sharedTimerRef ?? localTimerRef;
  const processQueueRef = useRef<() => void>(() => {});

  const clearCurrentTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [timerRef]);

  const armCurrentTimer = useCallback(
    (notification: Notification) => {
      clearCurrentTimer();
      const key = notification.key;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setAppState(prev => {
          if (prev.notifications.current?.key !== key) return prev;
          return {
            ...prev,
            notifications: {
              ...prev.notifications,
              current: null,
            },
          };
        });
        processQueueRef.current();
      }, notification.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    },
    [clearCurrentTimer, setAppState, timerRef],
  );

  const processQueue = useCallback((): void => {
    setAppState(prev => {
      const eligibleQueue = prev.diffPanelVisible
        ? prev.notifications.queue.filter(notification => notification.exemptFromDiffPanelHold === true)
        : prev.notifications.queue;
      const next = getNext(eligibleQueue);
      if (!next) return prev;

      const current = prev.notifications.current;
      const canPreemptCurrent = current !== null && next.priority === 'immediate' && current.priority !== 'immediate';
      if (current !== null && !canPreemptCurrent) return prev;

      clearCurrentTimer();
      const displayed = withoutDiffHold(next);
      armCurrentTimer(displayed);

      return {
        ...prev,
        notifications: {
          ...prev.notifications,
          current: displayed,
          queue: [
            ...(current !== null && shouldKeepOnPreempt(current, next) ? [current] : []),
            ...prev.notifications.queue.filter(notification => notification !== next),
          ],
        },
      };
    });
  }, [armCurrentTimer, clearCurrentTimer, setAppState]);
  processQueueRef.current = processQueue;

  const addNotification = useCallback<AddNotificationFn>(
    (incoming: Notification) => {
      let needsQueueProcessing = false;

      setAppState(prev => {
        const candidate: Notification =
          incoming.priority === 'immediate' && prev.diffPanelVisible && !incoming.pinned
            ? { ...incoming, heldDuringDiffPanel: true }
            : incoming;
        let notifications = applyInvalidations(prev.notifications, candidate);

        if (prev.notifications.current !== null && notifications.current === null) {
          clearCurrentTimer();
          needsQueueProcessing = true;
        }

        const currentMatches = notifications.current?.key === candidate.key;
        const queueIndex = notifications.queue.findIndex(notification => notification.key === candidate.key);
        const pinnedIndex = notifications.pinned.findIndex(notification => notification.key === candidate.key);

        if (currentMatches || queueIndex !== -1 || pinnedIndex !== -1) {
          const location = currentMatches ? 'current' : queueIndex !== -1 ? 'queue' : 'pinned';
          const existing =
            location === 'current'
              ? notifications.current!
              : location === 'queue'
                ? notifications.queue[queueIndex]!
                : notifications.pinned[pinnedIndex]!;

          if (!candidate.fold && !(candidate.pinned && location !== 'pinned')) {
            return notifications === prev.notifications ? prev : { ...prev, notifications };
          }

          const folded = candidate.fold ? candidate.fold(existing, candidate) : candidate;
          const remainsPinned = location === 'pinned' || candidate.pinned === true || folded.pinned === true;

          if (location === 'current') {
            clearCurrentTimer();
            if (remainsPinned) {
              notifications = {
                ...notifications,
                current: null,
                pinned: [...notifications.pinned, { ...folded, pinned: true }],
              };
              needsQueueProcessing = true;
            } else {
              notifications = { ...notifications, current: folded };
              armCurrentTimer(folded);
            }
          } else if (location === 'queue') {
            const queue = [...notifications.queue];
            queue.splice(queueIndex, 1);
            notifications = remainsPinned
              ? {
                  ...notifications,
                  queue,
                  pinned: [...notifications.pinned, { ...folded, pinned: true }],
                }
              : {
                  ...notifications,
                  queue: notifications.queue.map((notification, index) =>
                    index === queueIndex ? folded : notification,
                  ),
                };
            needsQueueProcessing = true;
          } else {
            notifications = {
              ...notifications,
              pinned: notifications.pinned.map((notification, index) =>
                index === pinnedIndex ? { ...folded, pinned: true } : notification,
              ),
            };
          }

          return { ...prev, notifications };
        }

        if (candidate.pinned) {
          return {
            ...prev,
            notifications: {
              ...notifications,
              pinned: [...notifications.pinned, candidate],
            },
          };
        }

        if (candidate.priority === 'immediate' && !prev.diffPanelVisible) {
          clearCurrentTimer();
          armCurrentTimer(candidate);
          return {
            ...prev,
            notifications: {
              ...notifications,
              current: candidate,
              queue: [...(notifications.current ? [notifications.current] : []), ...notifications.queue].filter(
                notification => shouldKeepOnPreempt(notification, candidate),
              ),
            },
          };
        }

        needsQueueProcessing = true;
        return {
          ...prev,
          notifications: {
            ...notifications,
            queue: [...notifications.queue, candidate],
          },
        };
      });

      if (needsQueueProcessing) processQueue();
    },
    [armCurrentTimer, clearCurrentTimer, processQueue, setAppState],
  );

  const removeNotification = useCallback<RemoveNotificationFn>(
    (key: string) => {
      let removedCurrent = false;
      setAppState(prev => {
        const notifications = removeNotificationFromState(prev.notifications, key);
        if (notifications === prev.notifications) return prev;
        removedCurrent = prev.notifications.current?.key === key;
        if (removedCurrent) clearCurrentTimer();
        return { ...prev, notifications };
      });

      if (removedCurrent) processQueue();
    },
    [clearCurrentTimer, processQueue, setAppState],
  );

  const setDiffPanelVisible = useCallback<SetDiffPanelVisibleFn>(
    visible => {
      setAppState(prev => (prev.diffPanelVisible === visible ? prev : { ...prev, diffPanelVisible: visible }));
      if (!visible) processQueue();
    },
    [processQueue, setAppState],
  );

  useEffect(() => {
    if (store.getState().notifications.queue.length > 0) processQueue();
    return clearCurrentTimer;
  }, [clearCurrentTimer, processQueue, store]);

  return { addNotification, removeNotification, processQueue, setDiffPanelVisible };
}

export function getNext(queue: Notification[]): Notification | undefined {
  if (queue.length === 0) return undefined;
  return queue.reduce((highest, notification) =>
    compareNotificationPriority(notification, highest) < 0 ? notification : highest,
  );
}
