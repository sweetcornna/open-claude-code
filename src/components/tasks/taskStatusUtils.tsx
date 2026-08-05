/**
 * Shared utilities for displaying task status across different task types.
 */

import figures from 'figures';
import type { TaskStatus } from 'src/Task.js';
import type { InProcessTeammateTaskState } from 'src/tasks/InProcessTeammateTask/types.js';
import { isPanelAgentTask } from 'src/tasks/LocalAgentTask/LocalAgentTask.js';
import { isBackgroundTask, type TaskState } from 'src/tasks/types.js';
import type { DeepImmutable } from 'src/types/utils.js';
import { summarizeRecentActivities } from 'src/utils/session/collapseReadSearch.js';

/**
 * Returns true if the given task status represents a terminal (finished) state.
 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed';
}

/**
 * Returns the appropriate icon for a task based on status and state flags.
 */
export function getTaskStatusIcon(
  status: TaskStatus,
  options?: {
    isIdle?: boolean;
    awaitingApproval?: boolean;
    hasError?: boolean;
    shutdownRequested?: boolean;
  },
): string {
  const { isIdle, awaitingApproval, hasError, shutdownRequested } = options ?? {};

  if (hasError) return figures.cross;
  if (awaitingApproval) return figures.questionMarkPrefix;
  if (shutdownRequested) return figures.warning;

  if (status === 'running') {
    if (isIdle) return figures.ellipsis;
    return figures.play;
  }
  if (status === 'completed') return figures.tick;
  if (status === 'failed' || status === 'killed') return figures.cross;
  return figures.bullet;
}

/**
 * Returns the appropriate semantic color for a task based on status and state flags.
 */
export function getTaskStatusColor(
  status: TaskStatus,
  options?: {
    isIdle?: boolean;
    awaitingApproval?: boolean;
    hasError?: boolean;
    shutdownRequested?: boolean;
  },
): 'success' | 'error' | 'warning' | 'background' {
  const { isIdle, awaitingApproval, hasError, shutdownRequested } = options ?? {};

  if (hasError) return 'error';
  if (awaitingApproval) return 'warning';
  if (shutdownRequested) return 'warning';
  if (isIdle) return 'background';

  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'killed') return 'warning';
  return 'background';
}

/**
 * Semantic color for the status dot in the background-agent selector.
 *
 * Deliberately NOT `getTaskStatusColor`: that one maps "running" to the
 * `background` token, which is cyan in every shipped theme — it reads as an
 * accent, not as a neutral. The selector's dot encodes *status only* (the
 * selection affordance is the pointer + bold), so running must be a quiet
 * gray and the terminal states must be the usual green/red/amber.
 */
export function getAgentStatusDotColor(status: TaskStatus): 'inactive' | 'success' | 'error' | 'warning' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'killed':
      return 'warning';
    default:
      // running / pending — in flight, stay neutral
      return 'inactive';
  }
}

/**
 * What a local agent is doing *right now*, falling back to what it was asked
 * to do. Shared by every surface that renders a local_agent row
 * (BackgroundAgentSelector, BackgroundTask pill, BackgroundTasksDialog).
 *
 * `progress.summary` is the periodic AI summary (only populated when agent
 * summarization is enabled — off in the plain TUI). `lastActivity` is refreshed
 * on every assistant message by updateProgressFromMessage, so it is the live
 * signal in normal sessions. `description` is the spawn-time string.
 *
 * Once the agent reaches a terminal state the live activity is deliberately
 * dropped: a finished row reading "Reading src/foo.ts" is a snapshot of the
 * last thing it did and reads like it is still running. The task it was given
 * is the useful label for a finished agent.
 */
export function getAgentRowDescription(task: {
  status: TaskStatus;
  description: string;
  progress?: { summary?: string; lastActivity?: { activityDescription?: string } };
}): string {
  if (isTerminalStatus(task.status)) return task.description;
  return task.progress?.summary ?? task.progress?.lastActivity?.activityDescription ?? task.description;
}

/**
 * Derives a human-readable activity string for an in-process teammate,
 * accounting for shutdown/approval/idle states and falling back through
 * recent-activity summary → last activity description → 'working'.
 */
export function describeTeammateActivity(t: DeepImmutable<InProcessTeammateTaskState>): string {
  if (t.shutdownRequested) return 'stopping';
  if (t.awaitingPlanApproval) return 'awaiting approval';
  if (t.isIdle) return 'idle';
  return (
    (t.progress?.recentActivities && summarizeRecentActivities(t.progress.recentActivities)) ??
    t.progress?.lastActivity?.activityDescription ??
    'working'
  );
}

/**
 * Returns true when BackgroundTaskStatus would render nothing because the
 * spinner tree is active and every visible background task is an in-process
 * teammate (teammates are shown in the spinner tree instead).
 *
 * Uses the same task filtering as BackgroundTaskStatus: `isBackgroundTask()`
 * plus exclusion of panel-managed agent tasks for ants (those are shown
 * by CoordinatorTaskPanel).
 */
export function shouldHideTasksFooter(tasks: { [taskId: string]: TaskState }, showSpinnerTree: boolean): boolean {
  if (!showSpinnerTree) return false;
  let hasVisibleTask = false;
  for (const t of Object.values(tasks) as TaskState[]) {
    if (!isBackgroundTask(t) || (process.env.USER_TYPE === 'ant' && isPanelAgentTask(t))) {
      continue;
    }
    hasVisibleTask = true;
    if (t.type !== 'in_process_teammate') return false;
  }
  return hasVisibleTask;
}
