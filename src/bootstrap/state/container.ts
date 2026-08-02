import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Attributes, Meter } from '@opentelemetry/api'
import type { logs } from '@opentelemetry/api-logs'
import type { LoggerProvider } from '@opentelemetry/sdk-logs'
import type { MeterProvider } from '@opentelemetry/sdk-metrics'
import type { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { realpathSync } from 'fs'
import { cwd } from 'process'
import type { HookEvent, ModelUsage } from 'src/entrypoints/agentSdkTypes.js'
import type { AgentColorName } from '@open-claude-code/builtin-tools/tools/AgentTool/agentColorManager.js'
import type { HookCallbackMatcher } from 'src/types/hooks.js'
// Indirection for browser-sdk build (package.json "browser" field swaps
// crypto.ts for crypto.browser.ts). Pure leaf re-export of node:crypto —
// zero circular-dep risk. Path-alias import bypasses bootstrap-isolation
// (rule only checks ./ and / prefixes); explicit disable documents intent.
// eslint-disable-next-line custom-rules/bootstrap-isolation
import { randomUUID } from 'src/utils/crypto.js'
import type { ModelSetting } from 'src/utils/model/model.js'
import type { ModelStrings } from 'src/utils/model/modelStrings.js'
import type { SettingSource } from 'src/utils/settings/constants.js'
import type { PluginHookMatcher } from 'src/utils/settings/types.js'

// Union type for registered hooks - can be SDK callbacks or native plugin hooks
export type RegisteredHookMatcher = HookCallbackMatcher | PluginHookMatcher

// Re-exported for ./sessionRuntime.ts. agentColorManager.ts imports
// getAgentColorMap() back from the barrel, so that module and this directory
// form an (erased, type-only in this direction) cycle. Keeping container the
// directory's single importer of it keeps that cycle at one, matching the
// pre-split graph — see scripts/cycle-budget.json.
export type { AgentColorName }

import type { SessionId } from 'src/types/ids.js'

// The single mutable state container behind src/bootstrap/state.ts. Only the
// sibling modules in this directory may import STATE / getInitialState; every
// external consumer goes through the accessors re-exported by the barrel.
//
// The public types below (ChannelEntry, AttributedCounter, SessionCronTask)
// live here rather than with their accessors because they are part of the
// State shape itself — putting them in the accessor modules would force this
// leaf to import from its own dependents.

// DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE

// dev: true on entries that came via --dangerously-load-development-channels.
// The allowlist gate checks this per-entry (not the session-wide
// hasDevChannels bit) so passing both flags doesn't let the dev dialog's
// acceptance leak allowlist-bypass to the --channels entries.
export type ChannelEntry =
  | { kind: 'plugin'; name: string; marketplace: string; dev?: boolean }
  | { kind: 'server'; name: string; dev?: boolean }

export type AttributedCounter = {
  add(value: number, additionalAttributes?: Attributes): void
}

export type SessionCronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
  /**
   * When set, the task was created by an in-process teammate (not the team lead).
   * The scheduler routes fires to that teammate's pendingUserMessages queue
   * instead of the main REPL command queue. Session-only — never written to disk.
   */
  agentId?: string
}

