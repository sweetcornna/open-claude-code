/**
 * The headless turn loop: `runHeadlessTurn` plus the proactive tick that
 * re-enters it.
 *
 * One turn is: reconcile SDK MCP, resolve a deferred plugin install, then
 * drain the command queue in a do/while that also waits on background agents,
 * release the run mutex, and decide what happens next — a proactive tick, a
 * re-entry because something queued while the mutex was held, a teammate
 * message, a team shutdown, or closing the output stream.
 *
 * `state.running` is the mutex; a re-entrant call returns immediately, which
 * is why every "start a turn" site is `void runHeadlessTurn(state)` rather
 * than an await.
 */
import { feature } from 'bun:bundle'
import { randomUUID } from 'crypto'
import { cwd } from 'process'
import { EMPTY_USAGE } from '@ant/model-provider'
import { getSessionId } from 'src/bootstrap/state.js'
import { TICK_TAG } from 'src/constants/xml.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import { errorMessage } from 'src/utils/errors.js'
import { getInMemoryErrors, logError } from 'src/utils/telemetry/log.js'
import { enqueue, peek } from 'src/utils/session/messageQueueManager.js'
import {
  gracefulShutdownSync,
  isShuttingDown,
} from 'src/utils/process/gracefulShutdown.js'
import { notifySessionStateChanged } from 'src/utils/session/sessionState.js'
import { drainSdkEvents } from 'src/utils/session/sdkEventQueue.js'
import { headlessProfilerCheckpoint } from 'src/utils/telemetry/headlessProfiler.js'
import { getRunningTasks } from 'src/utils/task/framework.js'
import { isBackgroundTask } from 'src/tasks/types.js'
import { sleep } from 'src/utils/process/sleep.js'
import { createProactiveAutonomyCommands } from 'src/utils/agents/autonomyRuns.js'
import { cancelQueuedAutonomyCommands } from 'src/utils/agents/autonomyQueueLifecycle.js'
import { SHUTDOWN_TEAM_PROMPT, proactiveModule } from './runtime.js'
import { drainCommandQueue } from './headlessCommandDrain.js'
import { updateSdkMcp } from './headlessMcpRuntime.js'
import { resolveDeferredPluginInstall } from './headlessPlugins.js'
import {
  hasActiveSwarmNeedingShutdown,
  pollTeamLeadInbox,
} from './headlessTeammates.js'
import { finalizeHeadlessOutput } from './headlessTeardown.js'
import {
  isMainThreadCommand,
  type HeadlessRunState,
} from './headlessRunState.js'

// Proactive mode: schedule a tick to keep the model looping autonomously.
// setTimeout(0) yields to the event loop so pending stdin messages
// (interrupts, user messages) are processed before the tick fires.
export const scheduleProactiveTick =
  feature('PROACTIVE') || feature('KAIROS')
    ? (state: HeadlessRunState) => {
        setTimeout(() => {
          if (
            !proactiveModule?.isProactiveActive() ||
            proactiveModule.isProactivePaused() ||
            state.inputClosed
          ) {
            return
          }
          void (async () => {
            const commands = await createProactiveAutonomyCommands({
              basePrompt: `<${TICK_TAG}>${new Date().toLocaleTimeString()}</${TICK_TAG}>`,
              currentDir: cwd(),
              shouldCreate: () => !state.inputClosed,
            })
            if (state.inputClosed) {
              await cancelQueuedAutonomyCommands({ commands })
              return
            }
            for (const command of commands) {
              enqueue({
                ...command,
                uuid: randomUUID(),
              })
            }
            void runHeadlessTurn(state)
          })().catch(error => {
            logError(error)
            logForDebugging(
              `[Proactive] failed to create headless tick: ${error}`,
              {
                level: 'error',
              },
            )
          })
        }, 0)
      }
    : undefined

