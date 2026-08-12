// Background task entry for long-running MCP work.
//
// Two kinds share this task type, because they are the same thing from the registry's
// point of view — an MCP interaction that outlives the turn that started it:
//
//   - 'resource': a subscription to an MCP server resource, so the otherwise-invisible
//     stream is visible in the footer pill and Shift+Down dialog.
//   - 'tool': a tool call that blocked past the auto-background threshold and was handed
//     off (see src/services/mcp/autoBackground.ts).
//
// The 'resource' kind follows the DreamTask pattern: pure UI surfacing. The 'tool' kind
// additionally owns a completion notification, because the model is waiting on a result
// it never received inline.

import type { AppState } from '../../state/AppState.js'
import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import type { AgentId } from '../../types/ids.js'
import { escapeXml } from '../../utils/text/xml.js'
import { logForDebugging } from '../../utils/telemetry/debug.js'
import {
  appendTaskOutput,
  flushTaskOutput,
  getTaskOutputPath,
} from '../../utils/task/diskOutput.js'
import { enqueuePendingNotification } from '../../utils/session/messageQueueManager.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'

export type MonitorMcpTaskState = TaskStateBase & {
  type: 'monitor_mcp'
  /**
   * Which flavour of MCP work this is. Optional for backward compatibility with tasks
   * restored from a transcript written before the type carried two kinds; absent means
   * 'resource', which is what the field originally described.
   */
  mcpKind?: 'resource' | 'tool'
  /** The MCP server name being monitored, or whose tool is running. */
  serverName: string
  /** The resource URI being subscribed to. Absent for the 'tool' kind. */
  resourceUri?: string
  /** The MCP tool being called. Absent for the 'resource' kind. */
  toolName?: string
  /** The shell command used to drive monitoring (if any). */
  command?: string
  /** Agent that spawned this task. Used to kill orphaned tasks on agent exit. */
  agentId?: AgentId
  /** Abort controller to cancel the subscription. */
  abortController?: AbortController
}

export function isMonitorMcpTask(task: unknown): task is MonitorMcpTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'monitor_mcp'
  )
}

export function registerMonitorMcpTask(
  setAppState: SetAppState,
  opts: {
    description: string
    serverName: string
    resourceUri: string
    command?: string
    toolUseId?: string
    agentId?: AgentId
    abortController?: AbortController
  },
): string {
  const id = generateTaskId('monitor_mcp')
  const task: MonitorMcpTaskState = {
    ...createTaskStateBase(id, 'monitor_mcp', opts.description, opts.toolUseId),
    type: 'monitor_mcp',
    mcpKind: 'resource',
    status: 'running',
    serverName: opts.serverName,
    resourceUri: opts.resourceUri,
    command: opts.command,
    agentId: opts.agentId,
    abortController: opts.abortController,
  }
  registerTask(task, setAppState)
  return id
}

/**
 * Register a slow MCP tool call that has been handed off to the background.
 *
 * The abort controller here is the call's own *detached* one — killing the task must
 * cancel the in-flight request, which is the whole reason `killMonitorMcp` aborts it.
 */
export function registerMcpBackgroundTask(
  setAppState: SetAppState,
  opts: {
    description: string
    serverName: string
    toolName: string
    toolUseId?: string
    agentId?: AgentId
    abortController?: AbortController
  },
): string {
  const id = generateTaskId('monitor_mcp')
  const task: MonitorMcpTaskState = {
    ...createTaskStateBase(id, 'monitor_mcp', opts.description, opts.toolUseId),
    type: 'monitor_mcp',
    mcpKind: 'tool',
    status: 'running',
    serverName: opts.serverName,
    toolName: opts.toolName,
    agentId: opts.agentId,
    abortController: opts.abortController,
  }
  registerTask(task, setAppState)
  return id
}

