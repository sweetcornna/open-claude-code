/**
 * Cron scheduling for headless (`-p` / SDK) sessions.
 *
 * Mirrors REPL's useScheduledTasks hook. Fired prompts enqueue and start a
 * turn directly — unlike the REPL there is no queue subscriber here that
 * drains on enqueue while idle. The turn mutex makes that safe during an
 * active turn: the call no-ops and the post-turn queue re-check picks the
 * command up.
 */
import { randomUUID } from 'crypto'
import { cwd } from 'process'
import type { QueuedCommand } from 'src/types/textInputTypes.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import { logError } from 'src/utils/telemetry/log.js'
import { enqueue } from 'src/utils/messageQueueManager.js'
import { WORKLOAD_CRON } from 'src/utils/workloadContext.js'
import {
  createAutonomyQueuedPromptIfNoActiveSource,
  markAutonomyRunFailed,
} from 'src/utils/autonomyRuns.js'
import { cancelQueuedAutonomyCommands } from 'src/utils/autonomyQueueLifecycle.js'
import {
  cronGate,
  cronJitterConfigModule,
  cronSchedulerModule,
} from './runtime.js'
import { runHeadlessTurn } from './headlessTurnLoop.js'
import type { HeadlessRunState } from './headlessRunState.js'

/**
 * Start the scheduled-task runner, if cron is enabled for this build/session.
 * No-op otherwise; the caller does not need to gate.
 */
export function startHeadlessCronScheduler(state: HeadlessRunState): void {
  if (!cronGate.isKairosCronEnabled()) {
    return
  }
  // Shared dedup-claim → input-close-recheck → onSuccess pipeline for the
  // three cron entry points (legacy onFire, onFireTask agent, onFireTask
  // non-agent). Centralizing the cancel-on-late-shutdown contract here keeps
  // the three branches from drifting on what happens between claim and
  // dispatch. onSuccess receives the claimed QueuedCommand and decides
  // whether to enqueue it (normal path) or mark the run failed (agent path).
  const dispatchHeadlessCronCommand = (params: {
    basePrompt: string
    sourceId: string
    sourceLabel: string
    logSuffix: string
    onSuccess: (command: QueuedCommand) => void | Promise<void>
  }): void => {
    if (state.inputClosed) return
    void (async () => {
      const command = await createAutonomyQueuedPromptIfNoActiveSource({
        basePrompt: params.basePrompt,
        trigger: 'scheduled-task',
        currentDir: cwd(),
        sourceId: params.sourceId,
        sourceLabel: params.sourceLabel,
        workload: WORKLOAD_CRON,
        shouldCreate: () => !state.inputClosed,
      })
      if (!command) return
      if (state.inputClosed) {
        await cancelQueuedAutonomyCommands({ commands: [command] })
        return
      }
      await params.onSuccess(command)
    })().catch(error => {
      logError(error)
      logForDebugging(
        `[ScheduledTasks] failed to enqueue headless task${params.logSuffix}: ${error}`,
        { level: 'error' },
      )
    })
  }

  const enqueueAndRun = (command: QueuedCommand): void => {
    enqueue({
      ...command,
      uuid: randomUUID(),
    })
    void runHeadlessTurn(state)
  }

  state.cronScheduler = cronSchedulerModule.createCronScheduler({
    onFire: prompt => {
      // Legacy KAIROS-style entries: the prompt text is what uniquely
      // identifies the cron entry, so it doubles as both source id and
      // source label for dedup.
      dispatchHeadlessCronCommand({
        basePrompt: prompt,
        sourceId: prompt,
        sourceLabel: prompt,
        logSuffix: '',
        onSuccess: enqueueAndRun,
      })
    },
    onFireTask: task => {
      if (task.agentId) {
        dispatchHeadlessCronCommand({
          basePrompt: task.prompt,
          sourceId: task.id,
          sourceLabel: task.prompt,
          logSuffix: ` ${task.id}`,
          onSuccess: async command => {
            await markAutonomyRunFailed(
              command.autonomy!.runId,
              `No teammate runtime available for scheduled task owner ${task.agentId} in headless mode.`,
              command.autonomy!.rootDir,
            )
          },
        })
        return
      }
      dispatchHeadlessCronCommand({
        basePrompt: task.prompt,
        sourceId: task.id,
        sourceLabel: task.prompt,
        logSuffix: ` ${task.id}`,
        onSuccess: enqueueAndRun,
      })
    },
    isLoading: () => state.running || state.inputClosed,
    getJitterConfig: cronJitterConfigModule?.getCronJitterConfig,
    isKilled: () => !cronGate?.isKairosCronEnabled(),
  })
  state.cronScheduler.start()
}