export async function runHeadlessTurn(state: HeadlessRunState): Promise<void> {
  if (state.running) {
    return
  }

  state.running = true
  state.runPhase = undefined
  notifySessionStateChanged('running')
  state.idleTimeout.stop()

  headlessProfilerCheckpoint('run_entry')
  // TODO(custom-tool-refactor): Should move to the init message, like browser

  await updateSdkMcp(state)
  headlessProfilerCheckpoint('after_updateSdkMcp')

  await resolveDeferredPluginInstall(state)

  try {
    let waitingForAgents = false

    // Use a do-while loop to drain commands and then wait for any
    // background agents that are still running. When agents complete,
    // their notifications are enqueued and the loop re-drains.
    do {
      // Drain SDK events (task_started, task_progress) before command queue
      // so progress events precede task_notification on the stream.
      for (const event of drainSdkEvents()) {
        state.output.enqueue(event)
      }

      state.runPhase = 'draining_commands'
      await drainCommandQueue(state)

      // Check for running background tasks before exiting.
      // Exclude in_process_teammate — teammates are long-lived by design
      // (status: 'running' for their whole lifetime, cleaned up by the
      // shutdown protocol, not by transitioning to 'completed'). Waiting
      // on them here loops forever (gh-30008). Same exclusion already
      // exists at useBackgroundTaskNavigation.ts:55 for the same reason;
      // L1839 above is already narrower (type === 'local_agent') so it
      // doesn't hit this.
      waitingForAgents = false
      {
        const bgTaskState = state.getAppState()
        const hasRunningBg = getRunningTasks(bgTaskState).some(
          t => isBackgroundTask(t) && t.type !== 'in_process_teammate',
        )
        const hasMainThreadQueued = peek(isMainThreadCommand) !== undefined
        if (hasRunningBg || hasMainThreadQueued) {
          waitingForAgents = true
          if (!hasMainThreadQueued) {
            state.runPhase = 'waiting_for_agents'
            // No commands ready yet, wait for tasks to complete
            await sleep(100)
          }
          // Loop back to drain any newly queued commands
        }
      }
    } while (waitingForAgents)

    if (state.heldBackResult) {
      state.output.enqueue(state.heldBackResult)
      state.heldBackResult = null
      if (state.suggestionState.pendingSuggestion) {
        state.output.enqueue(state.suggestionState.pendingSuggestion)
        // Now that the suggestion is actually delivered, record it for acceptance tracking
        if (state.suggestionState.pendingLastEmittedEntry) {
          state.suggestionState.lastEmitted = {
            ...state.suggestionState.pendingLastEmittedEntry,
            emittedAt: Date.now(),
          }
          state.suggestionState.pendingLastEmittedEntry = null
        }
        state.suggestionState.pendingSuggestion = null
      }
    }
  } catch (error) {
    // Emit error result message before shutting down
    // Write directly to structuredIO to ensure immediate delivery
    try {
      await state.structuredIO.write({
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: 0,
        duration_api_ms: 0,
        is_error: true,
        num_turns: 0,
        stop_reason: null,
        session_id: getSessionId(),
        total_cost_usd: 0,
        usage: EMPTY_USAGE,
        modelUsage: {},
        permission_denials: [],
        uuid: randomUUID(),
        errors: [errorMessage(error), ...getInMemoryErrors().map(_ => _.error)],
      })
    } catch {
      // If we can't emit the error result, continue with shutdown anyway
    }
    state.suggestionState.abortController?.abort()
    gracefulShutdownSync(1)
    return
  } finally {
    state.runPhase = 'finally_flush'
    // Flush pending internal events before going idle
    await state.structuredIO.flushInternalEvents()
    state.runPhase = 'finally_post_flush'
    if (!isShuttingDown()) {
      notifySessionStateChanged('idle')
      // Drain so the idle session_state_changed SDK event (plus any
      // terminal task_notification bookends emitted during bg-agent
      // teardown) reach the output stream before we block on the next
      // command. The do-while drain above only runs while
      // waitingForAgents; once we're here the next drain would be the
      // top of the next run(), which won't come if input is idle.
      for (const event of drainSdkEvents()) {
        state.output.enqueue(event)
      }
    }
    state.running = false
    // Start idle timer when we finish processing and are waiting for input
    state.idleTimeout.start()
  }

  // Proactive tick: if proactive is active and queue is empty, inject a tick
  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    proactiveModule?.isProactiveActive() &&
    !proactiveModule.isProactivePaused()
  ) {
    if (peek(isMainThreadCommand) === undefined && !state.inputClosed) {
      scheduleProactiveTick!(state)
      return
    }
  }

  // Re-check the queue after releasing the mutex. A message may have
  // arrived (and called run()) between the last dequeue() returning
  // undefined and `running = false` above. In that case the caller
  // saw `running === true` and returned immediately, leaving the
  // message stranded in the queue with no one to process it.
  if (peek(isMainThreadCommand) !== undefined) {
    void runHeadlessTurn(state)
    return
  }

  // Check for unread teammate messages and process them
  if ((await pollTeamLeadInbox(state)) === 'requeued') {
    void runHeadlessTurn(state)
    return // run() will come back here after processing
  }

  if (state.inputClosed) {
    // Check for active swarm that needs shutdown
    const hasActiveSwarm = await hasActiveSwarmNeedingShutdown(state)

    if (hasActiveSwarm) {
      // Team members are idle or pane-based - inject prompt to shut down team
      enqueue({
        mode: 'prompt',
        value: SHUTDOWN_TEAM_PROMPT,
        uuid: randomUUID(),
      })
      void runHeadlessTurn(state)
    } else {
      await finalizeHeadlessOutput(state)
    }
  }
}