/**
 * Terminal transition for a backgrounded MCP tool call: park the result on disk, mark
 * the task, and tell the model.
 *
 * The `notified` latch is checked and set inside the same `updateTaskState` callback so
 * a completion racing with a `TaskStop` (or with itself, if the promise settles twice
 * through some adapter) cannot enqueue two notifications for one task. Everything after
 * the latch is skipped when we lost that race.
 */
export function settleMcpBackgroundTask(
  taskId: string,
  setAppState: SetAppState,
  {
    status,
    serverName,
    toolName,
    agentId,
    toolUseId,
    resultText,
  }: {
    status: 'completed' | 'failed'
    serverName: string
    toolName: string
    agentId?: AgentId
    toolUseId?: string
    resultText: string
  },
): void {
  let shouldNotify = false
  updateTaskState<MonitorMcpTaskState>(taskId, setAppState, task => {
    if (task.notified) return task
    shouldNotify = true
    return {
      ...task,
      status,
      endTime: Date.now(),
      notified: true,
      abortController: undefined,
    }
  })
  if (!shouldNotify) return

  // Full output goes to the task's file so TaskOutput can fetch it; the notification
  // itself stays small, because it is injected into the model's context unconditionally.
  const outputPath = getTaskOutputPath(taskId)
  try {
    appendTaskOutput(taskId, resultText)
    void flushTaskOutput(taskId)
  } catch (error) {
    logForDebugging(
      `settleMcpBackgroundTask: could not persist result for ${taskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  const verb = status === 'completed' ? 'completed' : 'failed'
  const summary = `MCP tool ${serverName} · ${toolName} ${verb}. ${summarizeResult(resultText)}`
  const toolUseIdLine = toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`

  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    // 'next' rather than 'later': the model asked for this result and is proceeding
    // without it, so it should arrive between tool calls rather than at end of turn.
    priority: 'next',
    agentId,
  })
}

/**
 * Inline slice of the result carried in the notification.
 *
 * Kept small on purpose — the notification is unconditionally injected into context,
 * while the full text is one TaskOutput call away at the path the notification names.
 */
const NOTIFICATION_RESULT_MAX_CHARS = 2_000

function summarizeResult(resultText: string): string {
  const trimmed = resultText.trim()
  if (!trimmed) return 'The result was empty.'
  if (trimmed.length <= NOTIFICATION_RESULT_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, NOTIFICATION_RESULT_MAX_CHARS)}… [truncated; read the full result from the output file above]`
}

export function completeMonitorMcpTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  updateTaskState<MonitorMcpTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'completed',
    endTime: Date.now(),
    notified: true,
    abortController: undefined,
  }))
}

export function failMonitorMcpTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  updateTaskState<MonitorMcpTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'failed',
    endTime: Date.now(),
    notified: true,
    abortController: undefined,
  }))
}

export function killMonitorMcp(taskId: string, setAppState: SetAppState): void {
  updateTaskState<MonitorMcpTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    task.abortController?.abort()
    return {
      ...task,
      status: 'killed',
      endTime: Date.now(),
      notified: true,
      abortController: undefined,
    }
  })
}

/**
 * Kill all running monitor_mcp tasks spawned by a given agent.
 * Called from runAgent.ts finally block so subscriptions don't outlive
 * the agent that started them.
 */
export function killMonitorMcpTasksForAgent(
  agentId: AgentId,
  getAppState: () => AppState,
  setAppState: SetAppState,
): void {
  const tasks = getAppState().tasks ?? {}
  for (const [taskId, task] of Object.entries(tasks)) {
    if (
      isMonitorMcpTask(task) &&
      task.agentId === agentId &&
      task.status === 'running'
    ) {
      logForDebugging(
        `killMonitorMcpTasksForAgent: killing orphaned monitor task ${taskId} (agent ${agentId} exiting)`,
      )
      killMonitorMcp(taskId, setAppState)
    }
  }
}

export const MonitorMcpTask: Task = {
  name: 'MonitorMcpTask',
  type: 'monitor_mcp',

  async kill(taskId, setAppState) {
    killMonitorMcp(taskId, setAppState)
  },
}
