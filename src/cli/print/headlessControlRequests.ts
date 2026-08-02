/**
 * The headless control-request chain.
 *
 * One `else if` ladder over `msg.request.subtype`, exactly as it sat inside
 * `runHeadlessStreaming`'s stdin reader. The MCP connection-lifecycle and
 * OAuth branches delegate to their own modules; everything else is handled
 * here.
 *
 * `end_session` used to `break` the stdin for-await directly. It now returns
 * 'stop' and the reader breaks — same effect, but the chain no longer needs
 * to sit lexically inside the loop.
 */
import { feature } from 'bun:bundle'
import { type UUID } from 'crypto'
import { readFile, stat } from 'fs/promises'
import { cwd } from 'process'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { formatDescriptionWithSource, getCommandName } from 'src/commands.js'
import { getCommands } from 'src/commands.js'
import { collectContextData } from 'src/commands/context/context-noninteractive.js'
import { LOCAL_COMMAND_STDOUT_TAG } from 'src/constants/xml.js'
import type { McpServerConfigForProcessTransport } from 'src/entrypoints/agentSdkTypes.js'
import type {
  SDKControlReloadPluginsResponse,
  SDKControlRequest,
  StdoutMessage,
} from 'src/entrypoints/sdk/controlTypes.js'
import {
  getFlagSettingsInline,
  getSessionId,
  setFlagSettingsInline,
  setMainLoopModelOverride,
  setSdkAgentProgressSummariesEnabled,
} from 'src/bootstrap/state.js'
import { stopTask } from 'src/tasks/stopTask.js'
import { loadAllPluginsCacheOnly } from 'src/utils/plugins/pluginLoader.js'
import { refreshActivePlugins } from 'src/utils/plugins/refresh.js'
import { createModelSwitchBreadcrumbs } from 'src/utils/messages.js'
import { createAbortController } from 'src/utils/process/abortController.js'
import { errorMessage } from 'src/utils/errors.js'
import { logError } from 'src/utils/telemetry/log.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import {
  dequeueAllMatching,
  hasCommandsInQueue,
} from 'src/utils/session/messageQueueManager.js'
import { expandPath } from 'src/utils/filesystem/path.js'
import {
  getDefaultMainLoopModel,
  getMainLoopModel,
  modelDisplayString,
} from 'src/utils/model/model.js'
import { modelSupportsEffort, resolveAppliedEffort } from 'src/utils/effort.js'
import { getSettingsWithSources } from 'src/utils/settings/settings.js'
import { settingsChangeDetector } from 'src/utils/settings/changeDetector.js'
import { notifySessionMetadataChanged } from 'src/utils/session/sessionState.js'
import { buildSideQuestionFallbackParams } from 'src/utils/session/queryContext.js'
import { runSideQuestion } from 'src/utils/session/sideQuestion.js'
import { generateSessionTitle } from 'src/utils/session/sessionTitle.js'
import { getLastCacheSafeParams } from 'src/utils/collections/cacheSafeParamsSlot.js'
import { saveAiGeneratedTitle } from 'src/utils/sessionStorage.js'
import {
  handleInitializeRequest,
  handleRewindFiles,
  handleSetPermissionMode,
} from './controlHandlers.js'
import {
  applyMcpServerChanges,
  buildAllTools,
  buildMcpServerStatuses,
  updateSdkMcp,
} from './headlessMcpRuntime.js'
import { applyPluginMcpDiff } from './headlessPlugins.js'
import {
  handleChannelEnableRequest,
  handleMcpReconnect,
  handleMcpToggle,
} from './headlessMcpControl.js'
import {
  handleClaudeAuthenticate,
  handleClaudeOAuthCallback,
  handleMcpAuthenticate,
  handleMcpClearAuth,
  handleMcpOAuthCallbackUrl,
} from './headlessOAuthControl.js'
import {
  sendControlResponseError,
  sendControlResponseSuccess,
} from './headlessControlResponses.js'
import { scheduleProactiveTick } from './headlessTurnLoop.js'
import { runHeadlessTurn } from './headlessTurnLoop.js'
import { proactiveModule } from './runtime.js'
import type { HeadlessRunState } from './headlessRunState.js'

