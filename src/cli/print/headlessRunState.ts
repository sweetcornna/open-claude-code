/**
 * Shared mutable state for one `runHeadlessStreaming` session.
 *
 * ## Why this exists
 *
 * `runHeadlessStreaming` used to be a single 3141-line function whose body was
 * one giant closure: ~33 top-level `let`/`const` bindings captured by ~25
 * nested functions (and by two long-lived async drivers — the turn loop and
 * the stdin reader). Nothing could be moved out of the function because every
 * candidate captured half a dozen of those bindings.
 *
 * The closure-capture map, which is what drove the field grouping below:
 *
 * | nested function                  | captured bindings                                      |
 * | -------------------------------- | ------------------------------------------------------ |
 * | `sigintHandler`                  | abortController                                        |
 * | SIGTERM `registerCleanup` cb     | running, runPhase, structuredIO, getAppState           |
 * | permission-mode listener         | output                                                 |
 * | auth-status / rate-limit cbs     | output                                                 |
 * | `injectModelSwitchBreadcrumbs`   | mutableMessages, output                                |
 * | `registerElicitationHandlers`    | elicitationRegistered, structuredIO, output            |
 * | `updateSdkMcp`                   | sdkMcpConfigs, sdkClients, sdkTools, structuredIO, setAppState |
 * | `buildAllTools`                  | tools, sdkTools, dynamicMcpState, options              |
 * | `applyMcpServerChanges`          | mcpChangesPromise, sdkMcpConfigs, sdkClients, sdkTools, dynamicMcpState, setAppState |
 * | `buildMcpServerStatuses`         | getAppState, sdkClients, dynamicMcpState               |
 * | `refreshPluginState`             | setAppState, currentCommands, currentAgents            |
 * | `applyPluginMcpDiff`             | sdkMcpConfigs, + applyMcpServerChanges, updateSdkMcp   |
 * | `installPluginsAndApplyMcpInBackground` | + applyPluginMcpDiff                            |
 * | skill-change subscriber          | currentCommands                                        |
 * | `scheduleProactiveTick`          | inputClosed, + run                                     |
 * | command-queue subscriber         | abortController                                        |
 * | `run` / `drainCommandQueue`      | essentially everything                                 |
 * | `dispatchHeadlessCronCommand`    | inputClosed, running                                   |
 * | `sendControlResponse{Success,Error}` | output                                             |
 * | unexpected-response callback     | setAppState, handledOrphanedToolUseIds, + run          |
 * | stdin control-request loop       | essentially everything                                 |
 *
 * Threading that many parameters through would be worse than the closure. So
 * the closure state moved here instead, and every former nested function is
 * now a module-level `(state, ...args)` function. Mutually-recursive helpers
 * (`run` ↔ `scheduleProactiveTick`, `applyMcpServerChanges` ↔
 * `applyPluginMcpDiff`) resolve by plain module imports rather than by
 * forward-declared closure bindings.
 *
 * ## Field grouping
 *
 * Fields are grouped by lifetime, not by feature: session inputs (never
 * reassigned) → run-loop control flags → conversation/turn state → model →
 * MCP → plugin-derived commands/agents → teardown handles → OAuth flows.
 * That ordering matches the order the session touches them, and it makes the
 * "who may write this" question answerable per group: only the turn loop
 * writes the control flags, only the MCP runtime writes the MCP group, etc.
 */
