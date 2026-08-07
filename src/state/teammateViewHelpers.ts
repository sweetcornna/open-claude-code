import { logEvent } from '../services/analytics/index.js'
import { PANEL_GRACE_MS } from '../utils/task/framework.js'
import { isTerminalTaskStatus } from '../Task.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { AppState } from './AppState.js'

// Inline type check instead of importing isLocalAgentTask — breaks the
// teammateViewHelpers → LocalAgentTask runtime edge that creates a cycle
// through BackgroundTasksDialog.
function isLocalAgent(task: unknown): task is LocalAgentTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'local_agent'
  )
}

/**
 * Return the task released back to stub form: retain dropped, messages
 * cleared, evictAfter set if terminal. Shared by exitTeammateView and
 * the switch-away path in enterTeammateView.
 */
function release(task: LocalAgentTaskState): LocalAgentTaskState {
  return {
    ...task,
    retain: false,
    messages: undefined,
    diskLoaded: false,
    evictAfter: isTerminalTaskStatus(task.status)
      ? Date.now() + PANEL_GRACE_MS
      : undefined,
  }
}

/**
 * Transitions the UI to view a teammate's transcript.
 * Sets viewingAgentTaskId and, for local_agent, retain: true (blocks eviction,
 * enables stream-append, triggers disk bootstrap) and clears evictAfter.
 * If switching from another agent, releases the previous one back to stub.
 */
export function enterTeammateView(
  taskId: string,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  logEvent('tengu_transcript_view_enter', {})
  setAppState(prev => {
    const task = prev.tasks[taskId]
    const prevId = prev.viewingAgentTaskId
    const prevTask = prevId !== undefined ? prev.tasks[prevId] : undefined
    const switching =
      prevId !== undefined &&
      prevId !== taskId &&
      isLocalAgent(prevTask) &&
      prevTask.retain
    const needsRetain =
      isLocalAgent(task) && (!task.retain || task.evictAfter !== undefined)
    const needsView =
      prev.viewingAgentTaskId !== taskId ||
      prev.viewSelectionMode !== 'viewing-agent'
    if (!needsRetain && !needsView && !switching) return prev
    let tasks = prev.tasks
    if (switching || needsRetain) {
      tasks = { ...prev.tasks }
      if (switching) tasks[prevId] = release(prevTask)
      if (needsRetain) {
        tasks[taskId] = { ...task, retain: true, evictAfter: undefined }
      }
    }
    return {
      ...prev,
      viewingAgentTaskId: taskId,
      viewSelectionMode: 'viewing-agent',
      tasks,
    }
  })
}

/**
 * Exit teammate transcript view and return to leader's view.
 * Drops retain and clears messages back to stub form; if terminal,
 * schedules eviction via evictAfter so the row lingers briefly.
 */
export function exitTeammateView(
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  logEvent('tengu_transcript_view_exit', {})
  setAppState(prev => {
    const id = prev.viewingAgentTaskId
    const cleared = {
      ...prev,
      viewingAgentTaskId: undefined,
      viewSelectionMode: 'none' as const,
    }
    if (id === undefined) {
      return prev.viewSelectionMode === 'none' ? prev : cleared
    }
    const task = prev.tasks[id]
    if (!isLocalAgent(task) || !task.retain) return cleared
    return {
      ...cleared,
      tasks: { ...prev.tasks, [id]: release(task) },
    }
  })
}

/**
 * Context-sensitive x: running → abort, terminal → dismiss.
 * Dismiss sets evictAfter=0 so the filter hides immediately.
 * If viewing the dismissed agent, also exits to leader.
 */
export function stopOrDismissAgent(
  taskId: string,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!isLocalAgent(task)) return prev
    if (task.status === 'running') {
      // A running task is aborted and left for its loop to transition. But if
      // there is no controller, or it is already aborted, no loop is listening
      // — pressing x again would be a no-op forever. That was the second half
      // of the phantom-agent report ("won't go away"): the row was `running`
      // with an aborted controller and an exited loop. Fall through to the
      // dismiss path so the user always has a way out, even if some future
      // leak reintroduces an orphan.
      const controller = task.abortController
      if (controller && !controller.signal.aborted) {
        controller.abort()
        return prev
      }
    }
    if (task.evictAfter === 0) return prev
    const viewingThis = prev.viewingAgentTaskId === taskId
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: { ...release(task), evictAfter: 0 },
      },
      ...(viewingThis && {
        viewingAgentTaskId: undefined,
        viewSelectionMode: 'none',
      }),
    }
  })
}
