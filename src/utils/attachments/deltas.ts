import { toolMatchesName, type Tools, type ToolUseContext } from '../../Tool.js'
import type { Message } from 'src/types/message.js'
import {
  extractDiscoveredToolNames,
  getDeferredToolsDelta,
  getSearchExtraToolsMode,
  isDeferredToolExecutionPathAvailable,
  isDeferredToolsDeltaEnabled,
  isSearchExtraToolsEnabledOptimistic,
  type DeferredToolsDeltaScanContext,
  type DeferredToolsMcpState,
} from '../tools/searchExtraTools.js'
import {
  isDeferredTool,
  SEARCH_EXTRA_TOOLS_TOOL_NAME,
} from '@open-claude-code/builtin-tools/tools/SearchExtraToolsTool/prompt.js'
import { isEnvDefinedFalsy } from '../config/envUtils.js'
import {
  getMcpInstructionsDelta,
  isMcpInstructionsDeltaEnabled,
} from '../mcp/mcpInstructionsDelta.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { filterAgentsByMcpRequirements } from '@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { AGENT_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/AgentTool/constants.js'
import {
  formatAgentLine,
  shouldInjectAgentListInMessages,
} from '@open-claude-code/builtin-tools/tools/AgentTool/agentListing.js'
import { filterDeniedAgents } from '../permissions/permissions.js'
import { getSubscriptionType } from '../auth/auth.js'
import { mcpInfoFromString } from '../../services/mcp/mcpStringUtils.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state/flags.js'
import type { Attachment } from './types.js'

/**
 * Killswitch for the failed-server section only. Failed servers are the one
 * axis whose text quotes strings the endpoint produced, so it gets its own
 * off-switch; pending and needs-auth carry only server names the user
 * configured themselves.
 */
function shouldSurfaceFailedMcpServers(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDE_CODE_SURFACE_FAILED_MCP_SERVERS)
}

/**
 * Third-party text (server-reported errors) that is about to be pasted into
 * the prompt. Normalize, drop the characters that could fake structure, and
 * cap the length so one broken server cannot dominate the context.
 */
const MCP_ERROR_MAX_CHARS = 200
function sanitizeMcpDiagnostic(text: string): string {
  const flattened = text
    .normalize('NFKC')
    // \p{Cc} rather than an explicit \u0000-\u001f range: same set, but it does
    // not put control characters in a regex literal. Stripping them is the
    // point — they are what would let a server-reported error forge line
    // structure inside the system-reminder.
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[<>"'`\u2018\u2019\u201c\u201d]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flattened.length > MCP_ERROR_MAX_CHARS
    ? `${flattened.slice(0, MCP_ERROR_MAX_CHARS)}\u2026`
    : flattened
}

/**
 * What the model needs to know about MCP servers that are not (yet) usable.
 *
 * needs-auth is reported only in non-interactive sessions: interactively the
 * user can just run /mcp, and the rendered text tells the model to hand the
 * problem back to the user, which is wrong advice when a dialog is one
 * keystroke away.
 */
/**
 * `nonInteractive` is a parameter rather than a straight
 * getIsNonInteractiveSession() read so callers — tests especially — can state
 * it instead of steering a process-global. Mocking `src/bootstrap/state.ts`
 * penetrates to `src/bootstrap/state/flags.ts`, so a suite that mocks the
 * barrel leaves setIsInteractive() writing to one STATE container while this
 * module reads another: the flag silently refuses to move and the
 * non-interactive branch is never exercised. Production passes nothing and
 * keeps reading the global.
 */
function collectMcpState(
  mcpClients: MCPServerConnection[] | undefined,
  nonInteractive: boolean = getIsNonInteractiveSession(),
): DeferredToolsMcpState | undefined {
  if (!mcpClients) return undefined
  const failed = shouldSurfaceFailedMcpServers()
    ? mcpClients
        .filter(c => c.type === 'failed')
        .map(c => ({
          name: sanitizeMcpDiagnostic(c.name),
          ...(c.error !== undefined && {
            error: sanitizeMcpDiagnostic(c.error),
          }),
        }))
    : undefined
  return {
    pending: mcpClients.filter(c => c.type === 'pending').map(c => c.name),
    ...(nonInteractive && {
      needsAuth: mcpClients
        .filter(c => c.type === 'needs-auth')
        .map(c => c.name),
    }),
    ...(failed !== undefined && { failed }),
  }
}

// Exported for compact.ts — the gate must be identical at both call sites.
export function getDeferredToolsDeltaAttachment(
  tools: Tools,
  model: string,
  messages: Message[] | undefined,
  scanContext?: DeferredToolsDeltaScanContext,
  mcpClients?: MCPServerConnection[],
  nonInteractive?: boolean,
): Attachment[] {
  if (!isDeferredToolsDeltaEnabled()) return []
  // These checks mirror the sync parts of isSearchExtraToolsEnabled — the
  // attachment announces a deferred workflow, so both SearchExtraTools and
  // ExecuteExtraTool have to be in the request. The async auto-threshold check
  // is not replicated (would double-fire tengu_search_extra_tools_mode_decision);
  // in tst-auto below-threshold the attachment can fire while the gateway is
  // filtered out, but that's a narrow case and the tools announced are directly
  // callable anyway.
  if (!isSearchExtraToolsEnabledOptimistic()) return []
  if (!isDeferredToolExecutionPathAvailable(tools)) return []
  const delta = getDeferredToolsDelta(
    tools,
    messages ?? [],
    scanContext,
    collectMcpState(mcpClients, nonInteractive),
  )
  if (!delta) return []
  return [{ type: 'deferred_tools_delta', ...delta }]
}

/**
 * Assistant turns that must pass with no SearchExtraTools call (and no prior
 * reminder) before the nudge fires again.
 */
const TOOL_SEARCH_REMINDER_EVERY_N_TURNS = 15
/** How many undiscovered tool names one reminder spells out. */
const TOOL_SEARCH_REMINDER_MAX_NAMES = 10

/** Escape hatch for anyone who finds the nudge noisy. */
function isToolSearchUsageReminderEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDE_CODE_TOOL_SEARCH_REMINDER)
}

