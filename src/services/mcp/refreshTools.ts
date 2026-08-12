/**
 * Manual re-query of a connected MCP server's tool list.
 *
 * Servers are supposed to push `notifications/tools/list_changed` when their tool set
 * moves, and `useManageMCPConnections` reacts to that. But the notification is a
 * best-effort message on a stream that can drop: a device that announces itself while
 * the connection was hiccupping simply never gets announced, and the session then runs
 * with a stale pool that nothing will ever correct. This is the manual path out of that
 * state — the same invalidate → re-fetch → swap sequence the notification handler runs,
 * reachable from a tool.
 *
 * It never dials. A server with no live connection is reported as such rather than
 * reconnected, because reconnecting is a policy decision (auth prompts, backoff state)
 * that belongs to the connection manager, not to a refresh.
 */

import { reject } from 'lodash-es'
import type { Tool } from '../../Tool.js'
import type { AppState } from '../../state/AppState.js'
import { errorMessage } from '@open-claude-code/tool-runtime/errors.js'
import { logMCPDebug } from '../../utils/telemetry/log.js'
import { fetchToolsForClient, invalidateFetchToolsForClient } from './client.js'
import { getMcpPrefix } from './mcpStringUtils.js'
import type { MCPServerConnection } from './types.js'

type SetAppState = (updater: (prev: AppState) => AppState) => void

type McpToolRefreshStatus = 'refreshed' | 'error' | 'not_connected'

/**
 * Shape of one server's refresh outcome. Internal: the tool that consumes it declares
 * the same shape as a zod `outputSchema` (which is what actually validates and reaches
 * the model), so a second, structurally-duplicated exported type would be a name that
 * could drift out of sync with the schema without anything noticing.
 */
type McpToolRefreshResult = {
  server: string
  status: McpToolRefreshStatus
  toolCount?: number
  added?: string[]
  removed?: string[]
  error?: string
}

/** Names of the tools currently in `tools` that belong to `serverName`. */
function toolNamesForServer(
  tools: readonly Tool[],
  serverName: string,
): Set<string> {
  const prefix = getMcpPrefix(serverName)
  const names = new Set<string>()
  for (const tool of tools) {
    // Prefix match rather than `tool.mcpInfo?.serverName`, because skip-prefix mode
    // keeps the bare tool name — but the pool swap below is prefix-based either way,
    // so both sides must agree on the same predicate or the diff lies.
    if (typeof tool.name === 'string' && tool.name.startsWith(prefix)) {
      names.add(tool.name)
    }
  }
  return names
}

/**
 * Replace this server's slice of the live tool pool.
 *
 * Mirrors the swap in `useManageMCPConnections.flushPendingUpdates`: drop everything
 * carrying the server's prefix, append the new set. Kept prefix-based (rather than
 * splicing by identity) so a tool that disappeared upstream actually leaves the pool.
 */
export function swapMcpServerTools(
  setAppState: SetAppState,
  serverName: string,
  newTools: Tool[],
): void {
  const prefix = getMcpPrefix(serverName)
  setAppState(prev => ({
    ...prev,
    mcp: {
      ...prev.mcp,
      tools: [
        ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
        ...newTools,
      ],
    },
  }))
}

/**
 * Re-read one server's tool list and apply it.
 *
 * `currentTools` is the pool as the caller sees it, used only to compute the
 * added/removed diff — that diff is the whole value of the call to the model, which
 * otherwise has no way to tell a successful refresh from a no-op.
 */
export async function refreshMcpServerTools(
  client: MCPServerConnection,
  currentTools: readonly Tool[],
  setAppState: SetAppState,
): Promise<McpToolRefreshResult> {
  if (client.type !== 'connected') {
    return {
      server: client.name,
      status: 'not_connected',
      error: `server connection state is "${client.type}" — this tool only re-reads tool lists over live connections and never dials`,
    }
  }

  const previous = toolNamesForServer(currentTools, client.name)

  let newTools: Tool[]
  try {
    // Invalidate first: fetchToolsForClient is LRU-memoized on the connection, so
    // without this the "refresh" would hand back the exact cached list that is the
    // reason the caller is here.
    invalidateFetchToolsForClient(client)
    newTools = await fetchToolsForClient(client)
  } catch (error) {
    // The pool is untouched, so the previous tool set stays in force — which is the
    // right failure mode: a transient tools/list error must not blank a working server.
    return {
      server: client.name,
      status: 'error',
      error: `tools/list failed; the previous tool set was kept (${errorMessage(error)})`,
    }
  }

  swapMcpServerTools(setAppState, client.name, newTools)

  const nextNames = new Set(
    newTools
      .map(tool => tool.name)
      .filter((name): name is string => typeof name === 'string'),
  )
  const added = [...nextNames].filter(name => !previous.has(name))
  const removed = [...previous].filter(name => !nextNames.has(name))
  logMCPDebug(
    client.name,
    `RefreshMcpTools: ${newTools.length} tool(s); +${added.length} -${removed.length}`,
  )

  return {
    server: client.name,
    status: 'refreshed',
    toolCount: newTools.length,
    added,
    removed,
  }
}