export type State = {
  originalCwd: string
  // Stable project root - set once at startup (including by --worktree flag),
  // never updated by mid-session EnterWorktreeTool.
  // Use for project identity (history, skills, sessions) not file operations.
  projectRoot: string
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  turnHookDurationMs: number
  turnToolDurationMs: number
  turnClassifierDurationMs: number
  turnToolCount: number
  turnHookCount: number
  turnClassifierCount: number
  startTime: number
  lastInteractionTime: number
  totalLinesAdded: number
  totalLinesRemoved: number
  hasUnknownModelCost: boolean
  cwd: string
  modelUsage: { [modelName: string]: ModelUsage }
  mainLoopModelOverride: ModelSetting | undefined
  initialMainLoopModel: ModelSetting
  modelStrings: ModelStrings | null
  isInteractive: boolean
  kairosActive: boolean
  // When true, ensureToolResultPairing throws on mismatch instead of
  // repairing with synthetic placeholders. HFI opts in at startup so
  // trajectories fail fast rather than conditioning the model on fake
  // tool_results.
  strictToolResultPairing: boolean
  sdkAgentProgressSummariesEnabled: boolean
  userMsgOptIn: boolean
  clientType: string
  sessionSource: string | undefined
  questionPreviewFormat: 'markdown' | 'html' | undefined
  flagSettingsPath: string | undefined
  flagSettingsInline: Record<string, unknown> | null
  allowedSettingSources: SettingSource[]
  sessionIngressToken: string | null | undefined
  oauthTokenFromFd: string | null | undefined
  apiKeyFromFd: string | null | undefined
  // Telemetry state
  meter: Meter | null
  sessionCounter: AttributedCounter | null
  locCounter: AttributedCounter | null
  prCounter: AttributedCounter | null
  commitCounter: AttributedCounter | null
  costCounter: AttributedCounter | null
  tokenCounter: AttributedCounter | null
  codeEditToolDecisionCounter: AttributedCounter | null
  activeTimeCounter: AttributedCounter | null
  statsStore: { observe(name: string, value: number): void } | null
  sessionId: SessionId
  // Parent session ID for tracking session lineage (e.g., plan mode -> implementation)
  parentSessionId: SessionId | undefined
  // Logger state
  loggerProvider: LoggerProvider | null
  eventLogger: ReturnType<typeof logs.getLogger> | null
  // Meter provider state
  meterProvider: MeterProvider | null
  // Tracer provider state
  tracerProvider: BasicTracerProvider | null
  // Agent color state
  agentColorMap: Map<string, AgentColorName>
  agentColorIndex: number
  // Last API request for bug reports
  lastAPIRequest: Omit<BetaMessageStreamParams, 'messages'> | null
  // Last auto-mode classifier request(s) for /share transcript
  lastClassifierRequests: unknown[] | null
  // CLAUDE.md content cached by context.ts for the auto-mode classifier.
  // Breaks the yoloClassifier → claudemd → filesystem → permissions cycle.
  cachedClaudeMdContent: string | null
  // In-memory error log for recent errors
  inMemoryErrorLog: Array<{ error: string; timestamp: string }>
  // Session-only plugins from --plugin-dir flag
  inlinePlugins: Array<string>
  // Explicit --chrome / --no-chrome flag value (undefined = not set on CLI)
  chromeFlagOverride: boolean | undefined
  // Use cowork_plugins directory instead of plugins (--cowork flag or env var)
  useCoworkPlugins: boolean
  // Session-only bypass permissions mode flag (not persisted)
  sessionBypassPermissionsMode: boolean
  // Session-only flag gating the .claude/scheduled_tasks.json watcher
  // (useScheduledTasks). Set by cronScheduler.start() when the JSON has
  // entries, or by CronCreateTool. Not persisted.
  scheduledTasksEnabled: boolean
  // Session-only cron tasks created via CronCreate with durable: false.
  // Fire on schedule like file-backed tasks but are never written to
  // .claude/scheduled_tasks.json — they die with the process. Typed via
  // SessionCronTask below (not importing from cronTasks.ts keeps
  // bootstrap a leaf of the import DAG).
  sessionCronTasks: SessionCronTask[]
  // Teams created this session via TeamCreate. cleanupSessionTeams()
  // removes these on gracefulShutdown so subagent-created teams don't
  // persist on disk forever (gh-32730). TeamDelete removes entries to
  // avoid double-cleanup. Lives here (not teamHelpers.ts) so
  // resetStateForTests() clears it between tests.
  sessionCreatedTeams: Set<string>
  // Session-only trust flag for home directory (not persisted to disk)
  // When running from home dir, trust dialog is shown but not saved to disk.
  // This flag allows features requiring trust to work during the session.
  sessionTrustAccepted: boolean
  // Session-only flag to disable session persistence to disk
  sessionPersistenceDisabled: boolean
  // Track if user has exited plan mode in this session (for re-entry guidance)
  hasExitedPlanMode: boolean
  // Track if we need to show the plan mode exit attachment (one-time notification)
  needsPlanModeExitAttachment: boolean
  // Track if we need to show the auto mode exit attachment (one-time notification)
  needsAutoModeExitAttachment: boolean
  // Track if LSP plugin recommendation has been shown this session (only show once)
  lspRecommendationShownThisSession: boolean
  // SDK init event state - jsonSchema for structured output
  initJsonSchema: Record<string, unknown> | null
  // Registered hooks - SDK callbacks and plugin native hooks
  registeredHooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null
  // Cache for plan slugs: sessionId -> wordSlug
  planSlugCache: Map<string, string>
  // Track teleported session for reliability logging
  teleportedSessionInfo: {
    isTeleported: boolean
    hasLoggedFirstMessage: boolean
    sessionId: string | null
  } | null
  // Track invoked skills for preservation across compaction
  // Keys are composite: `${agentId ?? ''}:${skillName}` to prevent cross-agent overwrites
  invokedSkills: Map<
    string,
    {
      skillName: string
      skillPath: string
      content: string
      invokedAt: number
      agentId: string | null
    }
  >
  // Track slow operations for dev bar display (ant-only)
  slowOperations: Array<{
    operation: string
    durationMs: number
    timestamp: number
  }>
  // SDK-provided betas (e.g., context-1m-2025-08-07)
  sdkBetas: string[] | undefined
  // Main thread agent type (from --agent flag or settings)
  mainThreadAgentType: string | undefined
  // Remote mode (--remote flag)
  isRemoteMode: boolean
  // Remote host/URL shown in the header (set by `claude ssh`)
  remoteServerUrl: string | undefined
  // System prompt section cache state
  systemPromptSectionCache: Map<string, string | null>
  // Last date emitted to the model (for detecting midnight date changes)
  lastEmittedDate: string | null
  // Additional directories from --add-dir flag (for CLAUDE.md loading)
  additionalDirectoriesForClaudeMd: string[]
  // Channel server allowlist from --channels flag (servers whose channel
  // notifications should register this session). Parsed once in main.tsx —
  // the tag decides trust model: 'plugin' → marketplace verification +
  // allowlist, 'server' → allowlist always fails (schema is plugin-only).
  // Either kind needs entry.dev to bypass allowlist.
  allowedChannels: ChannelEntry[]
  // True if any entry in allowedChannels came from
  // --dangerously-load-development-channels (so ChannelsNotice can name the
  // right flag in policy-blocked messages)
  hasDevChannels: boolean
  // Dir containing the session's `.jsonl`; null = derive from originalCwd.
  sessionProjectDir: string | null
  // Cached prompt cache 1h TTL allowlist from GrowthBook (session-stable)
  promptCache1hAllowlist: string[] | null
  // Cached 1h TTL user eligibility (session-stable). Latched on first
  // evaluation so mid-session overage flips don't change the cache_control
  // TTL, which would bust the server-side prompt cache.
  promptCache1hEligible: boolean | null
  // Sticky-on latch for AFK_MODE_BETA_HEADER. Once auto mode is first
  // activated, keep sending the header for the rest of the session so
  // Shift+Tab toggles don't bust the ~50-70K token prompt cache.
  afkModeHeaderLatched: boolean | null
  // Sticky-on latch for FAST_MODE_BETA_HEADER. Once fast mode is first
  // enabled, keep sending the header so cooldown enter/exit doesn't
  // double-bust the prompt cache. The `speed` body param stays dynamic.
  fastModeHeaderLatched: boolean | null
  // Sticky-on latch for the cache-editing beta header. Once cached
  // microcompact is first enabled, keep sending the header so mid-session
  // GrowthBook/settings toggles don't bust the prompt cache.
  cacheEditingHeaderLatched: boolean | null
  // Current prompt ID (UUID) correlating a user prompt with subsequent OTel events
  promptId: string | null
  // Last API requestId for the main conversation chain (not subagents).
  // Updated after each successful API response for main-session queries.
  // Read at shutdown to send cache eviction hints to inference.
  lastMainRequestId: string | undefined
  // Timestamp (Date.now()) of the last successful API call completion.
  // Used to compute timeSinceLastApiCallMs in tengu_api_success for
  // correlating cache misses with idle time (cache TTL is ~5min).
  lastApiCompletionTimestamp: number | null
  // Set to true after compaction (auto or manual /compact). Consumed by
  // logAPISuccess to tag the first post-compaction API call so we can
  // distinguish compaction-induced cache misses from TTL expiry.
  pendingPostCompaction: boolean
}

