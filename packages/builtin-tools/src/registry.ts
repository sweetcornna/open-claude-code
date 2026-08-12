// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * The built-in tool registry.
 *
 * This is the exhaustive, ORDERED inventory of every tool that can end up in a
 * session's base tool pool. It moved here from `src/tools.ts` (wave C of the
 * tool-runtime dependency inversion) so the package owns the list of tools it
 * ships. The host keeps only policy on top of it — presets, deny-rule
 * filtering, --bare/REPL/coordinator shaping and MCP merging all still live in
 * `src/tools.ts`.
 *
 * Two things deliberately did NOT become injection points:
 *
 *   - `feature()` gates and raw `process.env` reads stay verbatim. `feature()`
 *     is a bundler macro: it only works in `if`/ternary condition position and
 *     is what makes the disabled branches disappear from the bundle. Turning
 *     either into an injected value would defeat dead-code elimination and move
 *     build-time truth into runtime state.
 *   - The lazily `require`d tools stay lazily required, for the same reason they
 *     always were: the require only executes on the branch that needs the tool.
 *
 * What DID become an injection point: the host runtime predicates (todo-v2,
 * worktree mode, PowerShell availability, tool search, ...). They arrive as a
 * `RegistryEnv` bag so the package no longer imports host policy modules just to
 * decide its own contents.
 *
 * NOTE: This list MUST stay in sync with
 * https://console.statsig.com/4aF3Ewatb6xPVpCwxb5nA3/dynamic_configs/claude_code_global_system_caching,
 * in order to cache the system prompt across users. The order is therefore
 * load-bearing and pinned by src/__tests__/tools.inventory.test.ts.
 */
import type { Tools } from '@open-claude-code/tool-runtime/Tool.js'
import { AgentTool } from './tools/AgentTool/AgentTool.js'
import { SkillTool } from './tools/SkillTool/SkillTool.js'
import { BashTool } from './tools/BashTool/BashTool.js'
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js'
import { GlobTool } from './tools/GlobTool/GlobTool.js'
import { NotebookEditTool } from './tools/NotebookEditTool/NotebookEditTool.js'
import { WebFetchTool } from './tools/WebFetchTool/WebFetchTool.js'
import { TaskStopTool } from './tools/TaskStopTool/TaskStopTool.js'
import { BriefTool } from './tools/BriefTool/BriefTool.js'
// Dead code elimination: conditional import for ant-only tools
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const REPLTool =
  process.env.USER_TYPE === 'ant'
    ? require('./tools/REPLTool/REPLTool.js').REPLTool
    : null
const SuggestBackgroundPRTool =
  process.env.USER_TYPE === 'ant'
    ? require('./tools/SuggestBackgroundPRTool/SuggestBackgroundPRTool.js')
        .SuggestBackgroundPRTool
    : null
const cronTools = [
  require('./tools/ScheduleCronTool/CronCreateTool.js').CronCreateTool,
  require('./tools/ScheduleCronTool/CronDeleteTool.js').CronDeleteTool,
  require('./tools/ScheduleCronTool/CronListTool.js').CronListTool,
]
const RemoteTriggerTool = feature('AGENT_TRIGGERS_REMOTE')
  ? require('./tools/RemoteTriggerTool/RemoteTriggerTool.js').RemoteTriggerTool
  : null
const MonitorTool = feature('MONITOR_TOOL')
  ? require('./tools/MonitorTool/MonitorTool.js').MonitorTool
  : null
const SubscribePRTool = feature('KAIROS_GITHUB_WEBHOOKS')
  ? require('./tools/SubscribePRTool/SubscribePRTool.js').SubscribePRTool
  : null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import { TaskOutputTool } from './tools/TaskOutputTool/TaskOutputTool.js'
