import { type FSWatcher, watch } from 'fs'
import { useEffect, useSyncExternalStore } from 'react'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { createSignal } from '../utils/process/signal.js'
import type { Task } from '../utils/task/tasks.js'
import {
  filterTasksForAgent,
  getTaskListId,
  getTasksDir,
  isAgentScopedTask,
  isTodoV2Enabled,
  listTasks,
  onTasksUpdated,
  resetTaskList,
} from '../utils/task/tasks.js'
import { isTeamLead } from '../utils/agents/teammate.js'

const HIDE_DELAY_MS = 5000
const DEBOUNCE_MS = 50
const FALLBACK_POLL_MS = 5000 // Fallback in case fs.watch misses events

type TasksV2StoreDependencies = {
  watch: (path: string, listener: () => void) => FSWatcher
  getTaskListId: () => string
  getTasksDir: (taskListId: string) => string
  listTasks: (taskListId: string) => Promise<Task[]>
  onTasksUpdated: (listener: () => void) => () => void
  resetTaskList: (taskListId: string) => Promise<void>
  setTimeout: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
}

const TASKS_V2_STORE_DEPENDENCIES: TasksV2StoreDependencies = {
  watch: (path, listener) => watch(path, listener),
  getTaskListId,
  getTasksDir,
  listTasks,
  onTasksUpdated,
  resetTaskList,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: timer => clearTimeout(timer),
}

/**
 * Singleton store for the TodoV2 task list. Owns the file watcher, timers,
 * and cached task list. Multiple hook instances (REPL, Spinner,
 * PromptInputFooterLeftSide) subscribe to one shared store instead of each
 * setting up their own fs.watch on the same directory. The Spinner mounts/
 * unmounts every turn — per-hook watchers caused constant watch/unwatch churn.
 *
 * Implements the useSyncExternalStore contract: subscribe/getSnapshot.
 */
class TasksV2Store {
  /** Stable array reference; replaced only on fetch. undefined until started. */
  #tasks: Task[] | undefined = undefined
  /**
   * Set when the hide timer has elapsed (all tasks completed for >5s), or
   * when the task list is empty. Starts false so the first fetch runs the
   * "all completed → schedule 5s hide" path (matches original behavior:
   * resuming a session with completed tasks shows them briefly).
   */
  #hidden = false
  #watcher: FSWatcher | null = null
  #watchedDir: string | null = null
  #hideTimer: ReturnType<typeof setTimeout> | null = null
  #debounceTimer: ReturnType<typeof setTimeout> | null = null
  #pollTimer: ReturnType<typeof setTimeout> | null = null
  #unsubscribeTasksUpdated: (() => void) | null = null
  #changed = createSignal()
  #subscriberCount = 0
  #started = false
  #lifecycleEpoch = 0

  constructor(
    private readonly dependencies: TasksV2StoreDependencies = TASKS_V2_STORE_DEPENDENCIES,
  ) {}

  /**
   * useSyncExternalStore snapshot. Returns the same Task[] reference between
   * updates (required for Object.is stability). Returns undefined when hidden.
   */
  getSnapshot = (): Task[] | undefined => {
    return this.#hidden ? undefined : this.#tasks
  }