/**
 * Push the `<local-command-stdout>` breadcrumbs a mid-conversation model
 * switch produces into the transcript, and replay the visible ones so SDK
 * consumers see the switch.
 */
function injectModelSwitchBreadcrumbs(
  state: HeadlessRunState,
  modelArg: string,
  resolvedModel: string,
): void {
  const breadcrumbs = createModelSwitchBreadcrumbs(
    modelArg,
    modelDisplayString(resolvedModel),
  )
  state.mutableMessages.push(...breadcrumbs)
  for (const crumb of breadcrumbs) {
    if (
      typeof crumb.message.content === 'string' &&
      crumb.message.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`)
    ) {
      state.output.enqueue({
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

/**
 * Handle one control_request. Returns 'stop' when the session should stop
 * reading stdin (end_session), 'continue' otherwise.
 */
export async function handleHeadlessControlRequest(
  state: HeadlessRunState,
  message: unknown,
): Promise<'continue' | 'stop'> {
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
      state.setAppState(prev => ({
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
    state.suggestionState.abortController?.abort()
    state.suggestionState.abortController = null
    state.suggestionState.lastEmitted = null
    state.suggestionState.pendingSuggestion = null
    sendControlResponseSuccess(state, msg)
  } else if (req.subtype === 'end_session') {
    logForDebugging(
      `[print.ts] end_session received, reason=${req.reason ?? 'unspecified'}`,
    )
    if (state.abortController) {
      state.abortController.abort()
    }
    state.suggestionState.abortController?.abort()
    state.suggestionState.abortController = null
    state.suggestionState.lastEmitted = null
    state.suggestionState.pendingSuggestion = null
    sendControlResponseSuccess(state, msg)
    // exits the stdin for-await → falls through to inputClosed=true drain
    return 'stop'
  } else if (msg.request.subtype === 'initialize') {
    // SDK MCP server names from the initialize message
    // Populated by both browser and ProcessTransport sessions
    if (msg.request.sdkMcpServers && msg.request.sdkMcpServers.length > 0) {
      for (const serverName of msg.request.sdkMcpServers) {
        // Create placeholder config for SDK MCP servers
        // The actual server connection is managed by the SDK Query class
        state.sdkMcpConfigs[serverName] = {
          type: 'sdk',
          name: serverName,
        }
      }
    }

    await handleInitializeRequest(
      msg.request,
      msg.request_id,
      state.initialized,
      state.output,
      state.initialCommands,
      state.modelInfos,
      state.structuredIO,
      !!state.options.enableAuthStatus,
      state.options,
      state.initialAgents,
      state.getAppState,
    )

    // Enable prompt suggestions in AppState when SDK consumer opts in.
    // shouldEnablePromptSuggestion() returns false for non-interactive
    // sessions, but the SDK consumer explicitly requested suggestions.
    if (msg.request.promptSuggestions) {
      state.setAppState(prev => {
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

    state.initialized = true

    // If the auto-resume logic pre-enqueued a command, drain it now
    // that initialize has set up systemPrompt, state.initialAgents, hooks, etc.
    if (hasCommandsInQueue()) {
      void runHeadlessTurn(state)
    }
  } else if (msg.request.subtype === 'set_permission_mode') {
    const m = msg.request // for typescript (TODO: use readonly types to avoid this)
    state.setAppState(prev => ({
      ...prev,
      toolPermissionContext: handleSetPermissionMode(
        m,
        msg.request_id,
        prev.toolPermissionContext,
        state.output,
      ),
      isUltraplanMode: m.ultraplan ?? prev.isUltraplanMode,
    }))
    // handleSetPermissionMode sends the control_response; the
    // notifySessionMetadataChanged that used to follow here is
    // now fired by onChangeAppState (with externalized mode name).
  } else if (msg.request.subtype === 'set_model') {
    const requestedModel = msg.request.model ?? 'default'
    const model =
      requestedModel === 'default' ? getDefaultMainLoopModel() : requestedModel
    state.activeUserSpecifiedModel = model
    setMainLoopModelOverride(model)
    notifySessionMetadataChanged({ model })
    injectModelSwitchBreadcrumbs(state, requestedModel, model)

    sendControlResponseSuccess(state, msg)
  } else if (msg.request.subtype === 'set_max_thinking_tokens') {
    if (msg.request.max_thinking_tokens === null) {
      state.options.thinkingConfig = undefined
    } else if (msg.request.max_thinking_tokens === 0) {
      state.options.thinkingConfig = { type: 'disabled' }
    } else {
      state.options.thinkingConfig = {
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
      const appState = state.getAppState()
      const data = await collectContextData({
        messages: state.mutableMessages,
        getAppState: state.getAppState,
        options: {
          mainLoopModel: getMainLoopModel(),
          tools: buildAllTools(state, appState),
          agentDefinitions: appState.agentDefinitions,
          customSystemPrompt: state.options.systemPrompt,
          appendSystemPrompt: state.options.appendSystemPrompt,
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
    const appState = state.getAppState()
    const result = await handleRewindFiles(
      msg.request.user_message_id as UUID,
      appState,
      state.setAppState,
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
    // state.pendingSeeds; applied at the next clone-replace boundary.
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
        state.pendingSeeds.set(normalizedPath, {
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
      msg.request.servers as Record<string, McpServerConfigForProcessTransport>,
    )
    sendControlResponseSuccess(state, msg, response)

    // Connect SDK servers AFTER response to avoid deadlock
    if (sdkServersChanged) {
      void updateSdkMcp(state)
    }
  } else if (msg.request.subtype === 'reload_plugins') {
    try {
      const r = await refreshActivePlugins(state.setAppState)

      const sdkAgents = state.currentAgents.filter(
        a => a.source === 'flagSettings',
      )
      state.currentAgents = [...r.agentDefinitions.allAgents, ...sdkAgents]

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
    await handleMcpReconnect(state, msg, msg.request)
  } else if (msg.request.subtype === 'mcp_toggle') {
    await handleMcpToggle(state, msg, msg.request)
  } else if (req.subtype === 'channel_enable') {
    handleChannelEnableRequest(state, msg, req)
  } else if (req.subtype === 'mcp_authenticate') {
    await handleMcpAuthenticate(state, msg, req)
  } else if (req.subtype === 'mcp_oauth_callback_url') {
    await handleMcpOAuthCallbackUrl(state, msg, req)
  } else if (req.subtype === 'claude_authenticate') {
    await handleClaudeAuthenticate(state, msg, req)
  } else if (
    req.subtype === 'claude_oauth_callback' ||
    req.subtype === 'claude_oauth_wait_for_completion'
  ) {
    await handleClaudeOAuthCallback(state, msg, req)
  } else if (req.subtype === 'mcp_clear_auth') {
    await handleMcpClearAuth(state, msg, req)
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
      injectModelSwitchBreadcrumbs(state, modelArg, newModel)
    }

    sendControlResponseSuccess(state, msg)
  } else if (msg.request.subtype === 'get_settings') {
    const currentAppState = state.getAppState()
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
        getAppState: state.getAppState,
        setAppState: state.setAppState,
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
              tools: buildAllTools(state, state.getAppState()),
              commands: state.currentCommands,
              mcpClients: [
                ...state.getAppState().mcp.clients,
                ...state.sdkClients,
                ...state.dynamicMcpState.clients,
              ],
              messages: state.mutableMessages,
              readFileState: state.readFileState,
              getAppState: state.getAppState,
              setAppState: state.setAppState,
              customSystemPrompt: state.options.systemPrompt,
              appendSystemPrompt: state.options.appendSystemPrompt,
              thinkingConfig: state.options.thinkingConfig,
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
  return 'continue'
}