import { WebSearchTool } from './tools/WebSearchTool/WebSearchTool.js'
import { TodoWriteTool } from './tools/TodoWriteTool/TodoWriteTool.js'
import { ExitPlanModeV2Tool } from './tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { ArtifactTool } from './tools/ArtifactTool/ArtifactTool.js'
import { TestingPermissionTool } from './tools/testing/TestingPermissionTool.js'
import { GrepTool } from './tools/GrepTool/GrepTool.js'
import { TungstenTool } from './tools/TungstenTool/TungstenTool.js'
// These three used to be lazy `require`s in src/tools.ts, breaking the cycle
// tools.ts -> TeamCreateTool/TeamDeleteTool/SendMessageTool -> ... -> tools.ts.
// Once the registry moved into the package that host hop disappeared, so they
// are ordinary imports again — measured, not assumed: `bun run check:cycles`
// reports the same 463 runtime / 2181 total either way.
import { TeamCreateTool } from './tools/TeamCreateTool/TeamCreateTool.js'
import { TeamDeleteTool } from './tools/TeamDeleteTool/TeamDeleteTool.js'
import { SendMessageTool } from './tools/SendMessageTool/SendMessageTool.js'
import { AskUserQuestionTool } from './tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { LSPTool } from './tools/LSPTool/LSPTool.js'
import { ListMcpResourcesTool } from './tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { ReadMcpResourceTool } from './tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { WaitForMcpServersTool } from './tools/WaitForMcpServersTool/WaitForMcpServersTool.js'
import { RefreshMcpToolsTool } from './tools/RefreshMcpToolsTool/RefreshMcpToolsTool.js'
import { SearchExtraToolsTool } from './tools/SearchExtraToolsTool/SearchExtraToolsTool.js'
import { ExecuteTool } from './tools/ExecuteTool/ExecuteTool.js'
import { EnterPlanModeTool } from './tools/EnterPlanModeTool/EnterPlanModeTool.js'
import { EnterWorktreeTool } from './tools/EnterWorktreeTool/EnterWorktreeTool.js'
import { ExitWorktreeTool } from './tools/ExitWorktreeTool/ExitWorktreeTool.js'
import { ConfigTool } from './tools/ConfigTool/ConfigTool.js'
const GoalTool = feature('GOAL')
  ? require('./tools/GoalTool/GoalTool.js').GoalTool
  : null
import { LocalMemoryRecallTool } from './tools/LocalMemoryRecallTool/LocalMemoryRecallTool.js'
import { VaultHttpFetchTool } from './tools/VaultHttpFetchTool/VaultHttpFetchTool.js'
import { TaskCreateTool } from './tools/TaskCreateTool/TaskCreateTool.js'
import { TaskGetTool } from './tools/TaskGetTool/TaskGetTool.js'
import { TaskUpdateTool } from './tools/TaskUpdateTool/TaskUpdateTool.js'
import { TaskListTool } from './tools/TaskListTool/TaskListTool.js'
// Dead code elimination: conditional import for CLAUDE_CODE_VERIFY_PLAN
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const VerifyPlanExecutionTool =
  process.env.CLAUDE_CODE_VERIFY_PLAN === 'true'
    ? require('./tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.js')
        .VerifyPlanExecutionTool
    : null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import { feature } from 'bun:bundle'
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const TerminalCaptureTool = feature('TERMINAL_PANEL')
  ? require('./tools/TerminalCaptureTool/TerminalCaptureTool.js')
      .TerminalCaptureTool
  : null
const WebBrowserTool = feature('WEB_BROWSER_TOOL')
  ? require('./tools/WebBrowserTool/WebBrowserTool.js').WebBrowserTool
  : null
const DiscoverSkillsTool = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? require('./tools/DiscoverSkillsTool/DiscoverSkillsTool.js')
      .DiscoverSkillsTool
  : null
// The workflow tool is host-wired (it needs the host's workflow service ports),
// so the gate lives here but the implementation is required from the host.
const WorkflowTool = feature('WORKFLOW_SCRIPTS')
  ? require('src/workflow/wiring.js').createWorkflowToolCore()
  : null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Required lazily so a build that never enables the PowerShell tool (i.e. every
 * non-Windows build) does not pull the module — and its win32 dependencies —
 * into the graph at all.
 */
const getPowerShellTool = () =>
  (
    require('./tools/PowerShellTool/PowerShellTool.js') as typeof import('./tools/PowerShellTool/PowerShellTool.js')
  ).PowerShellTool
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Host-supplied answers to the runtime questions the registry needs in order to
 * decide its own contents.
 *
 * Every field is a plain boolean rather than a thunk: the host evaluates all of
 * them on each `getAllBaseTools` call, which is exactly what the inline
 * predicate calls did before the move — no memoization semantics change.
 *
 * Lives here rather than in `@open-claude-code/tool-runtime` on purpose: this is
 * the registry's own injection contract, not part of the Tool contract, and
 * nothing outside this module and its host wrapper has any use for it.
 */
