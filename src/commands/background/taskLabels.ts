/**
 * Labels for the "these tasks will be stopped" list in the `/background`
 * confirmation.
 *
 * Split out from the command so it can be tested without loading the engine
 * selector, session storage and bootstrap state that `call()` needs — and so
 * the import is type-only, keeping this file off the runtime dependency graph.
 * Mirrors `toListItem()` in BackgroundTasksDialog, which is not exported.
 */

import type { TaskState } from '../../tasks/types.js'

export type BackgroundTaskSummary = {
  id: string
  type: string
  label: string
}

export function describeTask(task: TaskState): string {
  switch (task.type) {
    case 'local_bash':
      return task.kind === 'monitor' ? task.description : task.command
    case 'remote_agent':
      return task.title
    case 'local_agent':
      return `${task.agentType}: ${task.prompt.slice(0, 60)}`
    case 'in_process_teammate':
      return `@${task.identity.agentName}`
    case 'local_workflow':
      return task.summary ?? task.description
    case 'monitor_mcp':
      return task.description
    case 'dream':
      return task.description
  }
}