/**
 * Count assistant turns back to the last SearchExtraTools call and to the last
 * reminder. API-error turns don't count — they aren't the model choosing not to
 * search.
 */
function countTurnsSinceToolSearchAndReminder(messages: Message[]): {
  turnsSinceLastToolSearch: number
  turnsSinceLastReminder: number
} {
  let foundSearch = false
  let foundReminder = false
  let turnsSinceLastToolSearch = 0
  let turnsSinceLastReminder = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.type === 'assistant') {
      if (msg.isApiErrorMessage) continue
      if (!foundSearch) {
        const content = msg.message?.content
        const searched =
          Array.isArray(content) &&
          content.some(
            block =>
              block.type === 'tool_use' &&
              block.name === SEARCH_EXTRA_TOOLS_TOOL_NAME,
          )
        if (searched) foundSearch = true
        else turnsSinceLastToolSearch++
      }
      if (!foundReminder) turnsSinceLastReminder++
    } else if (
      !foundReminder &&
      msg?.type === 'attachment' &&
      msg.attachment?.type === 'tool_search_usage_reminder'
    ) {
      foundReminder = true
    }
    if (foundSearch && foundReminder) break
  }

  return { turnsSinceLastToolSearch, turnsSinceLastReminder }
}

/**
 * Nudge the model toward SearchExtraTools when it has gone many turns without
 * using it while deferred tools it has never looked at are still sitting there.
 *
 * This is the complement of the `tool_discovery` prefetch, not a duplicate:
 * prefetch guesses what the user wants and pre-loads it, this one says "you
 * haven't looked". The failure it targets is the model concluding a capability
 * is missing — or hand-rolling a Bash workaround — without ever searching,
 * which is easy to fall into here because occ defers by default (everything
 * outside CORE_TOOLS, plus every MCP tool).
 *
 * Exported for compact.ts? No — deliberately not. After a compaction the
 * counters restart from the summary, which is the right behavior: the model
 * gets a fresh 15 turns before being nudged again.
 */
export function getToolSearchUsageReminderAttachment(
  toolUseContext: ToolUseContext,
  messages: Message[] | undefined,
): Attachment[] {
  if (!isToolSearchUsageReminderEnabled()) return []
  if (!messages || messages.length === 0) return []
  // 'tst-auto' below threshold and 'standard' both mean nothing is deferred
  // behind search, so there is nothing to nudge about.
  if (getSearchExtraToolsMode() !== 'tst') return []

  const tools = toolUseContext.options.tools
  if (!isDeferredToolExecutionPathAvailable(tools)) return []

  const { turnsSinceLastToolSearch, turnsSinceLastReminder } =
    countTurnsSinceToolSearchAndReminder(messages)
  if (
    turnsSinceLastToolSearch < TOOL_SEARCH_REMINDER_EVERY_N_TURNS ||
    turnsSinceLastReminder < TOOL_SEARCH_REMINDER_EVERY_N_TURNS
  ) {
    return []
  }

  const discovered = extractDiscoveredToolNames(messages)
  const undiscovered = tools
    .filter(tool => isDeferredTool(tool) && !discovered.has(tool.name))
    .map(tool => tool.name)
    .sort()
  if (undiscovered.length === 0) return []

  return [
    {
      type: 'tool_search_usage_reminder',
      undiscoveredToolNames: undiscovered.slice(
        0,
        TOOL_SEARCH_REMINDER_MAX_NAMES,
      ),
      undiscoveredCount: undiscovered.length,
    },
  ]
}

