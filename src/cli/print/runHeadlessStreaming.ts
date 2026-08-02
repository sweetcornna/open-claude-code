// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle'
import { readFile, stat } from 'fs/promises'
import { StructuredIO } from 'src/cli/structuredIO.js'
import {
  type Command,
  formatDescriptionWithSource,
  getCommandName,
} from 'src/commands.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { logEvent } from 'src/services/analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { type Tools } from 'src/Tool.js'
import { type AgentDefinition } from '@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { Message } from 'src/types/message.js'
import {
  dequeueAllMatching,
  enqueue,
  hasCommandsInQueue,
  subscribeToCommandQueue,
  getCommandsByMaxPriority,
} from 'src/utils/messageQueueManager.js'
import { notifyCommandLifecycle } from 'src/utils/commandLifecycle.js'
import {
  getSessionState,
  notifySessionMetadataChanged,
  setPermissionModeChangedListener,
} from 'src/utils/sessionState.js'
import { logError } from 'src/utils/log.js'
import { type TurnInterruptionState } from 'src/utils/conversationRecovery.js'
import type {
  MCPServerConnection,
  McpSdkServerConfig,
} from 'src/services/mcp/types.js'
import { ask } from 'src/QueryEngine.js'
import { expandPath } from 'src/utils/path.js'
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js'
import { registerCleanup } from 'src/utils/cleanupRegistry.js'
import type {
  SDKStatus,
  SDKMessage,
  SDKUserMessage,
  McpServerConfigForProcessTransport,
} from 'src/entrypoints/agentSdkTypes.js'
import type {
  StdoutMessage,
  SDKControlRequest,
  SDKControlReloadPluginsResponse,
} from 'src/entrypoints/sdk/controlTypes.js'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { cwd } from 'process'
import omit from 'lodash-es/omit.js'
import reject from 'lodash-es/reject.js'
import { getRemoteSessionUrl } from 'src/constants/product.js'
import { resolveAndPrepend } from 'src/cli/inboundAttachments.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import { createAbortController } from 'src/utils/abortController.js'
import { generateSessionTitle } from 'src/utils/sessionTitle.js'
import { buildSideQuestionFallbackParams } from 'src/utils/queryContext.js'
import { runSideQuestion } from 'src/utils/sideQuestion.js'
import { getSettingsWithSources } from 'src/utils/settings/settings.js'
import { settingsChangeDetector } from 'src/utils/settings/changeDetector.js'
import { getLastCacheSafeParams } from 'src/utils/cacheSafeParamsSlot.js'
import { getAccountInformation } from 'src/utils/auth.js'
import { OAuthService } from 'src/services/oauth/index.js'
import { installOAuthTokens } from 'src/cli/handlers/auth.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { AwsAuthStatusManager } from 'src/utils/awsAuthStatusManager.js'
import { setSdkAgentProgressSummariesEnabled } from 'src/bootstrap/state.js'
import {
  doesMessageExistInSession,
  recordAttributionSnapshot,
  saveAiGeneratedTitle,
} from 'src/utils/sessionStorage.js'
import { incrementPromptCount } from 'src/utils/commitAttribution.js'
import {
  clearServerCache,
  reconnectMcpServerImpl,
} from 'src/services/mcp/client.js'
import {
  getMcpConfigByName,
  isMcpServerDisabled,
  setMcpServerEnabled,
} from 'src/services/mcp/config.js'
import {
  performMCPOAuthFlow,
  revokeServerTokens,
} from 'src/services/mcp/auth.js'
import { getMcpPrefix } from 'src/services/mcp/mcpStringUtils.js'
import { commandBelongsToServer } from 'src/services/mcp/utils.js'
import {
  toInternalMessages,
  toSDKRateLimitInfo,
} from 'src/utils/messages/mappers.js'
import { createModelSwitchBreadcrumbs } from 'src/utils/messages.js'
import { collectContextData } from 'src/commands/context/context-noninteractive.js'
import { LOCAL_COMMAND_STDOUT_TAG } from 'src/constants/xml.js'
import {
  statusListeners,
  type ClaudeAILimits,
} from 'src/services/claudeAiLimits.js'
import {
  getDefaultMainLoopModel,
  getMainLoopModel,
  modelDisplayString,
} from 'src/utils/model/model.js'
import { modelSupportsEffort, resolveAppliedEffort } from 'src/utils/effort.js'
import {
  getSessionId,
  setMainLoopModelOverride,
  getIsRemoteMode,
  getFlagSettingsInline,
  setFlagSettingsInline,
} from 'src/bootstrap/state.js'
import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { AppState } from 'src/state/AppStateStore.js'
import { skillChangeDetector } from '../../utils/skills/skillChangeDetector.js'
import { getCommands, clearCommandsCache } from '../../commands.js'
import { isBareMode, isEnvTruthy } from '../../utils/envUtils.js'
import { refreshActivePlugins } from '../../utils/plugins/refresh.js'
import { loadAllPluginsCacheOnly } from '../../utils/plugins/pluginLoader.js'
import { getRunningTasks } from '../../utils/task/framework.js'
import { isBackgroundTask } from '../../tasks/types.js'
import { stopTask } from '../../tasks/stopTask.js'
import { errorMessage } from '../../utils/errors.js'
import {
  handleInitializeRequest,
  handleRewindFiles,
  handleSetPermissionMode,
} from './controlHandlers.js'
import {
  handleChannelEnable,
  reregisterChannelHandlerAfterReconnect,
} from './channels.js'
import {
  proactiveModule,
  receivedMessageUuids,
  trackReceivedMessageUuid,
} from './runtime.js'
import { removeInterruptedMessage } from './sessionLoading.js'
import { handleOrphanedPermissionResponse } from './structuredIO.js'
import {
  installPluginsAndApplyMcpInBackground,
  applyPluginMcpDiff,
} from './headlessPlugins.js'
import {
  applyMcpServerChanges,
  buildAllTools,
  buildMcpServerStatuses,
  registerElicitationHandlers,
  updateSdkMcp,
} from './headlessMcpRuntime.js'
import {
  createHeadlessRunState,
  type HeadlessRunState,
} from './headlessRunState.js'
import { finalizeHeadlessOutput } from './headlessTeardown.js'
import { runHeadlessTurn, scheduleProactiveTick } from './headlessTurnLoop.js'
import { startHeadlessCronScheduler } from './headlessCron.js'
import {
  sendControlResponseError,
  sendControlResponseSuccess,
} from './headlessControlResponses.js'

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
  options: {
    verbose: boolean | undefined
    jsonSchema: Record<string, unknown> | undefined
    permissionPromptToolName: string | undefined
    allowedTools: string[] | undefined
    thinkingConfig: ThinkingConfig | undefined
    maxTurns: number | undefined
    maxBudgetUsd: number | undefined
    taskBudget: { total: number } | undefined
    systemPrompt: string | undefined
    appendSystemPrompt: string | undefined
    userSpecifiedModel: string | undefined
    fallbackModel: string | undefined
    replayUserMessages?: boolean | undefined
    includePartialMessages?: boolean | undefined
    enableAuthStatus?: boolean | undefined
    agent?: string | undefined
    setSDKStatus?: (status: SDKStatus) => void
    promptSuggestions?: boolean | undefined
    workload?: string | undefined
  },
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

  // Prompt suggestion tracking (push model)
  const suggestionState = state.suggestionState

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
  const pendingSeeds = state.pendingSeeds

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

  const modelInfos = state.modelInfos

  function injectModelSwitchBreadcrumbs(
    modelArg: string,
    resolvedModel: string,
  ): void {
    const breadcrumbs = createModelSwitchBreadcrumbs(
      modelArg,
      modelDisplayString(resolvedModel),
    )
    mutableMessages.push(...breadcrumbs)
    for (const crumb of breadcrumbs) {
      if (
        typeof crumb.message.content === 'string' &&
        crumb.message.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`)
      ) {
        output.enqueue({
          type: 'user',
          content: crumb.message.content,
          message: crumb.message as unknown,
          session_id: getSessionId(),
          parent_tool_use_id: null,
          uuid: crumb.uuid,
          timestamp: crumb.timestamp,
          isReplay: true,
        } as unknown as StdoutMessage)
      }
    }
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

  // Idle timeout management
  const idleTimeout = state.idleTimeout

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

  const activeOAuthFlows = state.activeOAuthFlows
  const oauthCallbackSubmitters = state.oauthCallbackSubmitters
  const oauthManualCallbackUsed = state.oauthManualCallbackUsed
  const oauthAuthPromises = state.oauthAuthPromises

  // This is essentially spawning a parallel async task- we have two
  // running in parallel- one reading from stdin and adding to the
  // queue to be processed and another reading from the queue,
  // processing and returning the result of the generation.
  // The process is complete when the input stream completes and
  // the last generation of the queue has complete.
  void (async () => {
    let initialized = false
    logForDiagnosticsNoPII('info', 'cli_message_loop_started')
    for await (const message of structuredIO.structuredInput) {
      // Non-user events are handled inline (no queue). started→completed in
      // the same tick carries no information, so only fire completed.
      // control_response is reported by StructuredIO.processLine (which also
      // sees orphans that never yield here).
      const eventId = 'uuid' in message ? message.uuid : undefined
      if (
        eventId &&
        message.type !== 'user' &&
        message.type !== 'control_response'
      ) {
        notifyCommandLifecycle(eventId as string, 'completed')
      }

      if (message.type === 'control_request') {
        // Type assertion: structuredInput yields StdinMessage | SDKMessage, but
        // when type === 'control_request' the object has request_id and request.
        // The union with SDKMessage (typed as `any`) causes request to be `unknown`.
        // Cast to SDKControlRequest (via unknown) for type safety on known subtypes,
        // and use Record<string, unknown> for subtypes not in the zod schema union.
        const msg = message as unknown as SDKControlRequest
        // Wider-typed alias for request properties on subtypes not in the zod schema.
        // The schema union doesn't include end_session, channel_enable, mcp_authenticate,
        // claude_authenticate, etc. so accessing their properties narrows to `never`.
        const req = msg.request as Record<string, unknown>
        if (msg.request.subtype === 'interrupt') {
          // Track escapes for attribution (ant-only feature)
          if (feature('COMMIT_ATTRIBUTION')) {
            setAppState(prev => ({
              ...prev,
              attribution: {
                ...prev.attribution,
                escapeCount: prev.attribution.escapeCount + 1,
              },
            }))
          }
          if (state.abortController) {
            state.abortController.abort()
          }
          suggestionState.abortController?.abort()
          suggestionState.abortController = null
          suggestionState.lastEmitted = null
          suggestionState.pendingSuggestion = null
          sendControlResponseSuccess(state, msg)
        } else if (req.subtype === 'end_session') {
          logForDebugging(
            `[print.ts] end_session received, reason=${req.reason ?? 'unspecified'}`,
          )
          if (state.abortController) {
            state.abortController.abort()
          }
          suggestionState.abortController?.abort()
          suggestionState.abortController = null
          suggestionState.lastEmitted = null
          suggestionState.pendingSuggestion = null
          sendControlResponseSuccess(state, msg)
          break // exits for-await → falls through to inputClosed=true drain below
        } else if (msg.request.subtype === 'initialize') {
          // SDK MCP server names from the initialize message
          // Populated by both browser and ProcessTransport sessions
          if (
            msg.request.sdkMcpServers &&
            msg.request.sdkMcpServers.length > 0
          ) {
            for (const serverName of msg.request.sdkMcpServers) {
              // Create placeholder config for SDK MCP servers
              // The actual server connection is managed by the SDK Query class
              sdkMcpConfigs[serverName] = {
                type: 'sdk',
                name: serverName,
              }
            }
          }

          await handleInitializeRequest(
            msg.request,
            msg.request_id,
            initialized,
            output,
            commands,
            modelInfos,
            structuredIO,
            !!options.enableAuthStatus,
            options,
            agents,
            getAppState,
          )

          // Enable prompt suggestions in AppState when SDK consumer opts in.
          // shouldEnablePromptSuggestion() returns false for non-interactive
          // sessions, but the SDK consumer explicitly requested suggestions.
          if (msg.request.promptSuggestions) {
            setAppState(prev => {
              if (prev.promptSuggestionEnabled) return prev
              return { ...prev, promptSuggestionEnabled: true }
            })
          }

          if (
            msg.request.agentProgressSummaries &&
            getFeatureValue_CACHED_MAY_BE_STALE('tengu_slate_prism', true)
          ) {
            setSdkAgentProgressSummariesEnabled(true)
          }

          initialized = true

          // If the auto-resume logic pre-enqueued a command, drain it now
          // that initialize has set up systemPrompt, agents, hooks, etc.
          if (hasCommandsInQueue()) {
            void runHeadlessTurn(state)
          }
        } else if (msg.request.subtype === 'set_permission_mode') {
          const m = msg.request // for typescript (TODO: use readonly types to avoid this)
          setAppState(prev => ({
            ...prev,
            toolPermissionContext: handleSetPermissionMode(
              m,
              msg.request_id,
              prev.toolPermissionContext,
              output,
            ),
            isUltraplanMode: m.ultraplan ?? prev.isUltraplanMode,
          }))
          // handleSetPermissionMode sends the control_response; the
          // notifySessionMetadataChanged that used to follow here is
          // now fired by onChangeAppState (with externalized mode name).
        } else if (msg.request.subtype === 'set_model') {
          const requestedModel = msg.request.model ?? 'default'
          const model =
            requestedModel === 'default'
              ? getDefaultMainLoopModel()
              : requestedModel
          state.activeUserSpecifiedModel = model
          setMainLoopModelOverride(model)
          notifySessionMetadataChanged({ model })
          injectModelSwitchBreadcrumbs(requestedModel, model)

          sendControlResponseSuccess(state, msg)
        } else if (msg.request.subtype === 'set_max_thinking_tokens') {
          if (msg.request.max_thinking_tokens === null) {
            options.thinkingConfig = undefined
          } else if (msg.request.max_thinking_tokens === 0) {
            options.thinkingConfig = { type: 'disabled' }
          } else {
            options.thinkingConfig = {
              type: 'enabled',
              budgetTokens: msg.request.max_thinking_tokens,
            }
          }
          sendControlResponseSuccess(state, msg)
        } else if (msg.request.subtype === 'mcp_status') {
          sendControlResponseSuccess(state, msg, {
            mcpServers: buildMcpServerStatuses(state),
          })
        } else if (msg.request.subtype === 'get_context_usage') {
          try {
            const appState = getAppState()
            const data = await collectContextData({
              messages: mutableMessages,
              getAppState,
              options: {
                mainLoopModel: getMainLoopModel(),
                tools: buildAllTools(state, appState),
                agentDefinitions: appState.agentDefinitions,
                customSystemPrompt: options.systemPrompt,
                appendSystemPrompt: options.appendSystemPrompt,
              },
            })
            sendControlResponseSuccess(state, msg, { ...data })
          } catch (error) {
            sendControlResponseError(state, msg, errorMessage(error))
          }
        } else if (msg.request.subtype === 'mcp_message') {
          // Handle MCP notifications from SDK servers
          const mcpRequest = msg.request as Record<string, unknown>
          const sdkClient = state.sdkClients.find(
            client => client.name === mcpRequest.server_name,
          )
          // Check client exists - dynamically added SDK servers may have
          // placeholder clients with null client until updateSdkMcp() runs
          if (
            sdkClient &&
            sdkClient.type === 'connected' &&
            sdkClient.client?.transport?.onmessage
          ) {
            sdkClient.client.transport.onmessage(
              mcpRequest.message as import('@modelcontextprotocol/client').JSONRPCMessage,
            )
          }
          sendControlResponseSuccess(state, msg)
        } else if (msg.request.subtype === 'rewind_files') {
          const appState = getAppState()
          const result = await handleRewindFiles(
            msg.request.user_message_id as UUID,
            appState,
            setAppState,
            msg.request.dry_run ?? false,
          )
          if (result.canRewind || msg.request.dry_run) {
            sendControlResponseSuccess(state, msg, result)
          } else {
            sendControlResponseError(
              state,
              msg,
              (result.error as string) ?? 'Unexpected error',
            )
          }
        } else if (msg.request.subtype === 'cancel_async_message') {
          const targetUuid = msg.request.message_uuid
          const removed = dequeueAllMatching(cmd => cmd.uuid === targetUuid)
          sendControlResponseSuccess(state, msg, {
            cancelled: removed.length > 0,
          })
        } else if (msg.request.subtype === 'seed_read_state') {
          // Client observed a Read that was later removed from context (e.g.
          // by snip), so transcript-based seeding missed it. Queued into
          // pendingSeeds; applied at the next clone-replace boundary.
          try {
            // expandPath: all other readFileState writers normalize (~, relative,
            // session cwd vs process cwd). FileEditTool looks up by expandPath'd
            // key — a verbatim client path would miss.
            const normalizedPath = expandPath(msg.request.path)
            // Check disk mtime before reading content. If the file changed
            // since the client's observation, readFile would return C_current
            // but we'd store it with the client's M_observed — getChangedFiles
            // then sees disk > cache.timestamp, re-reads, diffs C_current vs
            // C_current = empty, emits no attachment, and the model is never
            // told about the C_observed → C_current change. Skipping the seed
            // makes Edit fail "file not read yet" → forces a fresh Read.
            // Math.floor matches FileReadTool and getFileModificationTime.
            const diskMtime = Math.floor((await stat(normalizedPath)).mtimeMs)
            if (diskMtime <= msg.request.mtime) {
              const raw = await readFile(normalizedPath, 'utf-8')
              // Strip BOM + normalize CRLF→LF to match readFileInRange and
              // readFileSyncWithMetadata. FileEditTool's content-compare
              // fallback (for Windows mtime bumps without content change)
              // compares against LF-normalized disk reads.
              const content = (
                raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
              ).replaceAll('\r\n', '\n')
              pendingSeeds.set(normalizedPath, {
                content,
                timestamp: diskMtime,
                offset: undefined,
                limit: undefined,
              })
            }
          } catch {
            // ENOENT etc — skip seeding but still succeed
          }
          sendControlResponseSuccess(state, msg)
        } else if (msg.request.subtype === 'mcp_set_servers') {
          const { response, sdkServersChanged } = await applyMcpServerChanges(
            state,
            msg.request.servers as Record<
              string,
              McpServerConfigForProcessTransport
            >,
          )
          sendControlResponseSuccess(state, msg, response)

          // Connect SDK servers AFTER response to avoid deadlock
          if (sdkServersChanged) {
            void updateSdkMcp(state)
          }
        } else if (msg.request.subtype === 'reload_plugins') {
          try {
            const r = await refreshActivePlugins(setAppState)

            const sdkAgents = state.currentAgents.filter(
              a => a.source === 'flagSettings',
            )
            state.currentAgents = [
              ...r.agentDefinitions.allAgents,
              ...sdkAgents,
            ]

            // Reload succeeded — gather response data best-effort so a
            // read failure doesn't mask the successful state change.
            // allSettled so one failure doesn't discard the others.
            let plugins: SDKControlReloadPluginsResponse['plugins'] = []
            const [cmdsR, mcpR, pluginsR] = await Promise.allSettled([
              getCommands(cwd()),
              applyPluginMcpDiff(state),
              loadAllPluginsCacheOnly(),
            ])
            if (cmdsR.status === 'fulfilled') {
              state.currentCommands = cmdsR.value
            } else {
              logError(cmdsR.reason)
            }
            if (mcpR.status === 'rejected') {
              logError(mcpR.reason)
            }
            if (pluginsR.status === 'fulfilled') {
              plugins = pluginsR.value.enabled.map(p => ({
                name: p.name,
                path: p.path,
                source: p.source,
              }))
            } else {
              logError(pluginsR.reason)
            }

            sendControlResponseSuccess(state, msg, {
              commands: state.currentCommands
                .filter(cmd => cmd.userInvocable !== false)
                .map(cmd => ({
                  name: getCommandName(cmd),
                  description: formatDescriptionWithSource(cmd),
                  argumentHint: cmd.argumentHint || '',
                })),
              agents: state.currentAgents.map(a => ({
                name: a.agentType,
                description: a.whenToUse,
                model: a.model === 'inherit' ? undefined : a.model,
              })),
              plugins,
              mcpServers: buildMcpServerStatuses(
                state,
              ) as SDKControlReloadPluginsResponse['mcpServers'],
              error_count: r.error_count,
            } satisfies SDKControlReloadPluginsResponse)
          } catch (error) {
            sendControlResponseError(state, msg, errorMessage(error))
          }
        } else if (msg.request.subtype === 'mcp_reconnect') {
          const currentAppState = getAppState()
          const { serverName } = msg.request
          state.elicitationRegistered.delete(serverName)
          // Config-existence gate must cover the SAME sources as the
          // operations below. SDK-injected servers (query({mcpServers:{...}}))
          // and dynamically-added servers were missing here, so
          // toggleMcpServer/reconnect returned "Server not found" even though
          // the disconnect/reconnect would have worked (gh-31339 / CC-314).
          const config =
            getMcpConfigByName(serverName) ??
            mcpClients.find(c => c.name === serverName)?.config ??
            state.sdkClients.find(c => c.name === serverName)?.config ??
            state.dynamicMcpState.clients.find(c => c.name === serverName)
              ?.config ??
            currentAppState.mcp.clients.find(c => c.name === serverName)
              ?.config ??
            null
          if (!config) {
            sendControlResponseError(
              state,
              msg,
              `Server not found: ${serverName}`,
            )
          } else {
            const result = await reconnectMcpServerImpl(serverName, config)
            // Update appState.mcp with the new client, tools, commands, and resources
            const prefix = getMcpPrefix(serverName)
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                clients: prev.mcp.clients.map(c =>
                  c.name === serverName ? result.client : c,
                ),
                tools: [
                  ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                  ...result.tools,
                ],
                commands: [
                  ...reject(prev.mcp.commands, c =>
                    commandBelongsToServer(c, serverName),
                  ),
                  ...result.commands,
                ],
                resources:
                  result.resources && result.resources.length > 0
                    ? { ...prev.mcp.resources, [serverName]: result.resources }
                    : omit(prev.mcp.resources, serverName),
              },
            }))
            // Also update dynamicMcpState so run() picks up the new tools
            // on the next turn (run() reads dynamicMcpState, not appState)
            state.dynamicMcpState = {
              ...state.dynamicMcpState,
              clients: [
                ...state.dynamicMcpState.clients.filter(
                  c => c.name !== serverName,
                ),
                result.client,
              ],
              tools: [
                ...state.dynamicMcpState.tools.filter(
                  t => !t.name?.startsWith(prefix),
                ),
                ...result.tools,
              ],
            }
            if (result.client.type === 'connected') {
              registerElicitationHandlers(state, [result.client])
              reregisterChannelHandlerAfterReconnect(result.client)
              sendControlResponseSuccess(state, msg)
            } else {
              const errorMessage =
                result.client.type === 'failed'
                  ? (result.client.error ?? 'Connection failed')
                  : `Server status: ${result.client.type}`
              sendControlResponseError(state, msg, errorMessage)
            }
          }
        } else if (msg.request.subtype === 'mcp_toggle') {
          const currentAppState = getAppState()
          const { serverName, enabled } = msg.request
          state.elicitationRegistered.delete(serverName)
          // Gate must match the client-lookup spread below (which
          // includes sdkClients and dynamicMcpState.clients). Same fix as
          // mcp_reconnect above (gh-31339 / CC-314).
          const config =
            getMcpConfigByName(serverName) ??
            mcpClients.find(c => c.name === serverName)?.config ??
            state.sdkClients.find(c => c.name === serverName)?.config ??
            state.dynamicMcpState.clients.find(c => c.name === serverName)
              ?.config ??
            currentAppState.mcp.clients.find(c => c.name === serverName)
              ?.config ??
            null

          if (!config) {
            sendControlResponseError(
              state,
              msg,
              `Server not found: ${serverName}`,
            )
          } else if (!enabled) {
            // Disabling: persist + disconnect (matches TUI toggleMcpServer behavior)
            setMcpServerEnabled(serverName, false)
            const client = [
              ...mcpClients,
              ...state.sdkClients,
              ...state.dynamicMcpState.clients,
              ...currentAppState.mcp.clients,
            ].find(c => c.name === serverName)
            if (client && client.type === 'connected') {
              await clearServerCache(serverName, config)
            }
            // Update appState.mcp to reflect disabled status and remove tools/commands/resources
            const prefix = getMcpPrefix(serverName)
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                clients: prev.mcp.clients.map(c =>
                  c.name === serverName
                    ? { name: serverName, type: 'disabled' as const, config }
                    : c,
                ),
                tools: reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                commands: reject(prev.mcp.commands, c =>
                  commandBelongsToServer(c, serverName),
                ),
                resources: omit(prev.mcp.resources, serverName),
              },
            }))
            sendControlResponseSuccess(state, msg)
          } else {
            // Enabling: persist + reconnect
            setMcpServerEnabled(serverName, true)
            const result = await reconnectMcpServerImpl(serverName, config)
            // Update appState.mcp with the new client, tools, commands, and resources
            // This ensures the LLM sees updated tools after enabling the server
            const prefix = getMcpPrefix(serverName)
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                clients: prev.mcp.clients.map(c =>
                  c.name === serverName ? result.client : c,
                ),
                tools: [
                  ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                  ...result.tools,
                ],
                commands: [
                  ...reject(prev.mcp.commands, c =>
                    commandBelongsToServer(c, serverName),
                  ),
                  ...result.commands,
                ],
                resources:
                  result.resources && result.resources.length > 0
                    ? { ...prev.mcp.resources, [serverName]: result.resources }
                    : omit(prev.mcp.resources, serverName),
              },
            }))
            if (result.client.type === 'connected') {
              registerElicitationHandlers(state, [result.client])
              reregisterChannelHandlerAfterReconnect(result.client)
              sendControlResponseSuccess(state, msg)
            } else {
              const errorMessage =
                result.client.type === 'failed'
                  ? (result.client.error ?? 'Connection failed')
                  : `Server status: ${result.client.type}`
              sendControlResponseError(state, msg, errorMessage)
            }
          }
        } else if (req.subtype === 'channel_enable') {
          const currentAppState = getAppState()
          handleChannelEnable(
            msg.request_id,
            req.serverName as string,
            // Pool spread matches mcp_status — all three client sources.
            [
              ...currentAppState.mcp.clients,
              ...state.sdkClients,
              ...state.dynamicMcpState.clients,
            ],
            output,
          )
        } else if (req.subtype === 'mcp_authenticate') {
          const serverName = req.serverName as string
          const currentAppState = getAppState()
          const config =
            getMcpConfigByName(serverName) ??
            mcpClients.find(c => c.name === serverName)?.config ??
            currentAppState.mcp.clients.find(c => c.name === serverName)
              ?.config ??
            null
          if (!config) {
            sendControlResponseError(
              state,
              msg,
              `Server not found: ${serverName}`,
            )
          } else if (config.type !== 'sse' && config.type !== 'http') {
            sendControlResponseError(
              state,
              msg,
              `Server type "${config.type}" does not support OAuth authentication`,
            )
          } else {
            try {
              // Abort any previous in-flight OAuth flow for this server
              activeOAuthFlows.get(serverName as string)?.abort()
              const controller = new AbortController()
              activeOAuthFlows.set(serverName as string, controller)

              // Capture the auth URL from the callback
              let resolveAuthUrl: (url: string) => void
              const authUrlPromise = new Promise<string>(resolve => {
                resolveAuthUrl = resolve
              })

              // Start the OAuth flow in the background
              const oauthPromise = performMCPOAuthFlow(
                serverName as string,
                config,
                url => resolveAuthUrl!(url),
                controller.signal,
                {
                  skipBrowserOpen: true,
                  onWaitingForCallback: submit => {
                    oauthCallbackSubmitters.set(serverName as string, submit)
                  },
                },
              )

              // Wait for the auth URL (or the flow to complete without needing redirect)
              const authUrl = await Promise.race([
                authUrlPromise,
                oauthPromise.then(() => null as string | null),
              ])

              if (authUrl) {
                sendControlResponseSuccess(state, msg, {
                  authUrl,
                  requiresUserAction: true,
                })
              } else {
                sendControlResponseSuccess(state, msg, {
                  requiresUserAction: false,
                })
              }

              // Store auth-only promise for mcp_oauth_callback_url handler.
              // Don't swallow errors — the callback handler needs to detect
              // auth failures and report them to the caller.
              oauthAuthPromises.set(serverName, oauthPromise)

              // Handle background completion — reconnect after auth.
              // When manual callback is used, skip the reconnect here;
              // the extension's handleAuthDone → mcp_reconnect handles it
              // (which also updates dynamicMcpState for tool registration).
              const fullFlowPromise = oauthPromise
                .then(async () => {
                  // Don't reconnect if the server was disabled during the OAuth flow
                  if (isMcpServerDisabled(serverName as string)) {
                    return
                  }
                  // Skip reconnect if the manual callback path was used —
                  // handleAuthDone will do it via mcp_reconnect (which
                  // updates dynamicMcpState for tool registration).
                  if (oauthManualCallbackUsed.has(serverName as string)) {
                    return
                  }
                  // Reconnect the server after successful auth
                  const result = await reconnectMcpServerImpl(
                    serverName as string,
                    config,
                  )
                  const prefix = getMcpPrefix(serverName as string)
                  setAppState(prev => ({
                    ...prev,
                    mcp: {
                      ...prev.mcp,
                      clients: prev.mcp.clients.map(c =>
                        c.name === (serverName as string) ? result.client : c,
                      ),
                      tools: [
                        ...reject(prev.mcp.tools, t =>
                          t.name?.startsWith(prefix),
                        ),
                        ...result.tools,
                      ],
                      commands: [
                        ...reject(prev.mcp.commands, c =>
                          commandBelongsToServer(c, serverName as string),
                        ),
                        ...result.commands,
                      ],
                      resources:
                        result.resources && result.resources.length > 0
                          ? {
                              ...prev.mcp.resources,
                              [serverName as string]: result.resources,
                            }
                          : omit(prev.mcp.resources, serverName as string),
                    },
                  }))
                  // Also update dynamicMcpState so run() picks up the new tools
                  // on the next turn (run() reads dynamicMcpState, not appState)
                  state.dynamicMcpState = {
                    ...state.dynamicMcpState,
                    clients: [
                      ...state.dynamicMcpState.clients.filter(
                        c => c.name !== serverName,
                      ),
                      result.client,
                    ],
                    tools: [
                      ...state.dynamicMcpState.tools.filter(
                        t => !t.name?.startsWith(prefix),
                      ),
                      ...result.tools,
                    ],
                  }
                })
                .catch(error => {
                  logForDebugging(
                    `MCP OAuth failed for ${serverName as string}: ${error}`,
                    { level: 'error' },
                  )
                })
                .finally(() => {
                  // Clean up only if this is still the active flow
                  if (
                    activeOAuthFlows.get(serverName as string) === controller
                  ) {
                    activeOAuthFlows.delete(serverName as string)
                    oauthCallbackSubmitters.delete(serverName as string)
                    oauthManualCallbackUsed.delete(serverName as string)
                    oauthAuthPromises.delete(serverName as string)
                  }
                })
              void fullFlowPromise
            } catch (error) {
              sendControlResponseError(state, msg, errorMessage(error))
            }
          }
        } else if (req.subtype === 'mcp_oauth_callback_url') {
          const serverName = req.serverName as string
          const callbackUrl = req.callbackUrl as string
          const submit = oauthCallbackSubmitters.get(serverName)
          if (submit) {
            // Validate the callback URL before submitting. The submit
            // callback in auth.ts silently ignores URLs missing a code
            // param, which would leave the auth promise unresolved and
            // block the control message loop until timeout.
            let hasCodeOrError = false
            try {
              const parsed = new URL(callbackUrl as string | URL)
              hasCodeOrError =
                parsed.searchParams.has('code') ||
                parsed.searchParams.has('error')
            } catch {
              // Invalid URL
            }
            if (!hasCodeOrError) {
              sendControlResponseError(
                state,
                msg,
                'Invalid callback URL: missing authorization code. Please paste the full redirect URL including the code parameter.',
              )
            } else {
              oauthManualCallbackUsed.add(serverName)
              submit(callbackUrl as string)
              // Wait for auth (token exchange) to complete before responding.
              // Reconnect is handled by the extension via handleAuthDone →
              // mcp_reconnect (which updates dynamicMcpState for tools).
              const authPromise = oauthAuthPromises.get(serverName)
              if (authPromise) {
                try {
                  await authPromise
                  sendControlResponseSuccess(state, msg)
                } catch (error) {
                  sendControlResponseError(
                    state,
                    msg,
                    error instanceof Error
                      ? error.message
                      : 'OAuth authentication failed',
                  )
                }
              } else {
                sendControlResponseSuccess(state, msg)
              }
            }
          } else {
            sendControlResponseError(
              state,
              msg,
              `No active OAuth flow for server: ${serverName}`,
            )
          }
        } else if (req.subtype === 'claude_authenticate') {
          // Anthropic OAuth over the control channel. The SDK client owns
          // the user's browser (we're headless in -p mode); we hand back
          // both URLs and wait. Automatic URL → localhost listener catches
          // the redirect if the browser is on this host; manual URL → the
          // success page shows "code#state" for claude_oauth_callback.
          const loginWithClaudeAi = req.loginWithClaudeAi as boolean | undefined

          // Clean up any prior flow. cleanup() closes the localhost listener
          // and nulls the manual resolver. The prior `flow` promise is left
          // pending (AuthCodeListener.close() does not reject) but its object
          // graph becomes unreachable once the server handle is released and
          // is GC'd — no fd or port is held.
          state.claudeOAuth?.service.cleanup()

          logEvent('tengu_oauth_flow_start', {
            loginWithClaudeAi: (loginWithClaudeAi ?? true) as boolean | number,
          })

          const service = new OAuthService()
          let urlResolver!: (urls: {
            manualUrl: string
            automaticUrl: string
          }) => void
          const urlPromise = new Promise<{
            manualUrl: string
            automaticUrl: string
          }>(resolve => {
            urlResolver = resolve
          })

          const flow = service
            .startOAuthFlow(
              async (manualUrl, automaticUrl) => {
                // automaticUrl is always defined when skipBrowserOpen is set;
                // the signature is optional only for the existing single-arg callers.
                urlResolver({ manualUrl, automaticUrl: automaticUrl! })
              },
              {
                loginWithClaudeAi: (loginWithClaudeAi ?? true) as boolean,
                skipBrowserOpen: true,
              },
            )
            .then(async tokens => {
              // installOAuthTokens: performLogout (clear stale state) →
              // store profile → saveOAuthTokensIfNeeded → clearOAuthTokenCache
              // → clearAuthRelatedCaches. After this resolves, the memoized
              // getClaudeAIOAuthTokens in this process is invalidated; the
              // next API call re-reads keychain/file and works. No respawn.
              await installOAuthTokens(tokens)
              logEvent('tengu_oauth_success', {
                loginWithClaudeAi: (loginWithClaudeAi ?? true) as
                  | boolean
                  | number,
              })
            })
            .finally(() => {
              service.cleanup()
              if (state.claudeOAuth?.service === service) {
                state.claudeOAuth = null
              }
            })

          state.claudeOAuth = { service, flow }

          // Attach the rejection handler before awaiting so a synchronous
          // startOAuthFlow failure doesn't surface as an unhandled rejection.
          // The claude_oauth_callback handler re-awaits flow for the manual
          // path and surfaces the real error to the client.
          void flow.catch(err =>
            logForDebugging(`claude_authenticate flow ended: ${err}`, {
              level: 'info',
            }),
          )

          try {
            // Race against flow: if startOAuthFlow rejects before calling
            // the authURLHandler (e.g. AuthCodeListener.start() fails with
            // EACCES or fd exhaustion), urlPromise would pend forever and
            // wedge the stdin loop. flow resolving first is unreachable in
            // practice (it's suspended on the same urls we're waiting for).
            const { manualUrl, automaticUrl } = await Promise.race([
              urlPromise,
              flow.then(() => {
                throw new Error(
                  'OAuth flow completed without producing auth URLs',
                )
              }),
            ])
            sendControlResponseSuccess(state, msg, {
              manualUrl,
              automaticUrl,
            })
          } catch (error) {
            sendControlResponseError(state, msg, errorMessage(error))
          }
        } else if (
          req.subtype === 'claude_oauth_callback' ||
          req.subtype === 'claude_oauth_wait_for_completion'
        ) {
          if (!state.claudeOAuth) {
            sendControlResponseError(
              state,
              msg,
              'No active claude_authenticate flow',
            )
          } else {
            // Inject the manual code synchronously — must happen in stdin
            // message order so a subsequent claude_authenticate doesn't
            // replace the service before this code lands.
            if (req.subtype === 'claude_oauth_callback') {
              state.claudeOAuth.service.handleManualAuthCodeInput({
                authorizationCode: req.authorizationCode as string,
                state: req.state as string,
              })
            }
            // Detach the await — the stdin reader is serial and blocking
            // here deadlocks claude_oauth_wait_for_completion: flow may
            // only resolve via a future claude_oauth_callback on stdin,
            // which can't be read while we're parked. Capture the binding;
            // claudeOAuth is nulled in flow's own .finally.
            const { flow } = state.claudeOAuth
            void flow.then(
              () => {
                const accountInfo = getAccountInformation()
                sendControlResponseSuccess(state, msg, {
                  account: {
                    email: accountInfo?.email,
                    organization: accountInfo?.organization,
                    subscriptionType: accountInfo?.subscription,
                    tokenSource: accountInfo?.tokenSource,
                    apiKeySource: accountInfo?.apiKeySource,
                    apiProvider: getAPIProvider(),
                  },
                })
              },
              (error: unknown) =>
                sendControlResponseError(state, msg, errorMessage(error)),
            )
          }
        } else if (req.subtype === 'mcp_clear_auth') {
          const serverName = req.serverName as string
          const currentAppState = getAppState()
          const config =
            getMcpConfigByName(serverName) ??
            mcpClients.find(c => c.name === serverName)?.config ??
            currentAppState.mcp.clients.find(c => c.name === serverName)
              ?.config ??
            null
          if (!config) {
            sendControlResponseError(
              state,
              msg,
              `Server not found: ${serverName}`,
            )
          } else if (config.type !== 'sse' && config.type !== 'http') {
            sendControlResponseError(
              state,
              msg,
              `Cannot clear auth for server type "${config.type}"`,
            )
          } else {
            await revokeServerTokens(serverName, config)
            const result = await reconnectMcpServerImpl(serverName, config)
            const prefix = getMcpPrefix(serverName)
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                clients: prev.mcp.clients.map(c =>
                  c.name === (serverName as string) ? result.client : c,
                ),
                tools: [
                  ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                  ...result.tools,
                ],
                commands: [
                  ...reject(prev.mcp.commands, c =>
                    commandBelongsToServer(c, serverName),
                  ),
                  ...result.commands,
                ],
                resources:
                  result.resources && result.resources.length > 0
                    ? {
                        ...prev.mcp.resources,
                        [serverName]: result.resources,
                      }
                    : omit(prev.mcp.resources, serverName),
              },
            }))
            sendControlResponseSuccess(state, msg, {})
          }
        } else if (msg.request.subtype === 'apply_flag_settings') {
          // Snapshot the current model before applying — we need to detect
          // model switches so we can inject breadcrumbs and notify listeners.
          const prevModel = getMainLoopModel()

          // Merge the provided settings into the in-memory flag settings
          const existing = getFlagSettingsInline() ?? {}
          const incoming = msg.request.settings
          // Shallow-merge top-level keys; getSettingsForSource handles
          // the deep merge with file-based flag settings via mergeWith.
          // JSON serialization drops `undefined`, so callers use `null`
          // to signal "clear this key". Convert nulls to deletions so
          // SettingsSchema().safeParse() doesn't reject the whole object
          // (z.string().optional() accepts string | undefined, not null).
          const merged = { ...existing, ...incoming }
          for (const key of Object.keys(merged)) {
            if (merged[key as keyof typeof merged] === null) {
              delete merged[key as keyof typeof merged]
            }
          }
          setFlagSettingsInline(merged)
          // Route through notifyChange so fanOut() resets the settings cache
          // before listeners run. The subscriber at :392 calls
          // applySettingsChange for us. Pre-#20625 this was a direct
          // applySettingsChange() call that relied on its own internal reset —
          // now that the reset is centralized in fanOut, a direct call here
          // would read stale cached settings and silently drop the update.
          // Bonus: going through notifyChange also tells the other subscribers
          // (loadPluginHooks, sandbox-adapter) about the change, which the
          // previous direct call skipped.
          settingsChangeDetector.notifyChange('flagSettings')

          // If the incoming settings include a model change, update the
          // override so getMainLoopModel() reflects it. The override has
          // higher priority than the settings cascade in
          // getUserSpecifiedModelSetting(), so without this update,
          // getMainLoopModel() returns the stale override and the model
          // change is silently ignored (matching set_model at :2811).
          if ('model' in incoming) {
            if (incoming.model != null) {
              setMainLoopModelOverride(String(incoming.model))
            } else {
              setMainLoopModelOverride(undefined)
            }
          }

          // If the model changed, inject breadcrumbs so the model sees the
          // mid-conversation switch, and notify metadata listeners (CCR).
          const newModel = getMainLoopModel()
          if (newModel !== prevModel) {
            state.activeUserSpecifiedModel = newModel
            const modelArg = incoming.model ? String(incoming.model) : 'default'
            notifySessionMetadataChanged({ model: newModel })
            injectModelSwitchBreadcrumbs(modelArg, newModel)
          }

          sendControlResponseSuccess(state, msg)
        } else if (msg.request.subtype === 'get_settings') {
          const currentAppState = getAppState()
          const model = getMainLoopModel()
          // modelSupportsEffort gate matches claude.ts — applied.effort must
          // mirror what actually goes to the API, not just what's configured.
          const effort = modelSupportsEffort(model)
            ? resolveAppliedEffort(model, currentAppState.effortValue)
            : undefined
          sendControlResponseSuccess(state, msg, {
            ...getSettingsWithSources(),
            applied: {
              model,
              // Numeric effort (ant-only) → null; SDK schema is string-level only.
              effort: typeof effort === 'string' ? effort : null,
            },
          })
        } else if (msg.request.subtype === 'stop_task') {
          const { task_id: taskId } = msg.request
          try {
            await stopTask(taskId, {
              getAppState,
              setAppState,
            })
            sendControlResponseSuccess(state, msg, {})
          } catch (error) {
            sendControlResponseError(state, msg, errorMessage(error))
          }
        } else if (req.subtype === 'generate_session_title') {
          // Fire-and-forget so the Haiku call does not block the stdin loop
          // (which would delay processing of subsequent user messages /
          // interrupts for the duration of the API roundtrip).
          const description = req.description as string
          const persist = req.persist as boolean
          // Reuse the live controller only if it has not already been aborted
          // (e.g. by interrupt()); an aborted signal would cause queryHaiku to
          // immediately throw APIUserAbortError → {title: null}.
          const titleSignal = (
            state.abortController && !state.abortController.signal.aborted
              ? state.abortController
              : createAbortController()
          ).signal
          void (async () => {
            try {
              const title = await generateSessionTitle(description, titleSignal)
              if (title && persist) {
                try {
                  saveAiGeneratedTitle(getSessionId() as UUID, title)
                } catch (e) {
                  logError(e)
                }
              }
              sendControlResponseSuccess(state, msg, { title })
            } catch (e) {
              // Unreachable in practice — generateSessionTitle wraps its
              // own body and returns null, saveAiGeneratedTitle is wrapped
              // above. Propagate (not swallow) so unexpected failures are
              // visible to the SDK caller (hostComms.ts catches and logs).
              sendControlResponseError(state, msg, errorMessage(e))
            }
          })()
        } else if (req.subtype === 'side_question') {
          // Same fire-and-forget pattern as generate_session_title above —
          // the forked agent's API roundtrip must not block the stdin loop.
          //
          // The snapshot captured by stopHooks (for querySource === 'sdk')
          // holds the exact systemPrompt/userContext/systemContext/messages
          // sent on the last main-thread turn. Reusing them gives a byte-
          // identical prefix → prompt cache hit.
          //
          // Fallback (resume before first turn completes — no snapshot yet):
          // rebuild from scratch. buildSideQuestionFallbackParams mirrors
          // QueryEngine.ts:ask()'s system prompt assembly (including
          // --system-prompt / --append-system-prompt) so the rebuilt prefix
          // matches in the common case. May still miss the cache for
          // coordinator mode or memory-mechanics extras — acceptable, the
          // alternative is the side question failing entirely.
          const question = req.question as string
          void (async () => {
            try {
              const saved = getLastCacheSafeParams()
              const cacheSafeParams = saved
                ? {
                    ...saved,
                    // If the last turn was interrupted, the snapshot holds an
                    // already-aborted controller; createChildAbortController in
                    // createSubagentContext would propagate it and the fork
                    // would die before sending a request. The controller is
                    // not part of the cache key — swapping in a fresh one is
                    // safe. Same guard as generate_session_title above.
                    toolUseContext: {
                      ...saved.toolUseContext,
                      abortController: createAbortController(),
                    },
                  }
                : await buildSideQuestionFallbackParams({
                    tools: buildAllTools(state, getAppState()),
                    commands: state.currentCommands,
                    mcpClients: [
                      ...getAppState().mcp.clients,
                      ...state.sdkClients,
                      ...state.dynamicMcpState.clients,
                    ],
                    messages: mutableMessages,
                    readFileState: state.readFileState,
                    getAppState,
                    setAppState,
                    customSystemPrompt: options.systemPrompt,
                    appendSystemPrompt: options.appendSystemPrompt,
                    thinkingConfig: options.thinkingConfig,
                    agents: state.currentAgents,
                  })
              const result = await runSideQuestion({
                question,
                cacheSafeParams,
              })
              sendControlResponseSuccess(state, msg, {
                response: result.response,
              })
            } catch (e) {
              sendControlResponseError(state, msg, errorMessage(e))
            }
          })()
        } else if (
          (feature('PROACTIVE') || feature('KAIROS')) &&
          (msg.request as { subtype: string }).subtype === 'set_proactive'
        ) {
          const req = msg.request as unknown as {
            subtype: string
            enabled: boolean
          }
          if (req.enabled) {
            if (!proactiveModule!.isProactiveActive()) {
              proactiveModule!.activateProactive('command')
              scheduleProactiveTick!(state)
            }
          } else {
            proactiveModule!.deactivateProactive()
          }
          sendControlResponseSuccess(state, msg)
        } else {
          // Unknown control request subtype — send an error response so
          // the caller doesn't hang waiting for a reply that never comes.
          sendControlResponseError(
            state,
            msg,
            `Unsupported control request subtype: ${(msg.request as { subtype: string }).subtype}`,
          )
        }
        continue
      } else if (message.type === 'control_response') {
        // Replay control_response messages when replay mode is enabled
        if (options.replayUserMessages) {
          output.enqueue(message as StdoutMessage)
        }
        continue
      } else if (message.type === 'keep_alive') {
        // Silently ignore keep-alive messages
        continue
      } else if (message.type === 'update_environment_variables') {
        // Handled in structuredIO.ts, but TypeScript needs the type guard
        continue
      } else if (message.type === 'assistant' || message.type === 'system') {
        // History replay from bridge: inject into mutableMessages as
        // conversation context so the model sees prior turns.
        const internalMsgs = toInternalMessages([message as SDKMessage])
        mutableMessages.push(...internalMsgs)
        // Echo assistant messages back so CCR displays them
        if (message.type === 'assistant' && options.replayUserMessages) {
          output.enqueue(message as StdoutMessage)
        }
        continue
      }
      // After handling control, keep-alive, env-var, assistant, and system
      // messages above, only user messages should remain.
      if (message.type !== 'user') {
        continue
      }
      // Type assertion: after the type guard, message is a user message.
      // The union with SDKMessage (any) prevents proper narrowing.
      const userMsg = message as SDKUserMessage

      // First prompt message implicitly initializes if not already done.
      initialized = true

      // Check for duplicate user message - skip if already processed
      if (userMsg.uuid) {
        const sessionId = getSessionId() as UUID
        const existsInSession = await doesMessageExistInSession(
          sessionId,
          userMsg.uuid as UUID,
        )

        // Check both historical duplicates (from file) and runtime duplicates (this session)
        if (existsInSession || receivedMessageUuids.has(userMsg.uuid as UUID)) {
          logForDebugging(`Skipping duplicate user message: ${userMsg.uuid}`)
          // Send acknowledgment for duplicate message if replay mode is enabled
          if (options.replayUserMessages) {
            logForDebugging(
              `Sending acknowledgment for duplicate user message: ${userMsg.uuid}`,
            )
            output.enqueue({
              type: 'user',
              content: (userMsg.message as { content?: string })?.content ?? '',
              message: userMsg.message as unknown,
              session_id: sessionId,
              parent_tool_use_id: null,
              uuid: userMsg.uuid as string,
              timestamp: (userMsg as { timestamp?: string }).timestamp,
              isReplay: true,
            } as unknown as StdoutMessage)
          }
          // Historical dup = transcript already has this turn's output, so it
          // ran but its lifecycle was never closed (interrupted before ack).
          // Runtime dups don't need this — the original enqueue path closes them.
          if (existsInSession) {
            notifyCommandLifecycle(userMsg.uuid as string, 'completed')
          }
          // Don't enqueue duplicate messages for execution
          continue
        }

        // Track this UUID to prevent runtime duplicates
        trackReceivedMessageUuid(userMsg.uuid as UUID)
      }

      enqueue({
        mode: 'prompt' as const,
        // file_attachments rides the protobuf catchall from the web composer.
        // Same-ref no-op when absent (no 'file_attachments' key).
        value: await resolveAndPrepend(
          userMsg,
          (userMsg.message as { content: ContentBlockParam[] }).content,
        ),
        uuid: userMsg.uuid as `${string}-${string}-${string}-${string}-${string}`,
        priority: (userMsg as { priority?: string })
          .priority as import('src/types/textInputTypes.js').QueuePriority,
      })
      // Increment prompt count for attribution tracking and save snapshot
      // The snapshot persists promptCount so it survives compaction
      if (feature('COMMIT_ATTRIBUTION')) {
        setAppState(prev => ({
          ...prev,
          attribution: incrementPromptCount(prev.attribution, snapshot => {
            void recordAttributionSnapshot(snapshot).catch(error => {
              logForDebugging(`Attribution: Failed to save snapshot: ${error}`)
            })
          }),
        }))
      }
      void runHeadlessTurn(state)
    }
    state.inputClosed = true
    state.cronScheduler?.stop()
    if (!state.running) {
      await finalizeHeadlessOutput(state)
    }
  })()

  return output
}
