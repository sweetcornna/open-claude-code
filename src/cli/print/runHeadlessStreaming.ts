// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle'
import { StructuredIO } from 'src/cli/structuredIO.js'
import { type Command } from 'src/commands.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/telemetry/diagLogs.js'
import { type Tools } from 'src/Tool.js'
import { type AgentDefinition } from '@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { Message } from 'src/types/message.js'
import {
  enqueue,
  subscribeToCommandQueue,
  getCommandsByMaxPriority,
} from 'src/utils/messageQueueManager.js'
import {
  getSessionState,
  notifySessionMetadataChanged,
  setPermissionModeChangedListener,
} from 'src/utils/sessionState.js'
import { type TurnInterruptionState } from 'src/utils/conversationRecovery.js'
import type {
  MCPServerConnection,
  McpSdkServerConfig,
} from 'src/services/mcp/types.js'
import { ask } from 'src/QueryEngine.js'
import { gracefulShutdown } from 'src/utils/process/gracefulShutdown.js'
import { registerCleanup } from 'src/utils/process/cleanupRegistry.js'
import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { cwd } from 'process'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import { AwsAuthStatusManager } from 'src/utils/auth/awsAuthStatusManager.js'
import { toSDKRateLimitInfo } from 'src/utils/messages/mappers.js'
import {
  statusListeners,
  type ClaudeAILimits,
} from 'src/services/claudeAiLimits.js'
import { getSessionId } from 'src/bootstrap/state.js'
import { randomUUID } from 'crypto'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { AppState } from 'src/state/AppStateStore.js'
import { skillChangeDetector } from '../../utils/skills/skillChangeDetector.js'
import { getCommands, clearCommandsCache } from '../../commands.js'
import { isBareMode, isEnvTruthy } from '../../utils/config/envUtils.js'
import { getRunningTasks } from '../../utils/task/framework.js'
import { isBackgroundTask } from '../../tasks/types.js'
import { removeInterruptedMessage } from './sessionLoading.js'
import { handleOrphanedPermissionResponse } from './structuredIO.js'
import { installPluginsAndApplyMcpInBackground } from './headlessPlugins.js'
import { updateSdkMcp } from './headlessMcpRuntime.js'
import {
  createHeadlessRunState,
  type HeadlessRunState,
  type HeadlessStreamingOptions,
} from './headlessRunState.js'
import { runHeadlessTurn } from './headlessTurnLoop.js'
import { startHeadlessCronScheduler } from './headlessCron.js'
import { runHeadlessInputLoop } from './headlessStdin.js'

