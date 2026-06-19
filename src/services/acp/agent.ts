/**
 * ACP Agent implementation — bridges ACP protocol methods to Claude Code's
 * internal QueryEngine / query() pipeline.
 *
 * Architecture: Uses internal QueryEngine (not @anthropic-ai/claude-agent-sdk)
 * to directly run queries, with a bridge layer converting SDKMessage → ACP SessionUpdate.
 */
import type {
  Agent,
  AgentSideConnection,
  InitializeRequest,
  InitializeResponse,
  AuthenticateRequest,
  AuthenticateResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
  LoadSessionRequest,
  LoadSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  ClientCapabilities,
  SessionModeState,
  SessionModelState,
  SessionConfigOption,
} from '@agentclientprotocol/sdk'
import { randomUUID, type UUID } from 'node:crypto'
import { dirname } from 'node:path'
import * as path from 'node:path'
import type { Message } from '../../types/message.js'
import { deserializeMessages } from '../../utils/conversationRecovery.js'
import {
  getLastSessionLog,
  sessionIdExists,
} from '../../utils/sessionStorage.js'
import { QueryEngine } from '../../QueryEngine.js'
import type { QueryEngineConfig } from '../../QueryEngine.js'
import type { Tools } from '../../Tool.js'
import { getTools } from '../../tools.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { PermissionMode } from '../../types/permissions.js'
import type { Command } from '../../types/command.js'
import { getCommands } from '../../commands.js'
import { getAgentDefinitionsWithOverrides } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import {
  setOriginalCwd,
  switchSession,
  getSessionProjectDir,
} from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
import { enableConfigs } from '../../utils/config.js'
import { FileStateCache } from '../../utils/fileStateCache.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { AppState } from '../../state/AppStateStore.js'
import { createAcpCanUseTool } from './permissions.js'
import {
  forwardSessionUpdates,
  replayHistoryMessages,
  type ToolUseCache,
} from './bridge.js'
import {
  resolvePermissionMode,
  computeSessionFingerprint,
  sanitizeTitle,
} from './utils.js'
import { promptToQueryInput } from './promptConversion.js'
import { listSessionsImpl } from '../../utils/listSessionsImpl.js'
import {
  resolveSessionFilePath,
  readSessionLite,
  extractJsonStringField,
} from '../../utils/sessionStoragePortable.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { getModelOptions } from '../../utils/model/modelOptions.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'

// ── Session state ─────────────────────────────────────────────────

type AcpSession = {
  queryEngine: QueryEngine
  cancelled: boolean
  cancelGeneration: number
  cwd: string
  sessionFingerprint: string
  modes: SessionModeState
  models: SessionModelState
  configOptions: SessionConfigOption[]
  promptRunning: boolean
  pendingMessages: Map<string, PendingPrompt>
  pendingQueue: string[]
  pendingQueueHead: number
  toolUseCache: ToolUseCache
  clientCapabilities?: ClientCapabilities
  appState: AppState
  commands: Command[]
}

type PendingPrompt = {
  resolve: (cancelled: boolean) => void
}

// ── Agent class ───────────────────────────────────────────────────

export class AcpAgent implements Agent {
  private conn: AgentSideConnection
  sessions = new Map<string, AcpSession>()
  private clientCapabilities?: ClientCapabilities

  constructor(conn: AgentSideConnection) {
    this.conn = conn
  }

  // ── initialize ────────────────────────────────────────────────

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = params.clientCapabilities

