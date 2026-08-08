// Shared logic for stopping a running task.
// Used by TaskStopTool (LLM-invoked) and SDK stop_task control request.

import type { AppState } from '../state/AppState.js'
import type { TaskStateBase } from '../Task.js'
import { getTaskByType } from '../tasks.js'
import { emitTaskTerminatedSdk } from '../utils/session/sdkEventQueue.js'
import { isLocalShellTask } from './LocalShellTask/guards.js'

export class StopTaskError extends Error {
  constructor(
    message: string,
    public readonly code: 'not_found' | 'not_running' | 'unsupported_type',
  ) {
    super(message)
    this.name = 'StopTaskError'
  }
}

type StopTaskContext = {
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
}

type StopTaskResult = {
  taskId: string
  taskType: string
  command: string | undefined
}

type StopTaskTarget = { taskId: string; task: TaskStateBase }

type UltraplanTaskState = TaskStateBase & {
  type: 'remote_agent'
  sessionId: string
  isUltraplan: true
}

function isUltraplanTask(task: TaskStateBase): task is UltraplanTaskState {
  const candidate = task as TaskStateBase & {
    sessionId?: unknown
    isUltraplan?: unknown
  }
  return (
    task.type === 'remote_agent' &&
    candidate.isUltraplan === true &&
    typeof candidate.sessionId === 'string'
  )
}

/**
 * Resolve a control id to the canonical running task. Workflow resumes keep a
 * durable runId while minting wrapper task IDs, and a terminal old wrapper may
 * still occupy the runId key during its grace period. Prefer the running wrapper
 * for that run regardless of whether control arrived through runId or any older
 * wrapper ID.
 */
export function resolveTaskControlTarget(
  controlId: string,
  appState: AppState,
): StopTaskTarget | undefined {
  const direct = appState.tasks?.[controlId] as
    | (TaskStateBase & { runId?: string })
    | undefined
  if (!direct) {
    const active = Object.entries(appState.tasks ?? {}).find(
      ([, candidate]) =>
        candidate.type === 'local_workflow' &&
        (candidate.runId ?? candidate.id) === controlId &&
        candidate.status === 'running',
    )
    return active ? { taskId: active[0], task: active[1] } : undefined
  }
  if (direct.type !== 'local_workflow') {
    return { taskId: controlId, task: direct }
  }

  const runId = direct.runId ?? direct.id
  const active = Object.entries(appState.tasks ?? {}).find(
    ([, candidate]) =>
      candidate.type === 'local_workflow' &&
      (candidate.runId ?? candidate.id) === runId &&
      candidate.status === 'running',
  )
  if (active) return { taskId: active[0], task: active[1] }
  return { taskId: controlId, task: direct }
}

/**
 * Look up a task by ID, validate it is running, kill it, and mark it as notified.
 *
 * Throws {@link StopTaskError} when the task cannot be stopped (not found,
 * not running, or unsupported type). Callers can inspect `error.code` to
 * distinguish the failure reason.
 */
export async function stopTask(
  taskId: string,
  context: StopTaskContext,
): Promise<StopTaskResult> {
  const { getAppState, setAppState } = context
  const appState = getAppState()
  const target = resolveTaskControlTarget(taskId, appState)
  if (!target) {
    throw new StopTaskError(`No task found with ID: ${taskId}`, 'not_found')
  }
  const canonicalTaskId = target.taskId
  const task = target.task

  if (task.status !== 'running') {
    throw new StopTaskError(
      `Task ${taskId} is not running (status: ${task.status})`,
      'not_running',
    )
  }

  const taskImpl = getTaskByType(task.type)
  if (!taskImpl) {
    throw new StopTaskError(
      `Unsupported task type: ${task.type}`,
      'unsupported_type',
    )
  }

  if (isUltraplanTask(task)) {
    // Keep the command-only cleanup path out of normal task-stop startup. Besides
    // killing the remote task, it clears the active URL/choice/launch state and
    // emits the ultraplan-specific stop notifications.
    const { stopUltraplan } = await import('../commands/ultraplan.js')
    await stopUltraplan(canonicalTaskId, task.sessionId, setAppState)
  } else {
    await taskImpl.kill(canonicalTaskId, setAppState)
  }

  // Bash: suppress the "exit code 137" notification (noise). Agent tasks: don't
  // suppress — the AbortError catch sends a notification carrying
  // extractPartialResult(agentMessages), which is the payload not noise.
  if (isLocalShellTask(task)) {
    let suppressed = false
    setAppState(prev => {
      const prevTask = prev.tasks[canonicalTaskId]
      if (!prevTask || prevTask.notified) {
        return prev
      }
      suppressed = true
      return {
        ...prev,
        tasks: {
          ...prev.tasks,
          [canonicalTaskId]: { ...prevTask, notified: true },
        },
      }
    })
    // Suppressing the XML notification also suppresses print.ts's parsed
    // task_notification SDK event — emit it directly so SDK consumers see
    // the task close.
    if (suppressed) {
      emitTaskTerminatedSdk(canonicalTaskId, 'stopped', {
        toolUseId: task.toolUseId,
        summary: task.description,
      })
    }
  }

  const command = isLocalShellTask(task) ? task.command : task.description

  return { taskId: canonicalTaskId, taskType: task.type, command }
}
