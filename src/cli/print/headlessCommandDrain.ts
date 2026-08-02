/**
 * The headless command-drain: one pass over the main-thread command queue.
 *
 * Batches consecutive prompt commands, claims queued autonomy commands, emits
 * task_notification bookends, runs ask() under the turn's workload context,
 * and kicks off the push prompt-suggestion. Lifted out of
 * `runHeadlessStreaming`'s `run()` — it was the innermost of three nesting
 * levels and captured essentially the whole closure, which now lives on
 * `HeadlessRunState`.
 */
import { randomUUID } from 'crypto'
import { cwd } from 'process'
import uniqBy from 'lodash-es/uniqBy.js'
import { feature } from 'bun:bundle'
import { ask } from 'src/QueryEngine.js'
import { RemoteIO } from 'src/cli/remoteIO.js'
import { logEvent } from 'src/services/analytics/index.js'
import { getSessionId } from 'src/bootstrap/state.js'
import { getInitJsonSchema } from 'src/bootstrap/state.js'
import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import type { QueuedCommand } from 'src/types/textInputTypes.js'
import { dequeue, peek } from 'src/utils/messageQueueManager.js'
import { notifyCommandLifecycle } from 'src/utils/commandLifecycle.js'
import { mergeFileStateCaches } from 'src/utils/fileStateCache.js'
import { executeFilePersistence } from 'src/utils/filePersistence/filePersistence.js'
import { createAbortController } from 'src/utils/process/abortController.js'
import { isEnvDefinedFalsy } from 'src/utils/envUtils.js'
import { logError } from 'src/utils/log.js'
import { toError } from 'src/utils/errors.js'
import { getLastCacheSafeParams } from 'src/utils/collections/cacheSafeParamsSlot.js'
import {
  logSuggestionOutcome,
  logSuggestionSuppressed,
  tryGenerateSuggestion,
} from 'src/services/PromptSuggestion/promptSuggestion.js'
import {
  claimConsumableQueuedAutonomyCommands,
  finalizeAutonomyCommandsForTurn,
} from 'src/utils/autonomyQueueLifecycle.js'
import { enqueue } from 'src/utils/messageQueueManager.js'
import { runWithWorkload } from 'src/utils/workloadContext.js'
import { drainSdkEvents } from 'src/utils/sdkEventQueue.js'
import { getRunningTasks } from 'src/utils/task/framework.js'
import { isBackgroundTask } from 'src/tasks/types.js'
import {
  headlessProfilerCheckpoint,
  headlessProfilerStartTurn,
  logHeadlessProfilerTurn,
} from 'src/utils/headlessProfiler.js'
import {
  logQueryProfileReport,
  startQueryProfile,
} from 'src/utils/queryProfiler.js'
import { canBatchWith, joinPromptValues } from './promptQueue.js'
import {
  buildAllTools,
  registerElicitationHandlers,
} from './headlessMcpRuntime.js'
import { reregisterChannelHandlerAfterReconnect } from './channels.js'
import {
  isMainThreadCommand,
  type HeadlessRunState,
} from './headlessRunState.js'

/**
 * Drains the main-thread command queue, batching consecutive prompt-mode
 * commands into one ask() call so messages that queued up during a long turn
 * coalesce into a single follow-up turn instead of N separate turns.
 */
