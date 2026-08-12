import { feature } from 'bun:bundle'
import type { Task, TaskType } from './Task.js'
import { DreamTask } from './tasks/DreamTask/DreamTask.js'
import { InProcessTeammateTask } from './tasks/InProcessTeammateTask/task.js'
import { LocalAgentTask } from './tasks/LocalAgentTask/LocalAgentTask.js'
import { LocalShellTask } from './tasks/LocalShellTask/LocalShellTask.js'
// Not feature-gated (it used to sit behind MONITOR_TOOL): auto-backgrounded MCP tool
// calls register as monitor_mcp tasks in every build, and stopTask() resolves the killer
// through getTaskByType — an absent entry means TaskStop cannot stop them, while the
// message handed to the model tells it to do exactly that.
import { MonitorMcpTask } from './tasks/MonitorMcpTask/MonitorMcpTask.js'
import { RemoteAgentTask } from './tasks/RemoteAgentTask/RemoteAgentTask.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const LocalWorkflowTask: Task | null = feature('WORKFLOW_SCRIPTS')
  ? require('./tasks/LocalWorkflowTask/LocalWorkflowTask.js').LocalWorkflowTask
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Get all tasks.
 * Mirrors the pattern from tools.ts
 * Note: Returns array inline to avoid circular dependency issues with top-level const
 */
export function getAllTasks(): Task[] {
  const tasks: Task[] = [
    LocalShellTask,
    LocalAgentTask,
    RemoteAgentTask,
    InProcessTeammateTask,
    DreamTask,
    MonitorMcpTask,
  ]
  if (LocalWorkflowTask) tasks.push(LocalWorkflowTask)
  return tasks
}

/**
 * Get a task by its type.
 */
export function getTaskByType(type: TaskType): Task | undefined {
  return getAllTasks().find(t => t.type === type)
}