export interface RegistryEnv {
  /**
   * Ant-native builds have bfs/ugrep embedded in the bun binary, which makes the
   * dedicated Glob/Grep tools unnecessary.
   */
  hasEmbeddedSearchTools: boolean
  /** Task* tools are available (they supersede TodoWrite for those sessions). */
  isTodoV2Enabled: boolean
  /** ENABLE_LSP_TOOL is set — expose the LSP tool. */
  isLspToolEnabled: boolean
  /** Worktree enter/exit tools are available. */
  isWorktreeModeEnabled: boolean
  /** Windows build with the PowerShell tool not explicitly disabled. */
  isPowerShellToolEnabled: boolean
  /**
   * Optimistic tool-search check. The real decision to defer tools happens at
   * request time in the API layer; this only decides whether the model can see
   * SearchExtraTools at all.
   */
  isSearchExtraToolsEnabled: boolean
}

/**
 * Get the complete exhaustive list of all tools that could be available
 * in the current environment (respecting process.env flags).
 * This is the source of truth for ALL tools.
 */
export function getAllBaseTools(env: RegistryEnv): Tools {
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    // Ant-native builds have bfs/ugrep embedded in the bun binary (same ARGV0
    // trick as ripgrep). When available, find/grep in Claude's shell are aliased
    // to these fast tools, so the dedicated Glob/Grep tools are unnecessary.
    ...(env.hasEmbeddedSearchTools ? [] : [GlobTool, GrepTool]),
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    ArtifactTool,
    WebFetchTool,
    TodoWriteTool,
    WebSearchTool,
    TaskStopTool,
    AskUserQuestionTool,
    SkillTool,
    EnterPlanModeTool,
    LocalMemoryRecallTool,
    VaultHttpFetchTool,
    ...(process.env.USER_TYPE === 'ant' ? [ConfigTool] : []),
    ...(GoalTool ? [GoalTool] : []),
    ...(process.env.USER_TYPE === 'ant' ? [TungstenTool] : []),
    ...(SuggestBackgroundPRTool ? [SuggestBackgroundPRTool] : []),
    ...(WebBrowserTool ? [WebBrowserTool] : []),
    ...(env.isTodoV2Enabled
      ? [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool]
      : []),
    ...(TerminalCaptureTool ? [TerminalCaptureTool] : []),
    ...(env.isLspToolEnabled ? [LSPTool] : []),
    ...(env.isWorktreeModeEnabled ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    SendMessageTool,
    TeamCreateTool,
    TeamDeleteTool,
    ...(VerifyPlanExecutionTool ? [VerifyPlanExecutionTool] : []),
    ...(process.env.USER_TYPE === 'ant' && REPLTool ? [REPLTool] : []),
    ...(WorkflowTool ? [WorkflowTool] : []),
    ...cronTools,
    ...(RemoteTriggerTool ? [RemoteTriggerTool] : []),
    ...(MonitorTool ? [MonitorTool] : []),
    BriefTool,
    ...(SubscribePRTool ? [SubscribePRTool] : []),
    ...(env.isPowerShellToolEnabled ? [getPowerShellTool()] : []),
    ...(DiscoverSkillsTool ? [DiscoverSkillsTool] : []),
    ...(process.env.NODE_ENV === 'test' ? [TestingPermissionTool] : []),
    ListMcpResourcesTool,
    ReadMcpResourceTool,
    // Grouped with the other MCP tools rather than appended at the very end: these two
    // are unconditional (they answer usefully with zero servers — "nothing to wait for",
    // "no servers to refresh"), so keeping the MCP block contiguous is what makes the
    // ordering readable at all. Both are deferred: absent from CORE_TOOLS.
    WaitForMcpServersTool,
    RefreshMcpToolsTool,
    // Include SearchExtraToolsTool when tool search might be enabled (optimistic check)
    // The actual decision to defer tools happens at request time in claude.ts
    ...(env.isSearchExtraToolsEnabled ? [SearchExtraToolsTool] : []),
    // ExecuteExtraTool (ExecuteTool) is a first-class tool — always available, not deferred.
    // Models use it to invoke deferred tools discovered via SearchExtraTools.
    ExecuteTool,
  ]
}