import type { UUID } from 'crypto'
import { cwd } from 'process'
import type { AgentDefinition } from '@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { Command } from 'src/commands.js'
import { StructuredIO } from 'src/cli/structuredIO.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import type { AppState } from 'src/state/AppStateStore.js'
import type { Tools } from 'src/Tool.js'
import type { Message } from 'src/types/message.js'
import type { QueuedCommand } from 'src/types/textInputTypes.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import type { Stream } from 'src/utils/stream.js'
import type { ModelInfo, SDKStatus } from 'src/entrypoints/agentSdkTypes.js'
import type {
  SDKControlMcpSetServersResponse,
  StdoutMessage,
} from 'src/entrypoints/sdk/controlTypes.js'
import type {
  MCPServerConnection,
  McpSdkServerConfig,
} from 'src/services/mcp/types.js'
import type { PromptVariant } from 'src/services/PromptSuggestion/promptSuggestion.js'
import type { OAuthService } from 'src/services/oauth/index.js'
import type { ClaudeAILimits } from 'src/services/claudeAiLimits.js'
import {
  createFileStateCacheWithSizeLimit,
  type FileStateCache,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/utils/fileStateCache.js'
import { extractReadFilesFromMessages } from 'src/utils/queryHelpers.js'
import { createIdleTimeoutManager } from 'src/utils/idleTimeout.js'
import { getModelOptions } from 'src/utils/model/modelOptions.js'
import {
  getDefaultMainLoopModel,
  parseUserSpecifiedModel,
} from 'src/utils/model/model.js'
import {
  EFFORT_LEVELS,
  modelSupportsEffort,
  modelSupportsMaxEffort,
} from 'src/utils/effort.js'
import { modelSupportsAdaptiveThinking } from 'src/utils/thinking.js'
import { modelSupportsAutoMode } from 'src/utils/betas.js'
import { isFastModeSupportedByModel } from 'src/utils/fastMode.js'
import type { DynamicMcpState } from './mcpServers.js'

/** Options bag for `runHeadlessStreaming`. Mutated in place by `initialize`. */
export type HeadlessStreamingOptions = {
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
}

/**
 * Coarse phase marker for the SIGTERM diagnostics dump. Lets a stuck
 * session's healthsweep name the `do/while (waitingForAgents)` poll without
 * reading the transcript.
 */
export type HeadlessRunPhase =
  | 'draining_commands'
  | 'waiting_for_agents'
  | 'finally_flush'
  | 'finally_post_flush'

/** Push-model prompt-suggestion bookkeeping for one session. */
export type SuggestionState = {
  abortController: AbortController | null
  inflightPromise: Promise<void> | null
  lastEmitted: {
    text: string
    emittedAt: number
    promptId: PromptVariant
    generationRequestId: string | null
  } | null
  pendingSuggestion: {
    type: 'prompt_suggestion'
    suggestion: string
    uuid: UUID
    session_id: string
  } | null
  pendingLastEmittedEntry: {
    text: string
    promptId: PromptVariant
    generationRequestId: string | null
  } | null
}

/** Result of one `applyMcpServerChanges` pass. */
export type McpServerChangesResult = {
  response: SDKControlMcpSetServersResponse
  sdkServersChanged: boolean
}

export type HeadlessRunState = {
  // ---- session inputs (never reassigned) ----------------------------------
  readonly structuredIO: StructuredIO
  /** MCP clients as passed in at construction; a config-lookup fallback. */
  readonly mcpClients: MCPServerConnection[]
  /**
   * Commands as passed in at construction. `initialize` reports these, not
   * `currentCommands` — preserved verbatim from the original closure.
   */
  readonly initialCommands: Command[]
  /**
   * Agents as passed in at construction. `handleInitializeRequest` pushes
   * stdin-supplied agents into this array, so the reference must be shared.
   */
  readonly initialAgents: AgentDefinition[]
  readonly tools: Tools
  readonly canUseTool: CanUseToolFn
  /** Mutated in place (delete + Object.assign) by `applyMcpServerChanges`. */
  readonly sdkMcpConfigs: Record<string, McpSdkServerConfig>
  readonly getAppState: () => AppState
  readonly setAppState: (f: (prev: AppState) => AppState) => void
  /** Mutated in place by `handleInitializeRequest`. */
  readonly options: HeadlessStreamingOptions
  /** The one FIFO everything writes to — same queue `sendRequest()` feeds. */
  readonly output: Stream<StdoutMessage>

  // ---- run-loop control flags --------------------------------------------
  /** `run()` mutex. */
  running: boolean
  /**
   * Whether `initialize` has been seen. The first user prompt also flips it —
   * a prompt implicitly initializes a session that never sent the request.
   */
  initialized: boolean
  runPhase: HeadlessRunPhase | undefined
  inputClosed: boolean
  shutdownPromptInjected: boolean
  /** Result withheld while background agents are still running. */
  heldBackResult: StdoutMessage | null
  abortController: AbortController | undefined

  // ---- conversation / turn state -----------------------------------------
  /** Directly mutated by `ask()`. Same array identity as `initialMessages`. */
  readonly mutableMessages: Message[]
  /** Replaced wholesale by `ask()`'s clone-then-replace cycle. */
  readFileState: FileStateCache
  /** Client-supplied `seed_read_state` entries awaiting the next cycle. */
  readonly pendingSeeds: FileStateCache
  readonly suggestionState: SuggestionState

  // ---- model --------------------------------------------------------------
  readonly modelInfos: ModelInfo[]
  activeUserSpecifiedModel: string | undefined

  // ---- MCP ----------------------------------------------------------------
  sdkClients: MCPServerConnection[]
  sdkTools: Tools
  /** Servers that already have elicitation handlers wired. */
  readonly elicitationRegistered: Set<string>
  /** Serializes concurrent `applyMcpServerChanges` callers. */
  mcpChangesPromise: Promise<McpServerChangesResult>
  dynamicMcpState: DynamicMcpState

  // ---- plugin-derived commands / agents -----------------------------------
  pluginInstallPromise: Promise<void> | null
  currentCommands: Command[]
  currentAgents: AgentDefinition[]

  // ---- teardown handles ---------------------------------------------------
  readonly idleTimeout: { start: () => void; stop: () => void }
  unsubscribeAuthStatus: (() => void) | undefined
  readonly rateLimitListener: (limits: ClaudeAILimits) => void
  unsubscribeSkillChanges: () => void
  cronScheduler: import('src/utils/cronScheduler.js').CronScheduler | null

  // ---- OAuth --------------------------------------------------------------
  readonly handledOrphanedToolUseIds: Set<string>
  /** Per-server in-flight MCP OAuth flows, so a new request aborts the old. */
  readonly activeOAuthFlows: Map<string, AbortController>
  /** Manual callback-URL submitters, for browser-based IDEs. */
  readonly oauthCallbackSubmitters: Map<string, (callbackUrl: string) => void>
  /** Servers whose manual callback fired (the auto-reconnect path skips them). */
  readonly oauthManualCallbackUsed: Set<string>
  /** Auth-only promises so `mcp_oauth_callback_url` can await token exchange. */
  readonly oauthAuthPromises: Map<string, Promise<void>>
  /** Single-slot Anthropic OAuth flow (`claude_authenticate`). */
  claudeOAuth: { service: OAuthService; flow: Promise<void> } | null
}

export type CreateHeadlessRunStateInput = {
  structuredIO: StructuredIO
  mcpClients: MCPServerConnection[]
  commands: Command[]
  tools: Tools
  initialMessages: Message[]
  canUseTool: CanUseToolFn
  sdkMcpConfigs: Record<string, McpSdkServerConfig>
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  agents: AgentDefinition[]
  options: HeadlessStreamingOptions
  rateLimitListener: (limits: ClaudeAILimits) => void
}

/**
 * Only main-thread commands (`agentId === undefined`) belong to the headless
 * turn loop — subagent notifications are drained by the subagent's mid-turn
 * gate in query.ts.
 */
export function isMainThreadCommand(cmd: QueuedCommand): boolean {
  return cmd.agentId === undefined
}

/** Describes every selectable model to SDK consumers via `initialize`. */
function buildModelInfos(): ModelInfo[] {
  return getModelOptions().map(option => {
    const modelId = option.value === null ? 'default' : option.value
    const resolvedModel =
      modelId === 'default'
        ? getDefaultMainLoopModel()
        : parseUserSpecifiedModel(modelId)
    const hasEffort = modelSupportsEffort(resolvedModel)
    const hasAdaptiveThinking = modelSupportsAdaptiveThinking(resolvedModel)
    const hasFastMode = isFastModeSupportedByModel(option.value)
    const hasAutoMode = modelSupportsAutoMode(resolvedModel)
    return {
      name: modelId,
      value: modelId,
      displayName: option.label,
      description: option.description,
      ...(hasEffort && {
        supportsEffort: true,
        supportedEffortLevels: modelSupportsMaxEffort(resolvedModel)
          ? [...EFFORT_LEVELS]
          : EFFORT_LEVELS.filter(l => l !== 'max'),
      }),
      ...(hasAdaptiveThinking && { supportsAdaptiveThinking: true }),
      ...(hasFastMode && { supportsFastMode: true }),
      ...(hasAutoMode && { supportsAutoMode: true }),
    }
  })
}

export function createHeadlessRunState(
  input: CreateHeadlessRunStateInput,
): HeadlessRunState {
  const state: HeadlessRunState = {
    structuredIO: input.structuredIO,
    mcpClients: input.mcpClients,
    initialCommands: input.commands,
    initialAgents: input.agents,
    tools: input.tools,
    canUseTool: input.canUseTool,
    sdkMcpConfigs: input.sdkMcpConfigs,
    getAppState: input.getAppState,
    setAppState: input.setAppState,
    options: input.options,
    output: input.structuredIO.outbound,

    running: false,
    initialized: false,
    runPhase: undefined,
    inputClosed: false,
    shutdownPromptInjected: false,
    heldBackResult: null,
    abortController: undefined,

    // Messages for internal tracking, directly mutated by ask(). These
    // messages include Assistant, User, Attachment, and Progress messages.
    // TODO: Clean up this code to avoid passing around a mutable array.
    mutableMessages: input.initialMessages,
    // Seed the readFileState cache from the transcript (content the model saw,
    // with message timestamps) so getChangedFiles can detect external edits.
    // This cache instance must persist across ask() calls, since the edit tool
    // relies on this as a global state.
    readFileState: extractReadFilesFromMessages(
      input.initialMessages,
      cwd(),
      READ_FILE_STATE_CACHE_SIZE,
    ),
    // Client-supplied readFileState seeds (via seed_read_state control
    // request). The stdin loop runs concurrently with ask() — a seed arriving
    // mid-turn would be lost to ask()'s clone-then-replace (QueryEngine.ts
    // finally block) if written directly into readFileState. Instead, seeds
    // land here, merge into getReadFileCache's view (readFileState-wins-ties:
    // seeds fill gaps), and are re-applied then CLEARED in setReadFileCache.
    // One-shot: each seed survives exactly one clone-replace cycle, then
    // becomes a regular readFileState entry subject to compact's clear like
    // everything else.
    pendingSeeds: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    suggestionState: {
      abortController: null,
      inflightPromise: null,
      lastEmitted: null,
      pendingSuggestion: null,
      pendingLastEmittedEntry: null,
    },

    modelInfos: buildModelInfos(),
    activeUserSpecifiedModel: input.options.userSpecifiedModel,

    // Cache SDK MCP clients to avoid reconnecting on each run
    sdkClients: [],
    sdkTools: [],
    elicitationRegistered: new Set<string>(),
    mcpChangesPromise: Promise.resolve({
      response: {
        added: [] as string[],
        removed: [] as string[],
        errors: {} as Record<string, string>,
      },
      sdkServersChanged: false,
    }),
    // State for dynamically added MCP servers (via mcp_set_servers control
    // message). These are separate from SDK MCP servers and support all
    // transport types.
    dynamicMcpState: { clients: [], tools: [], configs: {} },

    pluginInstallPromise: null,
    currentCommands: input.commands,
    currentAgents: input.agents,

    // Replaced below — createIdleTimeoutManager needs `state` to read the
    // live `running` flag, so it cannot be built inside this literal.
    idleTimeout: { start: () => {}, stop: () => {} },
    unsubscribeAuthStatus: undefined,
    rateLimitListener: input.rateLimitListener,
    unsubscribeSkillChanges: () => {},
    cronScheduler: null,

    handledOrphanedToolUseIds: new Set<string>(),
    activeOAuthFlows: new Map<string, AbortController>(),
    oauthCallbackSubmitters: new Map<string, (callbackUrl: string) => void>(),
    oauthManualCallbackUsed: new Set<string>(),
    oauthAuthPromises: new Map<string, Promise<void>>(),
    claudeOAuth: null,
  }

  // `idleTimeout` is declared readonly because nothing after construction may
  // swap the manager; this one write completes construction.
  ;(state as { idleTimeout: HeadlessRunState['idleTimeout'] }).idleTimeout =
    createIdleTimeoutManager(() => !state.running)

  return state
}