  subscribe = (fn: () => void): (() => void) => {
    // Lazy init on first subscriber. useSyncExternalStore calls this
    // post-commit, so I/O here is safe (no render-phase side effects).
    // REPL.tsx keeps a subscription alive for the whole session, so
    // Spinner mount/unmount churn never drives the count to zero.
    const unsubscribe = this.#changed.subscribe(fn)
    this.#subscriberCount++
    if (!this.#started) {
      this.#started = true
      const epoch = ++this.#lifecycleEpoch
      this.#unsubscribeTasksUpdated = this.dependencies.onTasksUpdated(() =>
        this.#scheduleFetch(epoch),
      )
      // Fire-and-forget: subscribe is called post-commit (not in render),
      // and the store notifies subscribers when the fetch resolves.
      void this.#fetch(epoch)
    }
    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true
      unsubscribe()
      this.#subscriberCount--
      if (this.#subscriberCount === 0) this.#stop()
    }
  }

  #notify(): void {
    this.#changed.emit()
  }

  #isActive(epoch: number): boolean {
    return (
      this.#started &&
      this.#subscriberCount > 0 &&
      this.#lifecycleEpoch === epoch
    )
  }

  /**
   * Point the file watcher at the current tasks directory. Called on start
   * and whenever #fetch detects the task list ID has changed (e.g. when
   * TeamCreateTool sets leaderTeamName mid-session).
   */
  #rewatch(dir: string, epoch: number): void {
    if (!this.#isActive(epoch)) return
    // Retry even on same dir if the previous watch attempt failed (dir
    // didn't exist yet). Once the watcher is established, same-dir is a no-op.
    if (dir === this.#watchedDir && this.#watcher !== null) return
    this.#watcher?.close()
    this.#watcher = null
    this.#watchedDir = dir
    try {
      this.#watcher = this.dependencies.watch(dir, () =>
        this.#scheduleFetch(epoch),
      )
      this.#watcher.unref()
    } catch {
      // Directory may not exist yet (ensureTasksDir is called by writers).
      // Not critical — onTasksUpdated covers in-process updates and the
      // poll timer covers cross-process updates.
    }
  }

  #scheduleFetch(epoch: number): void {
    if (!this.#isActive(epoch)) return
    if (this.#debounceTimer) {
      this.dependencies.clearTimeout(this.#debounceTimer)
    }
    this.#debounceTimer = this.dependencies.setTimeout(() => {
      this.#debounceTimer = null
      if (!this.#isActive(epoch)) return
      void this.#fetch(epoch)
    }, DEBOUNCE_MS)
    this.#debounceTimer.unref()
  }

  #fetch = async (epoch: number): Promise<void> => {
    if (!this.#isActive(epoch)) return

    const taskListId = this.dependencies.getTaskListId()
    // Task list ID can change mid-session (TeamCreateTool sets
    // leaderTeamName) — point the watcher at the current dir.
    this.#rewatch(this.dependencies.getTasksDir(taskListId), epoch)
    if (!this.#isActive(epoch)) return

    // This store backs the *main session's* task UI (REPL, Spinner, footer),
    // so it only ever shows untagged tasks: a subagent's private breakdown
    // must not appear in the user's todo list. Team lists are never tagged,
    // so teammate coordination is unaffected.
    const current = filterTasksForAgent(
      await this.dependencies.listTasks(taskListId),
      undefined,
    ).filter(t => !t.metadata?._internal)
    if (!this.#isActive(epoch)) return
    this.#tasks = current

    const hasIncomplete = current.some(t => t.status !== 'completed')

    if (hasIncomplete || current.length === 0) {
      // Has unresolved tasks (open/in_progress) or empty — reset hide state
      this.#hidden = current.length === 0
      this.#clearHideTimer()
    } else if (this.#hideTimer === null && !this.#hidden) {
      // All tasks just became completed — schedule clear
      this.#hideTimer = this.dependencies.setTimeout(
        () => void this.#onHideTimerFired(taskListId, epoch),
        HIDE_DELAY_MS,
      )
      this.#hideTimer.unref()
    }

    this.#notify()

    // Schedule fallback poll only when there are incomplete tasks that
    // need monitoring. When all tasks are completed (or there are none),
    // the fs.watch watcher and onTasksUpdated callback are sufficient to
    // detect new activity — no need to keep polling and re-rendering.
    if (this.#pollTimer) {
      this.dependencies.clearTimeout(this.#pollTimer)
      this.#pollTimer = null
    }
    if (hasIncomplete && this.#isActive(epoch)) {
      this.#pollTimer = this.dependencies.setTimeout(
        () => this.#scheduleFetch(epoch),
        FALLBACK_POLL_MS,
      )
      this.#pollTimer.unref()
    }
  }

  async #onHideTimerFired(
    scheduledForTaskListId: string,
    epoch: number,
  ): Promise<void> {
    if (!this.#isActive(epoch)) return
    this.#hideTimer = null
    // Bail if the task list ID changed since scheduling (team created/deleted
    // during the 5s window) — don't reset the wrong list.
    const currentId = this.dependencies.getTaskListId()
    if (currentId !== scheduledForTaskListId) return
    // Verify all tasks are still completed before clearing.
    //
    // Two things this recheck must NOT do with subagent-tagged tasks:
    //   a) count them — a subagent's in-progress task would make
    //      allStillCompleted permanently false, so the user's finished todo
    //      panel would never disappear;
    //   b) survive them — resetTaskList() unlinks every *.json in the
    //      directory, including the ones a live subagent is still writing.
    // So: judge on the visible (untagged) tasks only, and skip the destructive
    // reset entirely while any tagged task exists. Hiding the panel is the
    // user-visible half and still happens; the disk cleanup just waits for the
    // subagents to go away. This is the conservative branch on purpose —
    // selectively unlinking files out from under a running agent is worse than
    // leaving a few completed rows on disk.
    const allTasks = await this.dependencies.listTasks(currentId)
    if (!this.#isActive(epoch)) return
    const tasksToCheck = filterTasksForAgent(allTasks, undefined)
    const allStillCompleted =
      tasksToCheck.length > 0 &&
      tasksToCheck.every(t => t.status === 'completed')
    if (allStillCompleted) {
      if (!allTasks.some(isAgentScopedTask)) {
        await this.dependencies.resetTaskList(currentId)
        if (!this.#isActive(epoch)) return
      }
      this.#tasks = []
      this.#hidden = true
    }
    if (this.#isActive(epoch)) this.#notify()
  }

  #clearHideTimer(): void {
    if (this.#hideTimer) {
      this.dependencies.clearTimeout(this.#hideTimer)
      this.#hideTimer = null
    }
  }

  /**
   * Tear down the watcher, timers, and in-process subscription. Called when
   * the last subscriber unsubscribes. Preserves #tasks/#hidden cache so a
   * subsequent re-subscribe renders the last known state immediately.
   */
  #stop(): void {
    this.#started = false
    this.#lifecycleEpoch++
    this.#watcher?.close()
    this.#watcher = null
    this.#watchedDir = null
    this.#unsubscribeTasksUpdated?.()
    this.#unsubscribeTasksUpdated = null
    this.#clearHideTimer()
    if (this.#debounceTimer) {
      this.dependencies.clearTimeout(this.#debounceTimer)
    }
    if (this.#pollTimer) this.dependencies.clearTimeout(this.#pollTimer)
    this.#debounceTimer = null
    this.#pollTimer = null
  }
}

let _store: TasksV2Store | null = null
function getStore(): TasksV2Store {
  return (_store ??= new TasksV2Store())
}

// Stable no-ops for the disabled path so useSyncExternalStore doesn't
// churn its subscription on every render.
const NOOP = (): void => {}
const NOOP_SUBSCRIBE = (): (() => void) => NOOP
const NOOP_SNAPSHOT = (): undefined => undefined

/**
 * Hook to get the current task list for the persistent UI display.
 * Returns tasks when TodoV2 is enabled, otherwise returns undefined.
 * All hook instances share a single file watcher via TasksV2Store.
 * Hides the list after 5 seconds if there are no open tasks.
 */
export function useTasksV2(): Task[] | undefined {
  const teamContext = useAppState(s => s.teamContext)

  const enabled = isTodoV2Enabled() && (!teamContext || isTeamLead(teamContext))

  const store = enabled ? getStore() : null

  return useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.getSnapshot : NOOP_SNAPSHOT,
  )
}

/**
 * Same as useTasksV2, plus collapses the expanded task view when the list
 * becomes hidden. Call this from exactly one always-mounted component (REPL)
 * so the collapse effect runs once instead of N× per consumer.
 */
export function useTasksV2WithCollapseEffect(): Task[] | undefined {
  const tasks = useTasksV2()
  const setAppState = useSetAppState()

  const hidden = tasks === undefined
  useEffect(() => {
    if (!hidden) return
    setAppState(prev => {
      if (prev.expandedView !== 'tasks') return prev
      return { ...prev, expandedView: 'none' as const }
    })
  }, [hidden, setAppState])

  return tasks
}

export const _test = {
  createStore(
    dependencies: Partial<TasksV2StoreDependencies> = {},
  ): TasksV2Store {
    return new TasksV2Store({
      ...TASKS_V2_STORE_DEPENDENCIES,
      ...dependencies,
    })
  },
}
