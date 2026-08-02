/**
 * MCP connection-lifecycle control requests: reconnect, enable/disable, and
 * channel enablement.
 *
 * reconnect and toggle deliberately keep their own copies of the config
 * lookup and the appState.mcp republish. They read the same sources but
 * differ in what they do with the result (toggle persists the enabled flag
 * and has a disconnect path), and the two have drifted apart before —
 * folding them together would be a behavior change, not a cleanup.
 */
import omit from 'lodash-es/omit.js'
import reject from 'lodash-es/reject.js'
import type { SDKControlRequest } from 'src/entrypoints/sdk/controlTypes.js'
import {
  clearServerCache,
  reconnectMcpServerImpl,
} from 'src/services/mcp/client.js'
import {
  getMcpConfigByName,
  setMcpServerEnabled,
} from 'src/services/mcp/config.js'
import { getMcpPrefix } from 'src/services/mcp/mcpStringUtils.js'
import { commandBelongsToServer } from 'src/services/mcp/utils.js'
import { handleChannelEnable } from './channels.js'
import { reregisterChannelHandlerAfterReconnect } from './channels.js'
import { registerElicitationHandlers } from './headlessMcpRuntime.js'
import {
  sendControlResponseError,
  sendControlResponseSuccess,
} from './headlessControlResponses.js'
import type { HeadlessRunState } from './headlessRunState.js'

/**
 * Reconnect one MCP server and republish its tools, commands and resources.
 *
 * The config lookup covers every source the operations below touch —
 * settings, the construction-time client list, SDK-injected servers and
 * dynamically-added ones. Missing the last two used to make
 * toggle/reconnect answer "Server not found" for servers that would have
 * reconnected fine (gh-31339 / CC-314).
 */
export async function handleMcpReconnect(
  state: HeadlessRunState,
  msg: SDKControlRequest,
  request: { serverName: string },
): Promise<void> {
  const currentAppState = state.getAppState()
  const { serverName } = request
  state.elicitationRegistered.delete(serverName)
  // Config-existence gate must cover the SAME sources as the
  // operations below. SDK-injected servers (query({mcpServers:{...}}))
  // and dynamically-added servers were missing here, so
  // toggleMcpServer/reconnect returned "Server not found" even though
  // the disconnect/reconnect would have worked (gh-31339 / CC-314).
  const config =
    getMcpConfigByName(serverName) ??
    state.mcpClients.find(c => c.name === serverName)?.config ??
    state.sdkClients.find(c => c.name === serverName)?.config ??
    state.dynamicMcpState.clients.find(c => c.name === serverName)?.config ??
    currentAppState.mcp.clients.find(c => c.name === serverName)?.config ??
    null
  if (!config) {
    sendControlResponseError(state, msg, `Server not found: ${serverName}`)
  } else {
    const result = await reconnectMcpServerImpl(serverName, config)
    // Update appState.mcp with the new client, tools, commands, and resources
    const prefix = getMcpPrefix(serverName)
    state.setAppState(prev => ({
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
        ...state.dynamicMcpState.clients.filter(c => c.name !== serverName),
        result.client,
      ],
      tools: [
        ...state.dynamicMcpState.tools.filter(t => !t.name?.startsWith(prefix)),
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
}

/**
 * Enable or disable one MCP server: persist the setting, then disconnect or
 * reconnect and republish. Same config-lookup gate as handleMcpReconnect.
 */
export async function handleMcpToggle(
  state: HeadlessRunState,
  msg: SDKControlRequest,
  request: { serverName: string; enabled: boolean },
): Promise<void> {
  const currentAppState = state.getAppState()
  const { serverName, enabled } = request
  state.elicitationRegistered.delete(serverName)
  // Gate must match the client-lookup spread below (which
  // includes sdkClients and dynamicMcpState.clients). Same fix as
  // mcp_reconnect above (gh-31339 / CC-314).
  const config =
    getMcpConfigByName(serverName) ??
    state.mcpClients.find(c => c.name === serverName)?.config ??
    state.sdkClients.find(c => c.name === serverName)?.config ??
    state.dynamicMcpState.clients.find(c => c.name === serverName)?.config ??
    currentAppState.mcp.clients.find(c => c.name === serverName)?.config ??
    null

  if (!config) {
    sendControlResponseError(state, msg, `Server not found: ${serverName}`)
  } else if (!enabled) {
    // Disabling: persist + disconnect (matches TUI toggleMcpServer behavior)
    setMcpServerEnabled(serverName, false)
    const client = [
      ...state.mcpClients,
      ...state.sdkClients,
      ...state.dynamicMcpState.clients,
      ...currentAppState.mcp.clients,
    ].find(c => c.name === serverName)
    if (client && client.type === 'connected') {
      await clearServerCache(serverName, config)
    }
    // Update appState.mcp to reflect disabled status and remove tools/commands/resources
    const prefix = getMcpPrefix(serverName)
    state.setAppState(prev => ({
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
    state.setAppState(prev => ({
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
}

/**
 * Enable the experimental channel capability on one MCP server.
 */
export function handleChannelEnableRequest(
  state: HeadlessRunState,
  msg: SDKControlRequest,
  req: Record<string, unknown>,
): void {
  const currentAppState = state.getAppState()
  handleChannelEnable(
    msg.request_id,
    req.serverName as string,
    // Pool spread matches mcp_status — all three client sources.
    [
      ...currentAppState.mcp.clients,
      ...state.sdkClients,
      ...state.dynamicMcpState.clients,
    ],
    state.output,
  )
}
