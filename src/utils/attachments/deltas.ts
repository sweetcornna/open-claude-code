import { toolMatchesName, type Tools, type ToolUseContext } from '../../Tool.js'
import type { Message } from 'src/types/message.js'
import {
  getDeferredToolsDelta,
  isDeferredToolsDeltaEnabled,
  isSearchExtraToolsEnabledOptimistic,
  isSearchExtraToolsToolAvailable,
  type DeferredToolsDeltaScanContext,
} from '../tools/searchExtraTools.js'
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
import type { Attachment } from './types.js'

// Exported for compact.ts — the gate must be identical at both call sites.
export function getDeferredToolsDeltaAttachment(
  tools: Tools,
  model: string,
  messages: Message[] | undefined,
  scanContext?: DeferredToolsDeltaScanContext,
): Attachment[] {
  if (!isDeferredToolsDeltaEnabled()) return []
  // These three checks mirror the sync parts of isSearchExtraToolsEnabled —
  // the attachment text says "available via SearchExtraTools", so SearchExtraTools
  // has to actually be in the request. The async auto-threshold check
  // is not replicated (would double-fire tengu_search_extra_tools_mode_decision);
  // in tst-auto below-threshold the attachment can fire while SearchExtraTools
  // is filtered out, but that's a narrow case and the tools announced
  // are directly callable anyway.
  if (!isSearchExtraToolsEnabledOptimistic()) return []
  if (!isSearchExtraToolsToolAvailable(tools)) return []
  const delta = getDeferredToolsDelta(tools, messages ?? [], scanContext)
  if (!delta) return []
  return [{ type: 'deferred_tools_delta', ...delta }]
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
