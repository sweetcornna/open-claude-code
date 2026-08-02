// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * Host-side tool policy.
 *
 * The tool inventory itself now lives in
 * `@open-claude-code/builtin-tools/registry.js` (wave C of the tool-runtime
 * dependency inversion). What stays here is everything that is a *host* decision
 * on top of that inventory: presets, deny-rule filtering, --bare/REPL/coordinator
 * shaping, and merging in MCP tools.
 *
 * `getAllBaseTools()` keeps its old no-argument signature: it evaluates the host
 * runtime predicates and hands them to the registry as a `RegistryEnv`.
 */
// Load the host slow-operations implementation before builtin tool modules.
// It self-registers with tool-runtime; standalone package use keeps the facade's
// native JSON fallback instead.
import './utils/slowOperations.js'
// Load the host MessageResponse implementation before builtin tool modules.
// It self-registers with tool-runtime; standalone package use keeps the facade's
// children-only fallback instead.
import './components/MessageResponse.js'
// Load the host analytics implementations before builtin tool modules.
// They self-register with tool-runtime; standalone package use keeps the
// no-op and default-value facade fallbacks instead.
import './services/analytics/index.js'
import './services/analytics/growthbook.js'
import { toolMatchesName, type Tool, type Tools } from './Tool.js'
import { AgentTool } from '@open-claude-code/builtin-tools/tools/AgentTool/AgentTool.js'
import { BashTool } from '@open-claude-code/builtin-tools/tools/BashTool/BashTool.js'
import { FileEditTool } from '@open-claude-code/builtin-tools/tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from '@open-claude-code/builtin-tools/tools/FileReadTool/FileReadTool.js'
import { TaskStopTool } from '@open-claude-code/builtin-tools/tools/TaskStopTool/TaskStopTool.js'
// Dead code elimination: conditional import for ant-only tools
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const REPLTool =
  process.env.USER_TYPE === 'ant'
    ? require('@open-claude-code/builtin-tools/tools/REPLTool/REPLTool.js')
        .REPLTool
    : null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
// Lazy require to break circular dependency: tools.ts -> SendMessageTool -> ... -> tools.ts
/* eslint-disable @typescript-eslint/no-require-imports */
const getSendMessageTool = () =>
  require('@open-claude-code/builtin-tools/tools/SendMessageTool/SendMessageTool.js')
    .SendMessageTool as typeof import('@open-claude-code/builtin-tools/tools/SendMessageTool/SendMessageTool.js').SendMessageTool
/* eslint-enable @typescript-eslint/no-require-imports */
import { ListMcpResourcesTool } from '@open-claude-code/builtin-tools/tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { ReadMcpResourceTool } from '@open-claude-code/builtin-tools/tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { isSearchExtraToolsEnabledOptimistic } from './utils/searchExtraTools.js'
import { isTodoV2Enabled } from './utils/tasks.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/SyntheticOutputTool/SyntheticOutputTool.js'
import {
  getAllBaseTools as getAllBaseToolsFromRegistry,
  type RegistryEnv,
} from '@open-claude-code/builtin-tools/registry.js'
export {
  ALL_AGENT_DISALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  COORDINATOR_MODE_ALLOWED_TOOLS,
} from './constants/tools.js'
import { feature } from 'bun:bundle'
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('./coordinator/coordinatorMode.js') as typeof import('./coordinator/coordinatorMode.js'))
  : null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import type { ToolPermissionContext } from './Tool.js'
import { getDenyRuleForTool } from './utils/permissions/permissions.js'
import { hasEmbeddedSearchTools } from './utils/embeddedTools.js'
import { isEnvTruthy } from './utils/envUtils.js'
import { isPowerShellToolEnabled } from './utils/shell/shellToolUtils.js'
import { isWorktreeModeEnabled } from './utils/worktreeModeEnabled.js'
import {
  REPL_TOOL_NAME,
  REPL_ONLY_TOOLS,
} from '@open-claude-code/builtin-tools/tools/REPLTool/constants.js'
import { isReplModeEnabled } from '@open-claude-code/builtin-tools/tools/REPLTool/replMode.js'
export { REPL_ONLY_TOOLS }

/**
 * Predefined tool presets that can be used with --tools flag
 */
export const TOOL_PRESETS = ['default'] as const

export type ToolPreset = (typeof TOOL_PRESETS)[number]

export function parseToolPreset(preset: string): ToolPreset | null {
  const presetString = preset.toLowerCase()
  if (!TOOL_PRESETS.includes(presetString as ToolPreset)) {
    return null
  }
  return presetString as ToolPreset
}

/**
 * Get the list of tool names for a given preset
 * Filters out tools that are disabled via isEnabled() check
 * @param preset The preset name
 * @returns Array of tool names
 */
export function getToolsForDefaultPreset(): string[] {
  const tools = getAllBaseTools()
  const isEnabled = tools.map(tool => tool.isEnabled())
  return tools.filter((_, i) => isEnabled[i]).map(tool => tool.name)
}

/**
 * Snapshot of the host runtime predicates the registry needs.
 *
 * Evaluated on every call, exactly like the inline predicate calls this
 * replaced — none of these are cheap-to-stale values the registry may cache.
 */
function buildRegistryEnv(): RegistryEnv {
  return {
    hasEmbeddedSearchTools: hasEmbeddedSearchTools(),
    isTodoV2Enabled: isTodoV2Enabled(),
    isLspToolEnabled: isEnvTruthy(process.env.ENABLE_LSP_TOOL),
    isWorktreeModeEnabled: isWorktreeModeEnabled(),
    isPowerShellToolEnabled: isPowerShellToolEnabled(),
    isSearchExtraToolsEnabled: isSearchExtraToolsEnabledOptimistic(),
  }
}