export async function drainCommandQueue(
  state: HeadlessRunState,
): Promise<void> {
  let command: QueuedCommand | undefined
  while ((command = dequeue(isMainThreadCommand))) {
    if (
      command.mode !== 'prompt' &&
      command.mode !== 'orphaned-permission' &&
      command.mode !== 'task-notification'
    ) {
      throw new Error('only prompt commands are supported in streaming mode')
    }

    // Non-prompt commands (task-notification, orphaned-permission) carry
    // side effects or orphanedPermission state, so they process singly.
    // Prompt commands greedily collect followers with matching workload.
    let batch: QueuedCommand[] = [command]
    if (command.mode === 'prompt') {
      while (canBatchWith(command, peek(isMainThreadCommand))) {
        batch.push(dequeue(isMainThreadCommand)!)
      }
    }
    const queuedAutonomyClaim =
      await claimConsumableQueuedAutonomyCommands(batch)
    batch = queuedAutonomyClaim.attachmentCommands
    if (batch.length === 0) {
      continue
    }
    command = batch[0]!
    if (command.mode === 'prompt' && batch.length > 1) {
      command = {
        ...command,
        value: joinPromptValues(batch.map(c => c.value)),
        uuid: batch.findLast(c => c.uuid)?.uuid ?? command.uuid,
      }
    }
    const batchUuids = batch.map(c => c.uuid).filter(u => u !== undefined)

    // QueryEngine will emit a replay for command.uuid (the last uuid in
    // the batch) via its messagesToAck path. Emit replays here for the
    // rest so consumers that track per-uuid delivery (clank's
    // asyncMessages footer, CCR) see an ack for every message they sent,
    // not just the one that survived the merge.
    if (state.options.replayUserMessages && batch.length > 1) {
      for (const c of batch) {
        if (c.uuid && c.uuid !== command.uuid) {
          state.output.enqueue({
            type: 'user',
            content: c.value,
            message: { role: 'user', content: c.value } as unknown,
            session_id: getSessionId(),
            parent_tool_use_id: null,
            uuid: c.uuid as string,
            isReplay: true,
          } as unknown as StdoutMessage)
        }
      }
    }

    // Combine all MCP clients. appState.mcp is populated incrementally
    // per-server by main.tsx (mirrors useManageMCPConnections). Reading
    // fresh per-command means late-connecting servers are visible on the
    // next turn. registerElicitationHandlers is idempotent (tracking set).
    const appState = state.getAppState()
    const allMcpClients = [
      ...appState.mcp.clients,
      ...state.sdkClients,
      ...state.dynamicMcpState.clients,
    ]
    registerElicitationHandlers(state, allMcpClients)
    // Channel handlers for servers allowlisted via --channels at
    // construction time (or enableChannel() mid-session). Runs every
    // turn like registerElicitationHandlers — idempotent per-client
    // (setNotificationHandler replaces, not stacks) and no-ops for
    // non-allowlisted servers (one feature-flag check).
    for (const client of allMcpClients) {
      reregisterChannelHandlerAfterReconnect(client)
    }

    const allTools = buildAllTools(state, appState)

    for (const uuid of batchUuids) {
      notifyCommandLifecycle(uuid, 'started')
    }

    // Task notifications arrive when background agents complete.
    // Emit an SDK system event for SDK consumers, then fall through
    // to ask() so the model sees the agent result and can act on it.
    // This matches TUI behavior where useQueueProcessor always feeds
    // notifications to the model regardless of coordinator mode.
    if (command.mode === 'task-notification') {
      const notificationText =
        typeof command.value === 'string' ? command.value : ''
      // Parse the XML-formatted notification
      const taskIdMatch = notificationText.match(/<task-id>([^<]+)<\/task-id>/)
      const toolUseIdMatch = notificationText.match(
        /<tool-use-id>([^<]+)<\/tool-use-id>/,
      )
      const outputFileMatch = notificationText.match(
        /<output-file>([^<]+)<\/output-file>/,
      )
      const statusMatch = notificationText.match(/<status>([^<]+)<\/status>/)
      const summaryMatch = notificationText.match(/<summary>([^<]+)<\/summary>/)

      const isValidStatus = (
        s: string | undefined,
      ): s is 'completed' | 'failed' | 'stopped' | 'killed' =>
        s === 'completed' || s === 'failed' || s === 'stopped' || s === 'killed'
      const rawStatus = statusMatch?.[1]
      const status = isValidStatus(rawStatus)
        ? rawStatus === 'killed'
          ? 'stopped'
          : rawStatus
        : 'completed'

      const usageMatch = notificationText.match(/<usage>([\s\S]*?)<\/usage>/)
      const usageContent = usageMatch?.[1] ?? ''
      const totalTokensMatch = usageContent.match(
        /<total_tokens>(\d+)<\/total_tokens>/,
      )
      const toolUsesMatch = usageContent.match(/<tool_uses>(\d+)<\/tool_uses>/)
      const durationMsMatch = usageContent.match(
        /<duration_ms>(\d+)<\/duration_ms>/,
      )

      // Only emit a task_notification SDK event when a <status> tag is
      // present — that means this is a terminal notification (completed/
      // failed/stopped). Stream events from enqueueStreamEvent carry no
      // <status> (they're progress pings); emitting them here would
      // default to 'completed' and falsely close the task for SDK
      // consumers. Terminal bookends are now emitted directly via
      // emitTaskTerminatedSdk, so skipping statusless events is safe.
      if (statusMatch) {
        state.output.enqueue({
          type: 'system',
          subtype: 'task_notification',
          task_id: taskIdMatch?.[1] ?? '',
          tool_use_id: toolUseIdMatch?.[1],
          status,
          output_file: outputFileMatch?.[1] ?? '',
          summary: summaryMatch?.[1] ?? '',
          usage:
            totalTokensMatch && toolUsesMatch
              ? {
                  total_tokens: parseInt(totalTokensMatch[1]!, 10),
                  tool_uses: parseInt(toolUsesMatch[1]!, 10),
                  duration_ms: durationMsMatch
                    ? parseInt(durationMsMatch[1]!, 10)
                    : 0,
                }
              : undefined,
          session_id: getSessionId(),
          uuid: randomUUID(),
        })
      }
      // No continue -- fall through to ask() so the model processes the result
    }

    const input = command.value
    const claimedAutonomyCommands = queuedAutonomyClaim.claimedCommands

    if (state.structuredIO instanceof RemoteIO && command.mode === 'prompt') {
      logEvent('tengu_bridge_message_received', {
        is_repl: false,
      })
    }

    // Abort any in-flight suggestion generation and track acceptance
    state.suggestionState.abortController?.abort()
    state.suggestionState.abortController = null
    state.suggestionState.pendingSuggestion = null
    state.suggestionState.pendingLastEmittedEntry = null
    if (state.suggestionState.lastEmitted) {
      if (command.mode === 'prompt') {
        // SDK user messages enqueue ContentBlockParam[], not a plain string
        const inputText =
          typeof input === 'string'
            ? input
            : (
                input.find(b => b.type === 'text') as
                  | { type: 'text'; text: string }
                  | undefined
              )?.text
        if (typeof inputText === 'string') {
          logSuggestionOutcome(
            state.suggestionState.lastEmitted.text,
            inputText,
            state.suggestionState.lastEmitted.emittedAt,
            state.suggestionState.lastEmitted.promptId,
            state.suggestionState.lastEmitted.generationRequestId,
          )
        }
        state.suggestionState.lastEmitted = null
      }
    }

    state.abortController = createAbortController()
    const turnStartTime = feature('FILE_PERSISTENCE') ? Date.now() : undefined

    headlessProfilerCheckpoint('before_ask')
    startQueryProfile()
    // Per-iteration ALS context so bg agents spawned inside ask()
    // inherit workload across their detached awaits. In-process cron
    // stamps cmd.workload; the SDK --workload flag is state.options.workload.
    // const-capture: TS loses `while ((command = dequeue()))` narrowing
    // inside the closure.
    const cmd = command
    let lastResultIsError = false
    try {
      await runWithWorkload(
        cmd.workload ?? state.options.workload,
        async () => {
          for await (const message of ask({
            commands: uniqBy(
              [...state.currentCommands, ...appState.mcp.commands],
              'name',
            ),
            prompt: input,
            promptUuid: cmd.uuid,
            isMeta: cmd.isMeta,
            cwd: cwd(),
            tools: allTools,
            verbose: state.options.verbose,
            mcpClients: allMcpClients,
            thinkingConfig: state.options.thinkingConfig,
            maxTurns: state.options.maxTurns,
            maxBudgetUsd: state.options.maxBudgetUsd,
            taskBudget: state.options.taskBudget,
            canUseTool: state.canUseTool,
            userSpecifiedModel: state.activeUserSpecifiedModel,
            fallbackModel: state.options.fallbackModel,
            jsonSchema: getInitJsonSchema() ?? state.options.jsonSchema,
            mutableMessages: state.mutableMessages,
            getReadFileCache: () =>
              state.pendingSeeds.size === 0
                ? state.readFileState
                : mergeFileStateCaches(state.readFileState, state.pendingSeeds),
            setReadFileCache: cache => {
              state.readFileState = cache
              for (const [path, seed] of state.pendingSeeds.entries()) {
                const existing = state.readFileState.get(path)
                if (!existing || seed.timestamp > existing.timestamp) {
                  state.readFileState.set(path, seed)
                }
              }
              state.pendingSeeds.clear()
            },
            customSystemPrompt: state.options.systemPrompt,
            appendSystemPrompt: state.options.appendSystemPrompt,
            getAppState: state.getAppState,
            setAppState: state.setAppState,
            abortController: state.abortController,
            replayUserMessages: state.options.replayUserMessages,
            includePartialMessages: state.options.includePartialMessages,
            handleElicitation: (serverName, params, elicitSignal) =>
              state.structuredIO.handleElicitation(
                serverName,
                params.message,
                undefined,
                elicitSignal,
                params.mode,
                params.url,
                'elicitationId' in params ? params.elicitationId : undefined,
              ),
            agents: state.currentAgents,
            orphanedPermission: cmd.orphanedPermission,
            setSDKStatus: status => {
              state.output.enqueue({
                type: 'system',
                subtype: 'status',
                status: status as 'compacting' | null,
                session_id: getSessionId(),
                uuid: randomUUID(),
              })
            },
          })) {
            if (message.type === 'result') {
              lastResultIsError = !!(message as Record<string, unknown>)
                .is_error
              // Flush pending SDK events so they appear before result on the stream.
              for (const event of drainSdkEvents()) {
                state.output.enqueue(event)
              }

              // Hold-back: don't emit result while background agents are running
              const currentState = state.getAppState()
              if (
                getRunningTasks(currentState).some(
                  t =>
                    (t.type === 'local_agent' || t.type === 'local_workflow') &&
                    isBackgroundTask(t),
                )
              ) {
                state.heldBackResult = message as StdoutMessage
              } else {
                state.heldBackResult = null
                state.output.enqueue(message as StdoutMessage)
              }
            } else {
              // Flush SDK events (task_started, task_progress) so background
              // agent progress is streamed in real-time, not batched until result.
              for (const event of drainSdkEvents()) {
                state.output.enqueue(event)
              }
              state.output.enqueue(message as StdoutMessage)
            }
          }
        },
      ) // end runWithWorkload
      if (lastResultIsError) {
        await finalizeAutonomyCommandsForTurn({
          commands: claimedAutonomyCommands,
          outcome: {
            type: 'failed',
            message: 'ask() returned an error result',
          },
          currentDir: cwd(),
          priority: 'later',
          workload: cmd.workload ?? state.options.workload,
        })
      } else {
        const nextCommands = await finalizeAutonomyCommandsForTurn({
          commands: claimedAutonomyCommands,
          outcome: { type: 'completed' },
          currentDir: cwd(),
          priority: 'later',
          workload: cmd.workload ?? state.options.workload,
        })
        for (const nextCommand of nextCommands) {
          enqueue({
            ...nextCommand,
            uuid: randomUUID(),
          })
        }
      }
    } catch (error) {
      await finalizeAutonomyCommandsForTurn({
        commands: claimedAutonomyCommands,
        outcome: { type: 'failed', error },
        currentDir: cwd(),
        priority: 'later',
        workload: cmd.workload ?? state.options.workload,
      })
      throw error
    }

    for (const uuid of batchUuids) {
      notifyCommandLifecycle(uuid, 'completed')
    }

    if (feature('FILE_PERSISTENCE') && turnStartTime !== undefined) {
      void executeFilePersistence(
        {
          turnStartTime,
        } as import('src/utils/filePersistence/types.js').TurnStartTime,
        state.abortController.signal,
        result => {
          const filesResult = result as unknown as {
            persistedFiles: { filename: string; file_id: string }[]
            failedFiles: { filename: string; error: string }[]
          }
          state.output.enqueue({
            type: 'system' as const,
            subtype: 'files_persisted' as const,
            files: filesResult.persistedFiles,
            failed: filesResult.failedFiles,
            processed_at: new Date().toISOString(),
            uuid: randomUUID(),
            session_id: getSessionId(),
          })
        },
      )
    }

    // Generate and emit prompt suggestion for SDK consumers
    if (
      state.options.promptSuggestions &&
      !isEnvDefinedFalsy(process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION)
    ) {
      // TS narrows state.suggestionState to never in the while loop body;
      // cast via unknown to reset narrowing.
      const suggestionStateRef =
        state.suggestionState as unknown as typeof state.suggestionState
      suggestionStateRef.abortController?.abort()
      const localAbort = new AbortController()
      state.suggestionState.abortController = localAbort

      const cacheSafeParams = getLastCacheSafeParams()
      if (!cacheSafeParams) {
        logSuggestionSuppressed('sdk_no_params', undefined, undefined, 'sdk')
      } else {
        // Use a ref object so the IIFE's finally can compare against its own
        // promise without a self-reference (which upsets TypeScript's flow analysis).
        const ref: { promise: Promise<void> | null } = { promise: null }
        ref.promise = (async () => {
          try {
            const result = await tryGenerateSuggestion(
              localAbort,
              state.mutableMessages,
              state.getAppState,
              cacheSafeParams,
              'sdk',
            )
            if (!result || localAbort.signal.aborted) return
            const suggestionMsg = {
              type: 'prompt_suggestion' as const,
              suggestion: result.suggestion,
              uuid: randomUUID(),
              session_id: getSessionId(),
            }
            const lastEmittedEntry = {
              text: result.suggestion,
              emittedAt: Date.now(),
              promptId: result.promptId,
              generationRequestId: result.generationRequestId,
            }
            // Defer emission if the result is being held for background agents,
            // so that prompt_suggestion always arrives after result.
            // Only set lastEmitted when the suggestion is actually delivered
            // to the consumer; deferred suggestions may be discarded before
            // delivery if a new command arrives first.
            if (state.heldBackResult) {
              state.suggestionState.pendingSuggestion = suggestionMsg
              state.suggestionState.pendingLastEmittedEntry = {
                text: lastEmittedEntry.text,
                promptId: lastEmittedEntry.promptId,
                generationRequestId: lastEmittedEntry.generationRequestId,
              }
            } else {
              state.suggestionState.lastEmitted = lastEmittedEntry
              state.output.enqueue(suggestionMsg)
            }
          } catch (error) {
            if (
              error instanceof Error &&
              (error.name === 'AbortError' ||
                error.name === 'APIUserAbortError')
            ) {
              logSuggestionSuppressed('aborted', undefined, undefined, 'sdk')
              return
            }
            logError(toError(error))
          } finally {
            if (state.suggestionState.inflightPromise === ref.promise) {
              state.suggestionState.inflightPromise = null
            }
          }
        })()
        state.suggestionState.inflightPromise = ref.promise
      }
    }

    // Log headless profiler metrics for this turn and start next turn
    logHeadlessProfilerTurn()
    logQueryProfileReport()
    headlessProfilerStartTurn()
  }
}