// ALSO HERE - THINK THRICE BEFORE MODIFYING
export function getInitialState(): State {
  // Resolve symlinks in cwd to match behavior of shell.ts setCwd
  // This ensures consistency with how paths are sanitized for session storage
  let resolvedCwd = ''
  if (
    typeof process !== 'undefined' &&
    typeof process.cwd === 'function' &&
    typeof realpathSync === 'function'
  ) {
    const rawCwd = cwd()
    try {
      resolvedCwd = realpathSync(rawCwd).normalize('NFC')
    } catch {
      // File Provider EPERM on CloudStorage mounts (lstat per path component).
      resolvedCwd = rawCwd.normalize('NFC')
    }
  }
  const state: State = {
    originalCwd: resolvedCwd,
    projectRoot: resolvedCwd,
    totalCostUSD: 0,
    totalAPIDuration: 0,
    totalAPIDurationWithoutRetries: 0,
    totalToolDuration: 0,
    turnHookDurationMs: 0,
    turnToolDurationMs: 0,
    turnClassifierDurationMs: 0,
    turnToolCount: 0,
    turnHookCount: 0,
    turnClassifierCount: 0,
    startTime: Date.now(),
    lastInteractionTime: Date.now(),
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    hasUnknownModelCost: false,
    cwd: resolvedCwd,
    modelUsage: {},
    mainLoopModelOverride: undefined,
    initialMainLoopModel: null,
    modelStrings: null,
    isInteractive: false,
    kairosActive: false,
    strictToolResultPairing: false,
    sdkAgentProgressSummariesEnabled: false,
    userMsgOptIn: false,
    clientType: 'cli',
    sessionSource: undefined,
    questionPreviewFormat: undefined,
    sessionIngressToken: undefined,
    oauthTokenFromFd: undefined,
    apiKeyFromFd: undefined,
    flagSettingsPath: undefined,
    flagSettingsInline: null,
    allowedSettingSources: [
      'userSettings',
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ],
    // Telemetry state
    meter: null,
    sessionCounter: null,
    locCounter: null,
    prCounter: null,
    commitCounter: null,
    costCounter: null,
    tokenCounter: null,
    codeEditToolDecisionCounter: null,
    activeTimeCounter: null,
    statsStore: null,
    sessionId: randomUUID() as SessionId,
    parentSessionId: undefined,
    // Logger state
    loggerProvider: null,
    eventLogger: null,
    // Meter provider state
    meterProvider: null,
    tracerProvider: null,
    // Agent color state
    agentColorMap: new Map(),
    agentColorIndex: 0,
    // Last API request for bug reports
    lastAPIRequest: null,
    // Last auto-mode classifier request(s) for /share transcript
    lastClassifierRequests: null,
    cachedClaudeMdContent: null,
    // In-memory error log for recent errors
    inMemoryErrorLog: [],
    // Session-only plugins from --plugin-dir flag
    inlinePlugins: [],
    // Explicit --chrome / --no-chrome flag value (undefined = not set on CLI)
    chromeFlagOverride: undefined,
    // Use cowork_plugins directory instead of plugins
    useCoworkPlugins: false,
    // Session-only bypass permissions mode flag (not persisted)
    sessionBypassPermissionsMode: false,
    // Scheduled tasks disabled until flag or dialog enables them
    scheduledTasksEnabled: false,
    sessionCronTasks: [],
    sessionCreatedTeams: new Set(),
    // Session-only trust flag (not persisted to disk)
    sessionTrustAccepted: false,
    // Session-only flag to disable session persistence to disk
    sessionPersistenceDisabled: false,
    // Track if user has exited plan mode in this session
    hasExitedPlanMode: false,
    // Track if we need to show the plan mode exit attachment
    needsPlanModeExitAttachment: false,
    // Track if we need to show the auto mode exit attachment
    needsAutoModeExitAttachment: false,
    // Track if LSP plugin recommendation has been shown this session
    lspRecommendationShownThisSession: false,
    // SDK init event state
    initJsonSchema: null,
    registeredHooks: null,
    // Cache for plan slugs
    planSlugCache: new Map(),
    // Track teleported session for reliability logging
    teleportedSessionInfo: null,
    // Track invoked skills for preservation across compaction
    invokedSkills: new Map(),
    // Track slow operations for dev bar display
    slowOperations: [],
    // SDK-provided betas
    sdkBetas: undefined,
    // Main thread agent type
    mainThreadAgentType: undefined,
    // Remote mode
    isRemoteMode: false,
    // Direct connect server URL
    remoteServerUrl: undefined,
    // System prompt section cache state
    systemPromptSectionCache: new Map(),
    // Last date emitted to the model
    lastEmittedDate: null,
    // Additional directories from --add-dir flag (for CLAUDE.md loading)
    additionalDirectoriesForClaudeMd: [],
    // Channel server allowlist from --channels flag
    allowedChannels: [],
    hasDevChannels: false,
    // Session project dir (null = derive from originalCwd)
    sessionProjectDir: null,
    // Prompt cache 1h allowlist (null = not yet fetched from GrowthBook)
    promptCache1hAllowlist: null,
    // Prompt cache 1h eligibility (null = not yet evaluated)
    promptCache1hEligible: null,
    // Beta header latches (null = not yet triggered)
    afkModeHeaderLatched: null,
    fastModeHeaderLatched: null,
    cacheEditingHeaderLatched: null,
    // Current prompt ID
    promptId: null,
    lastMainRequestId: undefined,
    lastApiCompletionTimestamp: null,
    pendingPostCompaction: false,
  }

  return state
}

// AND ESPECIALLY HERE
export const STATE: State = getInitialState()