/**
 * Get the complete exhaustive list of all tools that could be available
 * in the current environment (respecting process.env flags).
 * This is the source of truth for ALL tools.
 *
 * The list and its order live in
 * `@open-claude-code/builtin-tools/registry.js`; this is the host binding that
 * supplies the runtime predicates it is parameterised over.
 */
export function getAllBaseTools(): Tools {
  return getAllBaseToolsFromRegistry(buildRegistryEnv())
}

/**
 * Filters out tools that are blanket-denied by the permission context.
 * A tool is filtered out if there's a deny rule matching its name with no
 * ruleContent (i.e., a blanket deny for that tool).
 *
 * Uses the same matcher as the runtime permission check (step 1a), so MCP
 * server-prefix rules like `mcp__server` strip all tools from that server
 * before the model sees them — not just at call time.
 */
export function filterToolsByDenyRules<
  T extends {
    name: string
    mcpInfo?: { serverName: string; toolName: string }
  },
>(tools: readonly T[], permissionContext: ToolPermissionContext): T[] {
  return tools.filter(tool => !getDenyRuleForTool(permissionContext, tool))
}

export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  // Simple mode: only Bash, Read, and Edit tools
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    // --bare + REPL mode: REPL wraps Bash/Read/Edit/etc inside the VM, so
    // return REPL instead of the raw primitives. Matches the non-bare path
    // below which also hides REPL_ONLY_TOOLS when REPL is enabled.
    if (isReplModeEnabled() && REPLTool) {
      const replSimple: Tool[] = [REPLTool]
      if (
        feature('COORDINATOR_MODE') &&
        coordinatorModeModule?.isCoordinatorMode()
      ) {
        replSimple.push(TaskStopTool, getSendMessageTool())
      }
      return filterToolsByDenyRules(replSimple, permissionContext)
    }
    const simpleTools: Tool[] = [BashTool, FileReadTool, FileEditTool]
    // When coordinator mode is also active, include AgentTool and TaskStopTool
    // so the coordinator gets Task+TaskStop (via useMergedTools filtering) and
    // workers get Bash/Read/Edit (via filterToolsForAgent filtering).
    if (
      feature('COORDINATOR_MODE') &&
      coordinatorModeModule?.isCoordinatorMode()
    ) {
      simpleTools.push(AgentTool, TaskStopTool, getSendMessageTool())
    }
    return filterToolsByDenyRules(simpleTools, permissionContext)
  }

  // Get all base tools and filter out special tools that get added conditionally
  const specialTools = new Set([
    ListMcpResourcesTool.name,
    ReadMcpResourceTool.name,
    SYNTHETIC_OUTPUT_TOOL_NAME,
  ])

  const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))

  // Filter out tools that are denied by the deny rules
  let allowedTools = filterToolsByDenyRules(tools, permissionContext)

  // When REPL mode is enabled, hide primitive tools from direct use.
  // They're still accessible inside REPL via the VM context.
  if (isReplModeEnabled()) {
    const replEnabled = allowedTools.some(tool =>
      toolMatchesName(tool, REPL_TOOL_NAME),
    )
    if (replEnabled) {
      allowedTools = allowedTools.filter(
        tool => !REPL_ONLY_TOOLS.has(tool.name),
      )
    }
  }

  const isEnabled = allowedTools.map(_ => _.isEnabled())
  return allowedTools.filter((_, i) => isEnabled[i])
}

/**
 * Assemble the full tool pool for a given permission context and MCP tools.
 *
 * This is the single source of truth for combining built-in tools with MCP tools.
 * Both REPL.tsx (via useMergedTools hook) and runAgent.ts (for coordinator workers)
 * use this function to ensure consistent tool pool assembly.
 *
 * The function:
 * 1. Gets built-in tools via getTools() (respects mode filtering)
 * 2. Filters MCP tools by deny rules
 * 3. Deduplicates by tool name (built-in tools take precedence)
 *
 * @param permissionContext - Permission context for filtering built-in tools
 * @param mcpTools - MCP tools from appState.mcp.tools
 * @returns Combined, deduplicated array of built-in and MCP tools
 */
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)

  // Filter out MCP tools that are in the deny list
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)

  // Sort each partition for prompt-cache stability, keeping built-ins as a
  // contiguous prefix. The server's claude_code_system_cache_policy places a
  // global cache breakpoint after the last prefix-matched built-in tool; a flat
  // sort would interleave MCP tools into built-ins and invalidate all downstream
  // cache keys whenever an MCP tool sorts between existing built-ins. uniqBy
  // preserves insertion order, so built-ins win on name conflict.
  // Avoid Array.toSorted (Node 20+) — we support Node 18. builtInTools is
  // readonly so copy-then-sort; allowedMcpTools is a fresh .filter() result.
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}

/**
 * Get all tools including both built-in tools and MCP tools.
 *
 * This is the preferred function when you need the complete tools list for:
 * - Tool search threshold calculations (isSearchExtraToolsEnabled)
 * - Token counting that includes MCP tools
 * - Any context where MCP tools should be considered
 *
 * Use getTools() only when you specifically need just built-in tools.
 *
 * @param permissionContext - Permission context for filtering built-in tools
 * @param mcpTools - MCP tools from appState.mcp.tools
 * @returns Combined array of built-in and MCP tools
 */
export function getMergedTools(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  return [...builtInTools, ...mcpTools]
}