/**
 * Diff the current filtered agent pool against what's already been announced
 * in this conversation (reconstructed from prior agent_listing_delta
 * attachments). Returns [] if nothing changed or the gate is off.
 *
 * The agent list was embedded in AgentTool's description, causing ~10.2% of
 * fleet cache_creation: MCP async connect, /reload-plugins, or
 * permission-mode change → description changes → full tool-schema cache bust.
 * Moving the list here keeps the tool description static.
 *
 * Exported for compact.ts — re-announces the full set after compaction eats
 * prior deltas.
 */
export function getAgentListingDeltaAttachment(
  toolUseContext: ToolUseContext,
  messages: Message[] | undefined,
): Attachment[] {
  if (!shouldInjectAgentListInMessages()) return []

  // Skip if AgentTool isn't in the pool — the listing would be unactionable.
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, AGENT_TOOL_NAME))
  ) {
    return []
  }

  const { activeAgents, allowedAgentTypes } =
    toolUseContext.options.agentDefinitions

  // Mirror AgentTool.prompt()'s filtering: MCP requirements → deny rules →
  // allowedAgentTypes restriction. Keep this in sync with AgentTool.tsx.
  const mcpServers = new Set<string>()
  for (const tool of toolUseContext.options.tools) {
    const info = mcpInfoFromString(tool.name)
    if (info) mcpServers.add(info.serverName)
  }
  const permissionContext = toolUseContext.getAppState().toolPermissionContext
  let filtered = filterDeniedAgents(
    filterAgentsByMcpRequirements(activeAgents, [...mcpServers]),
    permissionContext,
    AGENT_TOOL_NAME,
  )
  if (allowedAgentTypes) {
    filtered = filtered.filter(a => allowedAgentTypes.includes(a.agentType))
  }

  // Reconstruct announced set from prior deltas in the transcript.
  const announced = new Set<string>()
  for (const msg of messages ?? []) {
    if (msg.type !== 'attachment') continue
    if (msg.attachment!.type !== 'agent_listing_delta') continue
    for (const t of msg.attachment!.addedTypes as string[]) announced.add(t)
    for (const t of msg.attachment!.removedTypes as string[])
      announced.delete(t)
  }

  const currentTypes = new Set(filtered.map(a => a.agentType))
  const added = filtered.filter(a => !announced.has(a.agentType))
  const removed: string[] = []
  for (const t of announced) {
    if (!currentTypes.has(t)) removed.push(t)
  }

  if (added.length === 0 && removed.length === 0) return []

  // Sort for deterministic output — agent load order is nondeterministic
  // (plugin load races, MCP async connect).
  added.sort((a, b) => a.agentType.localeCompare(b.agentType))
  removed.sort()

  return [
    {
      type: 'agent_listing_delta',
      addedTypes: added.map(a => a.agentType),
      addedLines: added.map(formatAgentLine),
      removedTypes: removed,
      isInitial: announced.size === 0,
      showConcurrencyNote: getSubscriptionType() !== 'pro',
    },
  ]
}

// Exported for compact.ts / reactiveCompact.ts — single source of truth for the gate.
export function getMcpInstructionsDeltaAttachment(
  mcpClients: MCPServerConnection[],
  messages: Message[] | undefined,
): Attachment[] {
  if (!isMcpInstructionsDeltaEnabled()) return []

  const delta = getMcpInstructionsDelta(mcpClients, messages ?? [])
  if (!delta) return []
  return [{ type: 'mcp_instructions_delta', ...delta }]
}

export function getCriticalSystemReminderAttachment(
  toolUseContext: ToolUseContext,
): Attachment[] {
  const reminder = toolUseContext.criticalSystemReminder_EXPERIMENTAL
  if (!reminder) {
    return []
  }
  return [{ type: 'critical_system_reminder', content: reminder }]
}

export function getOutputStyleAttachment(): Attachment[] {
  const settings = getSettings_DEPRECATED()
  const outputStyle = settings?.outputStyle || 'default'

  // Only show for non-default styles
  if (outputStyle === 'default') {
    return []
  }

  return [
    {
      type: 'output_style',
      style: outputStyle,
    },
  ]
}