    return {
      protocolVersion: 1,
      // Explicit empty authMethods signals "no authentication required" to
      // Clients rather than "capability unknown". Matches authenticate() no-op.
      authMethods: [],
      agentInfo: {
        name: 'claude-code',
        title: 'Claude Code',
        version:
          typeof (globalThis as unknown as Record<string, unknown>).MACRO ===
            'object' &&
          (globalThis as unknown as Record<string, Record<string, unknown>>)
            .MACRO !== null
            ? String(
                (
                  (
                    globalThis as unknown as Record<
                      string,
                      Record<string, unknown>
                    >
                  ).MACRO as Record<string, unknown>
                ).VERSION ?? '0.0.0',
              )
            : '0.0.0',
      },
      agentCapabilities: {
        _meta: {
          claudeCode: {
            promptQueueing: true,
            // session/fork is UNSTABLE — not part of stable v1 SessionCapabilities.
            // Advertise via _meta namespace per extensibility.mdx "Advertising
            // Custom Capabilities" instead of the standard sessionCapabilities map.
            forkSession: true,
          },
        },
        // image:false — promptToQueryInput() does not parse ContentBlock::Image
        // blocks yet. Re-enable only after multimodal query input support lands.
        promptCapabilities: {
          image: false,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        loadSession: true,
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {},
        },
      },
    }
  }

  // ── authenticate ──────────────────────────────────────────────

  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<AuthenticateResponse> {
    // No authentication required — this is a self-hosted/custom deployment
    return {}
  }

  // ── newSession ────────────────────────────────────────────────

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const result = await this.createSession(params)
    this.scheduleAvailableCommandsUpdate(result.sessionId)
    return result
  }

  // ── resumeSession ──────────────────────────────────────────────

  async unstable_resumeSession(
    params: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    // Per session-setup.mdx "Resuming a Session": the Agent MUST NOT replay the
    // conversation history via session/update notifications before responding.
    // Only restore context + MCP connections, then return immediately. This
    // differs from session/load which DOES replay history.
    const result = await this.getOrCreateSession({ ...params, replay: false })
    this.scheduleAvailableCommandsUpdate(result.sessionId)
    return result
  }

  // ── loadSession ────────────────────────────────────────────────

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const result = await this.getOrCreateSession(params)
    this.scheduleAvailableCommandsUpdate(result.sessionId)
    return result
  }

  // ── listSessions ───────────────────────────────────────────────

  async listSessions(
    params: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    // Pagination is not implemented: we always return all available sessions
    // for the requested cwd (no nextCursor). Per session-list.mdx the Agent
    // SHOULD return an error if the cursor is invalid, so explicitly reject
    // any client-supplied cursor rather than silently accepting it.
    if (params.cursor !== undefined && params.cursor !== null) {
      throw new Error(
        'Pagination cursor not supported: listSessions returns all results in a single page.',
      )
    }

    const candidates = await listSessionsImpl({
      dir: params.cwd ?? undefined,
    })

    const sessions = []
    for (const candidate of candidates) {
      if (!candidate.cwd) continue
      // Only include title when non-empty; schema allows null/omitted title.
      const title = sanitizeTitle(candidate.summary ?? '')
      sessions.push({
        sessionId: candidate.sessionId,
        cwd: candidate.cwd,
        ...(title ? { title } : {}),
        updatedAt: new Date(candidate.lastModified).toISOString(),
      })
    }

    return { sessions }
  }

  // ── forkSession ────────────────────────────────────────────────

  async unstable_forkSession(
    params: ForkSessionRequest,
  ): Promise<ForkSessionResponse> {
    // Load the source session's messages so the fork actually branches from
    // the source conversation rather than starting a blank session. Per the
    // unstable ForkSessionRequest, params.sessionId is the ID to fork from.
    let initialMessages: Message[] | undefined
    try {
      const log = await getLastSessionLog(params.sessionId as UUID)
      if (log && log.messages.length > 0) {
        initialMessages = deserializeMessages(log.messages)
      }
    } catch (err) {
      console.error('[ACP] fork source load failed:', err)
    }
    const response = await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        _meta: params._meta,
      },
      { initialMessages },
    )
    this.scheduleAvailableCommandsUpdate(response.sessionId)
    return response
  }

  // ── closeSession ───────────────────────────────────────────────

  async unstable_closeSession(
    params: CloseSessionRequest,
  ): Promise<CloseSessionResponse> {
    const session = this.sessions.get(params.sessionId)
    if (!session) {
      throw new Error('Session not found')
    }
    await this.teardownSession(params.sessionId)
    return {}
  }

  // ── prompt ────────────────────────────────────────────────────

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId)
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`)
    }

    // Extract text/image content from the prompt
    const promptInput = promptToQueryInput(params.prompt)

    // Per prompt-turn.mdx, `prompt` is a required ContentBlock[] and an
    // effectively-empty prompt is malformed input — reject it with an
    // invalid_params error rather than fabricating a successful end_turn.
    if (!promptInput.trim()) {
      throw new Error('Prompt content is empty')
    }

    const promptCancelGeneration = session.cancelGeneration

    // Handle prompt queuing — if a prompt is already running, queue this one
    if (session.promptRunning) {
      const promptUuid = randomUUID()
      const cancelled = await new Promise<boolean>(resolve => {
        session.pendingQueue.push(promptUuid)
        session.pendingMessages.set(promptUuid, { resolve })
      })
      if (cancelled) {
        return { stopReason: 'cancelled' }
      }
    }

    if (session.cancelGeneration !== promptCancelGeneration) {
      return { stopReason: 'cancelled' }
    }

    // Reset cancellation only when this prompt is about to run. Queued prompts
    // must not clear the cancellation state for the active prompt.
    session.cancelled = false
    session.promptRunning = true

    try {
      // Reset the query engine's abort controller for a fresh query.
      // After a previous interrupt(), the internal controller is stuck in
      // aborted state — without this, submitMessage() fails immediately.
      session.queryEngine.resetAbortController()
      // Switch global session state so recordTranscript writes to the correct
      // session file. Without this, multi-session scenarios (or creating a new
      // session after another) write transcript data to the wrong file.
      switchSession(params.sessionId as SessionId, getSessionProjectDir())

      const sdkMessages = session.queryEngine.submitMessage(promptInput)

      const { stopReason, usage } = await forwardSessionUpdates(
        params.sessionId,
        sdkMessages,
        this.conn,
        session.queryEngine.getAbortSignal(),
        session.toolUseCache,
        this.clientCapabilities,
        session.cwd,
        () => session.cancelled,
      )

      // If the session was cancelled during processing, return cancelled
      if (session.cancelled) {
        return { stopReason: 'cancelled' }
      }

      // Emit a session_info_update so Clients learn the session's display
      // title / last-activity timestamp via the stable v1 session/update
      // channel. The title is derived from the first user prompt.
      await this.maybeEmitSessionInfoUpdate(params.sessionId, promptInput)

      // Per extensibility.mdx:39 the root of PromptResponse is reserved —
      // stable v1 defines only `stopReason` (+ optional `_meta`). Token usage
      // is therefore carried under the `_meta.claudeCode.usage` extension
      // namespace rather than as a non-spec root field. thoughtTokens are
      // included in totalTokens so reported totals match billable tokens;
      // until bridge.ts tracks them they are reported as 0.
      if (usage) {
        const thoughtTokens = 0
        return {
          stopReason,
          _meta: {
            claudeCode: {
              usage: {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cachedReadTokens: usage.cachedReadTokens,
                cachedWriteTokens: usage.cachedWriteTokens,
                thoughtTokens,
                totalTokens:
                  usage.inputTokens +
                  usage.outputTokens +
                  usage.cachedReadTokens +
                  usage.cachedWriteTokens +
                  thoughtTokens,
              },
            },
          },
        }
      }
      return { stopReason }
    } catch (err: unknown) {
      // Treat AbortError / cancellation-shaped errors as a turn cancellation
      // regardless of the session.cancelled flag, to close the race window
      // between interrupt() firing and cancel() setting the flag. Per
      // prompt-turn.mdx the Agent MUST return `cancelled` for aborts.
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' ||
          /abort|cancelled|interrupt/i.test(err.message))
      if (session.cancelled || isAbort) {
        return { stopReason: 'cancelled' }
      }

      // Check for process death errors
      if (
        err instanceof Error &&
        (err.message.includes('terminated') ||
          err.message.includes('process exited'))
      ) {
        this.teardownSession(params.sessionId)
        throw new Error(
          'The Claude Agent process exited unexpectedly. Please start a new session.',
        )
      }

      throw err
    } finally {
      // Resolve next pending prompt if any
      const nextPrompt = popNextPendingPrompt(session)
      if (nextPrompt) {
        session.promptRunning = true
        nextPrompt.resolve(false)
      } else {
        session.promptRunning = false
      }
    }
  }

  // ── cancel ────────────────────────────────────────────────────

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId)
    if (!session) return

    // Set cancelled flag — checked by prompt() loop to break out
    session.cancelled = true
    session.cancelGeneration += 1

    // Cancel any queued prompts
    for (const [, pending] of session.pendingMessages) {
      pending.resolve(true)
    }
    session.pendingMessages.clear()
    session.pendingQueue = []
    session.pendingQueueHead = 0

    // Interrupt the query engine to abort the current API call
    session.queryEngine.interrupt()
  }

  // ── setSessionMode ──────────────────────────────────────────────

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
    const session = this.sessions.get(params.sessionId)
    if (!session) {
      throw new Error('Session not found')
    }

    this.applySessionMode(params.sessionId, params.modeId)
    // Per session-modes.mdx: when the Agent changes its own mode it MUST send
    // a current_mode_update notification so mode-only Clients learn the
    // switch. Mirrors the current_mode_update sent by setSessionConfigOption
    // when configId === 'mode'.
    await this.conn.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: params.modeId,
      },
    })
    await this.updateConfigOption(params.sessionId, 'mode', params.modeId)
    return {}
  }

  // ── setSessionModel ─────────────────────────────────────────────

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse> {
    const session = this.sessions.get(params.sessionId)
    if (!session) {
      throw new Error('Session not found')
    }
    // Store the raw value — QueryEngine.submitMessage() calls
    // parseUserSpecifiedModel() to resolve aliases (e.g. "sonnet" → "glm-5.1-turbo")
    session.queryEngine.setModel(params.modelId)
    await this.updateConfigOption(params.sessionId, 'model', params.modelId)
    return {}
  }

  // ── setSessionConfigOption ──────────────────────────────────────

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId)
    if (!session) {
      throw new Error('Session not found')
    }
    if (typeof params.value !== 'string') {
      throw new Error(
        `Invalid value for config option ${params.configId}: ${String(params.value)}`,
      )
    }

    const option = session.configOptions.find(o => o.id === params.configId)
    if (!option) {
      throw new Error(`Unknown config option: ${params.configId}`)
    }

    // Per session-config-options.mdx: value MUST be one of the values listed
    // in the option's options array. Reject unknown values with an error
    // rather than silently persisting them. Only `select` options carry an
    // options array; `boolean` options have no enumerated values.
    if (option.type === 'select') {
      const validValues = flattenConfigOptionValues(
        (option as { options?: unknown }).options,
      )
      if (!validValues.includes(params.value)) {
        throw new Error(
          `Invalid value '${params.value}' for config option ${params.configId}; must be one of: ${validValues.join(', ')}`,
        )
      }
    }

    const value = params.value

    if (params.configId === 'mode') {
      this.applySessionMode(params.sessionId, value)
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: value,
        },
      })
    } else if (params.configId === 'model') {
      session.queryEngine.setModel(value)
    }

    this.syncSessionConfigState(session, params.configId, value)

    session.configOptions = session.configOptions.map(o =>
      o.id === params.configId && typeof o.currentValue === 'string'
        ? { ...o, currentValue: value }
        : o,
    )

    return { configOptions: session.configOptions }
  }

  // ── Private helpers ─────────────────────────────────────────────

  private async createSession(
    params: NewSessionRequest,
    opts: {
      forceNewId?: boolean
      sessionId?: string
      initialMessages?: Message[]
    } = {},
  ): Promise<NewSessionResponse> {
    enableConfigs()

    const sessionId = opts.sessionId ?? randomUUID()
    const cwd = params.cwd

    // Align the global session state so that transcript persistence,
    // analytics, and cost tracking use the ACP session ID.
    // Preserve the projectDir set by getOrCreateSession so that
    // getSessionProjectDir() continues to resolve correctly.
    const currentProjectDir = getSessionProjectDir()
    switchSession(sessionId as SessionId, currentProjectDir)

    // Set CWD for the session
    setOriginalCwd(cwd)
    const previousProcessCwd = process.cwd()
    let processCwdChanged = false
    try {
      process.chdir(cwd)
      processCwdChanged = true
    } catch {
      // CWD may not exist yet; best-effort
    }

    try {
      // Build tools with a permissive permission context.
      const permissionContext = getEmptyToolPermissionContext()
      const tools: Tools = getTools(permissionContext)

      // Parse permission mode from _meta (passed by RCS/acp-link) or settings.
      const meta = params._meta as Record<string, unknown> | null | undefined
      const hasMetaPermissionMode = hasOwnField(meta, 'permissionMode')
      const metaPermissionMode = hasMetaPermissionMode
        ? meta?.permissionMode
        : undefined
      const settingsPermissionMode = this.getSetting<string>(
        'permissions.defaultMode',
      )
      const permissionMode = resolveSessionPermissionMode(
        metaPermissionMode,
        hasMetaPermissionMode,
        settingsPermissionMode,
      )

      // Create the permission bridge canUseTool function
      const canUseTool = createAcpCanUseTool(
        this.conn,
        sessionId,
        () => this.sessions.get(sessionId)?.modes.currentModeId ?? 'default',
        this.clientCapabilities,
        cwd,
        (modeId: string) => {
          this.applySessionMode(sessionId, modeId)
        },
        () =>
          this.sessions.get(sessionId)?.appState.toolPermissionContext
            .isBypassPermissionsModeAvailable ?? false,
      )

      // Parse MCP servers from ACP params
      // MCP server config is handled separately in the tools system

      // ACP clients can expose bypass only when both the process and local config allow it.
      const isBypassAvailable = isAcpBypassPermissionModeAvailable(
        settingsPermissionMode,
      )

      // Create a mutable AppState for the session
      const appState: AppState = {
        ...getDefaultAppState(),
        toolPermissionContext: {
          ...permissionContext,
          mode: permissionMode as PermissionMode,
          isBypassPermissionsModeAvailable: isBypassAvailable,
        },
      }

      // Load commands and agent definitions for subagent support
      const [commands, agentDefinitionsResult] = await Promise.all([
        getCommands(cwd),
        getAgentDefinitionsWithOverrides(cwd),
      ])

      // Inject agent definitions into appState
      appState.agentDefinitions = agentDefinitionsResult

      // Build QueryEngine config
      const engineConfig: QueryEngineConfig = {
        cwd,
        tools,
        commands,
        mcpClients: [],
        agents: agentDefinitionsResult.activeAgents,
        canUseTool,
        getAppState: () => appState,
        setAppState: (updater: (prev: AppState) => AppState) => {
          const updated = updater(appState)
          Object.assign(appState, updated)
        },
        readFileCache: new FileStateCache(500, 50 * 1024 * 1024),
        includePartialMessages: true,
        replayUserMessages: true,
        initialMessages: opts.initialMessages,
      }

      const queryEngine = new QueryEngine(engineConfig)

      // Build modes — bypassPermissions is opt-in for ACP clients.
      const availableModes = [
        {
          id: 'default',
          name: 'Default',
          description: 'Standard behavior, prompts for dangerous operations',
        },
        {
          id: 'acceptEdits',
          name: 'Accept Edits',
          description: 'Auto-accept file edit operations',
        },
        {
          id: 'plan',
          name: 'Plan Mode',
          description: 'Planning mode, no actual tool execution',
        },
        {
          id: 'auto',
          name: 'Auto',
          description:
            'Use a model classifier to approve/deny permission prompts.',
        },
        ...(isBypassAvailable
          ? [
              {
                id: 'bypassPermissions' as const,
                name: 'Bypass Permissions',
                description: 'Skip all permission checks',
              },
            ]
          : []),
        {
          id: 'dontAsk',
          name: "Don't Ask",
          description: "Don't prompt for permissions, deny if not pre-approved",
        },
      ]

      const modes: SessionModeState = {
        currentModeId: permissionMode,
        availableModes,
      }

      // Build models
      const modelOptions = getModelOptions()
      const currentModel = getMainLoopModel()
      const models: SessionModelState = {
        availableModels: modelOptions.map(m => ({
          modelId: String(m.value ?? ''),
          name: m.label ?? String(m.value ?? ''),
          description: m.description ?? undefined,
        })),
        currentModelId: currentModel,
      }

      // Set the model on the engine
      queryEngine.setModel(currentModel)

      // Build config options
      const configOptions = buildConfigOptions(modes, models)

      const session: AcpSession = {
        queryEngine,
        cancelled: false,
        cancelGeneration: 0,
        cwd,
        modes,
        models,
        configOptions,
        promptRunning: false,
        pendingMessages: new Map(),
        pendingQueue: [],
        pendingQueueHead: 0,
        toolUseCache: {},
        clientCapabilities: this.clientCapabilities,
        appState,
        commands,
        sessionFingerprint: computeSessionFingerprint({
          cwd,
          mcpServers: params.mcpServers as
            | Array<{ name: string; [key: string]: unknown }>
            | undefined,
        }),
      }

      this.sessions.set(sessionId, session)

      // Stable v1 NewSessionResponse only defines sessionId/modes/configOptions.
      // `models` is a draft/unstable field — omit it for v1 compliance.
      return {
        sessionId,
        modes,
        configOptions,
      }
    } finally {
      if (processCwdChanged) {
        process.chdir(previousProcessCwd)
      }
    }
  }

  private async getOrCreateSession(params: {
    sessionId: string
    cwd: string
    mcpServers?: NewSessionRequest['mcpServers']
    _meta?: NewSessionRequest['_meta']
    // replay:true (default, session/load) streams the conversation history back
    // to the client via session/update. replay:false (session/resume) only
    // restores the in-process context — per session-setup.mdx the Agent MUST
    // NOT replay history when resuming.
    replay?: boolean
  }): Promise<NewSessionResponse> {
    const shouldReplay = params.replay !== false
    const existingSession = this.sessions.get(params.sessionId)
    if (existingSession) {
      const fingerprint = computeSessionFingerprint({
        cwd: params.cwd,
        mcpServers: params.mcpServers as
          | Array<{ name: string; [key: string]: unknown }>
          | undefined,
      })
      if (fingerprint === existingSession.sessionFingerprint) {
        const resolved = await resolveSessionFilePath(
          params.sessionId,
          params.cwd,
        )
        switchSession(
          params.sessionId as SessionId,
          resolved ? dirname(resolved.filePath) : null,
        )
        setOriginalCwd(params.cwd)

        if (shouldReplay) {
          await this.replaySessionHistory(params)
        }

        return {
          sessionId: params.sessionId,
          modes: existingSession.modes,
          configOptions: existingSession.configOptions,
        }
      }

      await this.teardownSession(params.sessionId)
    }

    // Locate the session file by sessionId across all project directories.
    // params.cwd may not match the project directory where the session was
    // originally created (e.g. client sends a subdirectory path), so we
    // search by sessionId first and fall back to cwd-based lookup.
    const resolved = await resolveSessionFilePath(params.sessionId, params.cwd)
    const projectDir = resolved ? dirname(resolved.filePath) : null

    // Per session-setup.mdx "Working Directory": the cwd MUST be the absolute
    // path used for the session regardless of where the Agent was spawned.
    // Reject cross-project loads where the persisted session's original cwd
    // does not match the requested cwd, otherwise the client could load a
    // session belonging to project B while passing project A's cwd.
    if (resolved) {
      const lite = await readSessionLite(resolved.filePath)
      const originalCwd = lite && extractJsonStringField(lite.head, 'cwd')
      if (
        originalCwd &&
        path.resolve(originalCwd) !== path.resolve(params.cwd)
      ) {
        throw new Error(
          `Session cwd mismatch: session belongs to ${originalCwd}, requested ${params.cwd}`,
        )
      }
    }

    switchSession(params.sessionId as SessionId, projectDir)
    setOriginalCwd(params.cwd)

    let initialMessages: Message[] | undefined
    if (resolved) {
      try {
        const log = await getLastSessionLog(params.sessionId as UUID)
        if (log && log.messages.length > 0) {
          initialMessages = deserializeMessages(log.messages)
        }
      } catch (err) {
        console.error('[ACP] Failed to load session history:', err)
      }
    }

    const response = await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        _meta: params._meta,
      },
      { sessionId: params.sessionId, initialMessages },
    )

    // Replay history to client if loaded. session/resume skips this block.
    if (shouldReplay && initialMessages && initialMessages.length > 0) {
      const session = this.sessions.get(params.sessionId)
      if (session) {
        await replayHistoryMessages(
          params.sessionId,
          initialMessages as unknown as Array<Record<string, unknown>>,
          this.conn,
          session.toolUseCache,
          this.clientCapabilities,
          session.cwd,
        )
      }
    }

    return {
      sessionId: response.sessionId,
      modes: response.modes,
      configOptions: response.configOptions,
    }
  }

  private async teardownSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    await this.cancel({ sessionId })
    this.sessions.delete(sessionId)
  }

  /**
   * Load session history from disk and replay it to the ACP client.
   * Used when switching back to a session that is already in memory
   * (the client needs the conversation replayed to display it).
   */
  private async replaySessionHistory(params: {
    sessionId: string
    cwd: string
  }): Promise<void> {
    try {
      const log = await getLastSessionLog(params.sessionId as UUID)
      if (!log || log.messages.length === 0) return
      const messages = deserializeMessages(log.messages)
      if (messages.length === 0) return

      const session = this.sessions.get(params.sessionId)
      if (!session) return

      await replayHistoryMessages(
        params.sessionId,
        messages as unknown as Array<Record<string, unknown>>,
        this.conn,
        session.toolUseCache,
        this.clientCapabilities,
        session.cwd,
      )
    } catch (err) {
      console.error('[ACP] Failed to replay session history:', err)
    }
  }

  private applySessionMode(sessionId: string, modeId: string): void {
    if (!isPermissionMode(modeId)) {
      throw new Error(`Invalid mode: ${modeId}`)
    }
    const session = this.sessions.get(sessionId)
    if (session) {
      if (
        modeId === 'bypassPermissions' &&
        !session.appState.toolPermissionContext.isBypassPermissionsModeAvailable
      ) {
        throw new Error(`Mode not available: ${modeId}`)
      }
      const isAvailable = session.modes.availableModes.some(
        mode => mode.id === modeId,
      )
      if (!isAvailable) {
        throw new Error(`Mode not available: ${modeId}`)
      }

      session.modes = { ...session.modes, currentModeId: modeId }
      // Sync mode to appState so the permission pipeline sees the correct mode
      session.appState.toolPermissionContext = {
        ...session.appState.toolPermissionContext,
        mode: modeId as PermissionMode,
      }
    }
  }

  private async updateConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this.syncSessionConfigState(session, configId, value)

    session.configOptions = session.configOptions.map(o =>
      o.id === configId && typeof o.currentValue === 'string'
        ? { ...o, currentValue: value }
        : o,
    )

    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: session.configOptions,
      },
    })
  }

  private syncSessionConfigState(
    session: AcpSession,
    configId: string,
    value: string,
  ): void {
    if (configId === 'mode') {
      session.modes = { ...session.modes, currentModeId: value }
    } else if (configId === 'model') {
      session.models = { ...session.models, currentModelId: value }
    }
  }

  private async sendAvailableCommandsUpdate(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const availableCommands = session.commands
      .filter(
        cmd =>
          cmd.type === 'prompt' && !cmd.isHidden && cmd.userInvocable !== false,
      )
      .map(cmd => ({
        name: cmd.name,
        description: cmd.description,
        input: cmd.argumentHint ? { hint: cmd.argumentHint } : undefined,
      }))

    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands,
      },
    })
  }

  private scheduleAvailableCommandsUpdate(sessionId: string): void {
    setTimeout(() => {
      void this.sendAvailableCommandsUpdate(sessionId).catch(err => {
        console.error('[ACP] Failed to send available commands update:', err)
      })
    }, 0)
  }

  /**
   * Emit a session_info_update notification carrying a derived session title
   * (truncated first user prompt) and the current last-activity timestamp.
   * Sent once per session — subsequent turns reuse the same title.
   */
  private async maybeEmitSessionInfoUpdate(
    sessionId: string,
    firstPrompt: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // sessionInfoTitleSent is tracked via toolUseCache to avoid reshaping
    // AcpSession; use a dedicated per-session flag instead.
    const cache = session.toolUseCache as ToolUseCache & {
      __sessionInfoTitleSent?: boolean
    }
    if (cache.__sessionInfoTitleSent) return
    cache.__sessionInfoTitleSent = true
    const title = sanitizeTitle(firstPrompt).slice(0, 100)
    try {
      await this.conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          ...(title ? { title } : {}),
          updatedAt: new Date().toISOString(),
        },
      })
    } catch (err) {
      console.error('[ACP] Failed to send session_info_update:', err)
    }
  }

  /** Read a setting from Claude config (simplified — no file watching) */
  private getSetting<T>(key: string): T | undefined {
    const settings = getSettings_DEPRECATED() as Record<string, unknown>
    const value = key.split('.').reduce<unknown>((current, segment) => {
      if (!current || typeof current !== 'object') return undefined
      return (current as Record<string, unknown>)[segment]
    }, settings)
    return value as T | undefined
  }
}

// ── Helpers ────────────────────────────────────────────────────────

const permissionModeIds: readonly PermissionMode[] = [
  'auto',
  'default',
  'acceptEdits',
  'bypassPermissions',
  'dontAsk',
  'plan',
]

function isPermissionMode(modeId: string): modeId is PermissionMode {
  return (permissionModeIds as readonly string[]).includes(modeId)
}

function resolveSessionPermissionMode(
  metaMode: unknown,
  hasMetaMode: boolean,
  settingsMode: unknown,
): PermissionMode {
  if (hasMetaMode) {
    const metaResolved = resolveRequiredPermissionMode(
      metaMode,
      '_meta.permissionMode',
    )
    if (
      metaResolved === 'bypassPermissions' &&
      !isAcpBypassPermissionModeAvailable(settingsMode)
    ) {
      throw new Error(
        'Mode not available: bypassPermissions requires a local ACP bypass opt-in.',
      )
    }

    return metaResolved
  }

  const settingsResolved = resolveConfiguredPermissionMode(settingsMode)
  return settingsResolved ?? 'default'
}

function resolveRequiredPermissionMode(
  mode: unknown,
  source: string,
): PermissionMode {
  if (mode === undefined || mode === null) {
    throw new Error(`Invalid ${source}: expected a string.`)
  }

  return resolvePermissionMode(mode, source) as PermissionMode
}

function resolveConfiguredPermissionMode(
  mode: unknown,
): PermissionMode | undefined {
  if (mode === undefined || mode === null) return undefined

  try {
    return resolvePermissionMode(
      mode,
      'permissions.defaultMode',
    ) as PermissionMode
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(
      '[ACP] Invalid permissions.defaultMode, using default:',
      reason,
    )
    return undefined
  }
}

function hasOwnField(
  value: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  return !!value && Object.hasOwn(value, key)
}

function isAcpBypassPermissionModeAvailable(settingsMode?: unknown): boolean {
  return (
    isProcessBypassPermissionModeAvailable() &&
    (isAcpBypassLocallyEnabled() ||
      isSettingsBypassPermissionMode(settingsMode))
  )
}

function isProcessBypassPermissionModeAvailable(): boolean {
  if (process.env.IS_SANDBOX) return true
  if (typeof process.geteuid === 'function') return process.geteuid() !== 0
  if (typeof process.getuid === 'function') return process.getuid() !== 0
  return true
}

function isAcpBypassLocallyEnabled(): boolean {
  return (
    process.env.ACP_PERMISSION_MODE === 'bypassPermissions' ||
    isTruthyEnv(process.env.CLAUDE_CODE_ACP_ALLOW_BYPASS_PERMISSIONS)
  )
}

function isSettingsBypassPermissionMode(settingsMode: unknown): boolean {
  try {
    return resolvePermissionMode(settingsMode) === 'bypassPermissions'
  } catch {
    return false
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

/**
 * Flatten a SessionConfigOption's `options` (which may be flat
 * SessionConfigSelectOption entries or grouped SessionConfigSelectGroup
 * entries) into a list of valid value strings. Used to validate that a
 * setSessionConfigOption value is one of the listed options.
 */
function flattenConfigOptionValues(options: unknown): string[] {
  const values: string[] = []
  if (!Array.isArray(options)) return values
  for (const opt of options) {
    if (typeof opt !== 'object' || opt === null) continue
    const maybeGroup = opt as { group?: unknown; options?: unknown[] }
    if (Array.isArray(maybeGroup.options)) {
      // SessionConfigSelectGroup — recurse into its options
      for (const inner of maybeGroup.options) {
        if (
          inner &&
          typeof inner === 'object' &&
          typeof (inner as { value?: unknown }).value === 'string'
        ) {
          values.push((inner as { value: string }).value)
        }
      }
    } else if (typeof (opt as { value?: unknown }).value === 'string') {
      // SessionConfigSelectOption
      values.push((opt as { value: string }).value)
    }
  }
  return values
}

function popNextPendingPrompt(session: AcpSession): PendingPrompt | undefined {
  while (session.pendingQueueHead < session.pendingQueue.length) {
    const nextId = session.pendingQueue[session.pendingQueueHead++]
    if (!nextId) continue
    const next = session.pendingMessages.get(nextId)
    if (!next) continue
    session.pendingMessages.delete(nextId)
    compactPendingQueue(session)
    return next
  }

  compactPendingQueue(session)
  return undefined
}

function compactPendingQueue(session: AcpSession): void {
  if (session.pendingQueueHead === 0) return

  if (session.pendingQueueHead >= session.pendingQueue.length) {
    session.pendingQueue = []
    session.pendingQueueHead = 0
    return
  }

  if (
    session.pendingQueueHead > 1024 &&
    session.pendingQueueHead * 2 > session.pendingQueue.length
  ) {
    session.pendingQueue = session.pendingQueue.slice(session.pendingQueueHead)
    session.pendingQueueHead = 0
  }
}

function buildConfigOptions(
  modes: SessionModeState,
  models: SessionModelState,
): SessionConfigOption[] {
  return [
    {
      id: 'mode',
      name: 'Mode',
      description: 'Session permission mode',
      category: 'mode',
      type: 'select' as const,
      currentValue: modes.currentModeId,
      options: modes.availableModes.map(
        (m: SessionModeState['availableModes'][number]) => ({
          value: m.id,
          name: m.name,
          description: m.description,
        }),
      ),
    },
    {
      id: 'model',
      name: 'Model',
      description: 'AI model to use',
      category: 'model',
      type: 'select' as const,
      currentValue: models.currentModelId,
      options: models.availableModels.map(
        (m: SessionModelState['availableModels'][number]) => ({
          value: m.modelId,
          name: m.name,
          description: m.description ?? undefined,
        }),
      ),
    },
  ] as SessionConfigOption[]
}
