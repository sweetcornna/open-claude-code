/**
 * Bridge for workflow status-change notifications.
 *
 * The engine emits events via progressEmitter.emit({ type: 'run_done', ... }),
 * and the progress/store reducer records the status into RunProgress. But the
 * old implementation had no code bridging status transitions to the host
 * notification mechanism — the "notifies automatically on completion" promise
 * in WorkflowTool's return text went unfulfilled.
 *
 * This module subscribes to WorkflowService.subscribe, watches status transitions
 * from running → completed/failed/killed, and emits a host notification via the
 * injected notifier callback (defaults to enqueuePendingNotification task-notification mode).
 */
import {
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
} from '../constants/xml.js'
import { join } from 'node:path'
import { enqueuePendingNotification } from '../utils/session/messageQueueManager.js'
import { getRunsDir } from './persistence.js'
import type { RunProgress } from './progress/store.js'
import type { WorkflowService } from './service.js'

const WORKFLOW_TASK_TYPE = 'local_workflow'

/** Notifier abstraction (lets tests inject a spy). */
export type WorkflowNotifier = (message: string) => void

const TERMINAL_STATUSES: ReadonlySet<RunProgress['status']> = new Set([
  'completed',
  'failed',
  'killed',
])

/**
 * Default notifier: uses the host message queue's task-notification mode.
 *
 * Priority 'next' so the mid-turn drain in query.ts picks it up at the next
 * tool-round boundary instead of leaving it for the end-of-turn queue
 * processor. Same rationale as LocalShellTask / LocalAgentTask.
 */
const defaultNotifier: WorkflowNotifier = message => {
  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    priority: 'next',
  })
}

export function installWorkflowNotifications(
  service: WorkflowService,
  notify: WorkflowNotifier = defaultNotifier,
): () => void {
  const prevStatus = new Map<string, RunProgress['status'] | undefined>()

  const unsubscribe = service.subscribe(() => {
    const runs = service.listRuns()
    const liveRunIds = new Set(runs.map(run => run.runId))
    for (const runId of prevStatus.keys()) {
      if (!liveRunIds.has(runId)) prevStatus.delete(runId)
    }
    for (const run of runs) {
      const prev = prevStatus.get(run.runId)
      // First time seeing this run: just record the current status without notifying
      // (avoids treating existing historical runs as new notifications on install)
      if (prev === undefined) {
        prevStatus.set(run.runId, run.status)
        continue
      }
      // Status changed + entered terminal state → emit notification
      if (prev !== run.status && TERMINAL_STATUSES.has(run.status)) {
        notify(buildMessage(run))
      }
      prevStatus.set(run.runId, run.status)
    }
  })

  return () => {
    unsubscribe()
    prevStatus.clear()
  }
}

function buildMessage(run: RunProgress): string {
  const statusText =
    run.status === 'completed'
      ? 'completed successfully'
      : run.status === 'failed'
        ? 'failed'
        : 'was stopped'
  const errorSuffix =
    run.status === 'failed' && run.error ? `: ${run.error}` : ''
  // Name the run directory here too. This notification is often the only thing
  // still in context by the time the run's result is questioned, and the
  // journal is the difference between diagnosing an empty result and guessing.
  const runDir = join(getRunsDir(), run.runId)
  const summary = `Workflow "${run.workflowName}" ${statusText}${errorSuffix}. Run directory: ${runDir} (journal.jsonl records each agent() call's actual return value; state.json holds terminal per-agent status).`

  return `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${run.runId}</${TASK_ID_TAG}>
<${TASK_TYPE_TAG}>${WORKFLOW_TASK_TYPE}</${TASK_TYPE_TAG}>
<${STATUS_TAG}>${run.status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${summary}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`
}