export function runHeadlessStreaming(
  structuredIO: StructuredIO,
  mcpClients: MCPServerConnection[],
  commands: Command[],
  tools: Tools,
  initialMessages: Message[],
  canUseTool: CanUseToolFn,
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  getAppState: () => AppState,
  setAppState: (f: (prev: AppState) => AppState) => void,
  agents: AgentDefinition[],
  options: HeadlessStreamingOptions,
  turnInterruptionState?: TurnInterruptionState,
): AsyncIterable<StdoutMessage> {
  // Set up rate limit status listener to emit SDKRateLimitEvent for all status
  // changes. Emitting for all statuses (including 'allowed') ensures consumers
  // can clear warnings when rate limits reset. The upstream emitStatusChange
  // already deduplicates via isEqual. Declared before the state so the state
  // can own it for teardown.
  const rateLimitListener = (limits: ClaudeAILimits) => {
    const rateLimitInfo = toSDKRateLimitInfo(limits)
    if (rateLimitInfo) {
      structuredIO.outbound.enqueue({
        type: 'rate_limit_event',
        rate_limit_info: rateLimitInfo,
        uuid: randomUUID(),
        session_id: getSessionId(),
      } as unknown as Parameters<typeof structuredIO.outbound.enqueue>[0])
    }
  }

  const state: HeadlessRunState = createHeadlessRunState({
    structuredIO,
    mcpClients,
    commands,
    tools,
    initialMessages,
    canUseTool,
    sdkMcpConfigs,
    getAppState,
    setAppState,
    agents,
    options,
    rateLimitListener,
  })
  // Same queue sendRequest() enqueues to — one FIFO for everything.
  const output = state.output

  // Ctrl+C in -p mode: abort the in-flight query, then shut down gracefully.
  // gracefulShutdown persists session state and flushes analytics, with a
  // failsafe timer that force-exits if cleanup hangs.
  const sigintHandler = () => {
    logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGINT' })
    if (state.abortController && !state.abortController.signal.aborted) {
      state.abortController.abort()
    }
    void gracefulShutdown(0)
  }
  process.on('SIGINT', sigintHandler)

  // Dump run()'s state at SIGTERM so a stuck session's healthsweep can name
  // the do/while(waitingForAgents) poll without reading the transcript.
  registerCleanup(async () => {
    const bg: Record<string, number> = {}
    for (const t of getRunningTasks(getAppState())) {
      if (isBackgroundTask(t)) bg[t.type] = (bg[t.type] ?? 0) + 1
    }
    logForDiagnosticsNoPII('info', 'run_state_at_shutdown', {
      run_active: state.running,
      run_phase: state.runPhase,
      worker_status: getSessionState(),
      internal_events_pending: structuredIO.internalEventsPending,
      bg_tasks: bg,
    })
  })

  // Wire the central onChangeAppState mode-diff hook to the SDK output stream.
  // This fires whenever ANY code path mutates toolPermissionContext.mode —
  // Shift+Tab, ExitPlanMode dialog, /plan slash command, rewind, bridge
  // set_permission_mode, the query loop, stop_task — rather than the two
  // paths that previously went through a bespoke wrapper.
  // The wrapper's body was fully redundant (it enqueued here AND called
  // notifySessionMetadataChanged, both of which onChangeAppState now covers);
  // keeping it would double-emit status messages.
  setPermissionModeChangedListener(newMode => {
    // Only emit for SDK-exposed modes.
    if (
      newMode === 'default' ||
      newMode === 'acceptEdits' ||
      newMode === 'bypassPermissions' ||
      newMode === 'plan' ||
      newMode === (feature('TRANSCRIPT_CLASSIFIER') && 'auto') ||
      newMode === 'dontAsk'
    ) {
      output.enqueue({
        type: 'system',
        subtype: 'status',
        status: null,
        permissionMode: newMode as PermissionMode,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    }
  })

  // Set up AWS auth status listener if enabled
  if (options.enableAuthStatus) {
    const authStatusManager = AwsAuthStatusManager.getInstance()
    state.unsubscribeAuthStatus = authStatusManager.subscribe(status => {
      output.enqueue({
        type: 'auth_status',
        isAuthenticating: status.isAuthenticating,
        output: status.output,
        error: status.error,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    })
  }

  statusListeners.add(rateLimitListener)

  const mutableMessages = state.mutableMessages

  // Auto-resume interrupted turns on restart so CC continues from where it
  // left off without requiring the SDK to re-send the prompt.
  const resumeInterruptedTurnEnv =
    process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN
  if (
    turnInterruptionState &&
    turnInterruptionState.kind !== 'none' &&
    resumeInterruptedTurnEnv
  ) {
    logForDebugging(
      `[print.ts] Auto-resuming interrupted turn (kind: ${turnInterruptionState.kind})`,
    )

    // Remove the interrupted message and its sentinel, then re-enqueue so
    // the model sees it exactly once. For mid-turn interruptions, the
    // deserialization layer transforms them into interrupted_prompt by
    // appending a synthetic "Continue from where you left off." message.
    removeInterruptedMessage(mutableMessages, turnInterruptionState.message)
    enqueue({
      mode: 'prompt',
      value: turnInterruptionState.message.message!.content as
        | string
        | ContentBlockParam[],
      uuid: randomUUID(),
    })
  }

  void updateSdkMcp(state)

  // Background plugin installation for all headless users
  // Installs marketplaces from extraKnownMarketplaces and missing enabled plugins
  // CLAUDE_CODE_SYNC_PLUGIN_INSTALL=true: resolved in run() before the first
  // query so plugins are guaranteed available on the first ask().
  // --bare / SIMPLE: skip plugin install. Scripted calls don't add plugins
  // mid-session; the next interactive run reconciles.
  if (!isBareMode()) {
    if (isEnvTruthy(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL)) {
      state.pluginInstallPromise = installPluginsAndApplyMcpInBackground(state)
    } else {
      void installPluginsAndApplyMcpInBackground(state)
    }
  }

  // Subscribe to skill changes for hot reloading
  state.unsubscribeSkillChanges = skillChangeDetector.subscribe(() => {
    clearCommandsCache()
    void getCommands(cwd()).then(newCommands => {
      state.currentCommands = newCommands
    })
  })

  // Abort the current operation when a 'now' priority message arrives.
  subscribeToCommandQueue(() => {
    if (state.abortController && getCommandsByMaxPriority('now').length > 0) {
      state.abortController.abort('interrupt')
    }
  })

  // Set up UDS inbox callback so the query loop is kicked off
  // when a message arrives via the UDS socket in headless mode.

  startHeadlessCronScheduler(state)

  // Handle unexpected permission responses by looking up the unresolved tool
  // call in the transcript and executing it
  const handledOrphanedToolUseIds = state.handledOrphanedToolUseIds
  structuredIO.setUnexpectedResponseCallback(async message => {
    await handleOrphanedPermissionResponse({
      message,
      setAppState,
      handledToolUseIds: handledOrphanedToolUseIds,
      onEnqueued: () => {
        // The first message of a session might be the orphaned permission
        // check rather than a user prompt, so kick off the loop.
        void runHeadlessTurn(state)
      },
    })
  })

  // This is essentially spawning a parallel async task- we have two
  // running in parallel- one reading from stdin and adding to the
  // queue to be processed and another reading from the queue,
  // processing and returning the result of the generation.
  // The process is complete when the input stream completes and
  // the last generation of the queue has complete.
  void runHeadlessInputLoop(state)

  return output
}
