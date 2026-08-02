/**
 * MCP runtime for a headless session: elicitation wiring, SDK-MCP server
 * reconciliation, the shared tool-pool assembly, dynamic `mcp_set_servers`
 * application, and the `McpServerStatus[]` projection used by control
 * responses.
 *
 * These five were nested inside `runHeadlessStreaming` because they read and
 * write the same four mutable bindings (`sdkClients`, `sdkTools`,
 * `dynamicMcpState`, `mcpChangesPromise`). Those now live on
 * `HeadlessRunState`, so the functions are plain module-level ones.
 */
import { feature } from 'bun:bundle'
import { randomUUID } from 'crypto'
import uniqBy from 'lodash-es/uniqBy.js'
import { createSyntheticOutputTool } from '@open-claude-code/builtin-tools/tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { assembleToolPool } from 'src/tools.js'
import { toolMatchesName, type Tools } from 'src/Tool.js'
import type { AppState } from 'src/state/AppStateStore.js'
import { uniq } from 'src/utils/collections/array.js'
import { mergeAndFilterTools } from 'src/utils/toolPool.js'
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { logMCPDebug } from 'src/utils/telemetry/log.js'
import { getInitJsonSchema, getSessionId } from 'src/bootstrap/state.js'
import type {
  McpServerConfigForProcessTransport,
  McpServerStatus,
} from 'src/entrypoints/agentSdkTypes.js'
import type { SDKControlMcpSetServersResponse } from 'src/entrypoints/sdk/controlTypes.js'
import type { MCPServerConnection } from 'src/services/mcp/types.js'
import {
  isChannelAllowlisted,
  isChannelsEnabled,
} from 'src/services/mcp/channelAllowlist.js'
import { setupSdkMcpClients } from 'src/services/mcp/client.js'
import {
  runElicitationHooks,
  runElicitationResultHooks,
} from 'src/services/mcp/elicitationHandler.js'
import { executeNotificationHooks } from 'src/utils/hooks.js'
import { getMcpPrefix } from 'src/services/mcp/mcpStringUtils.js'
import { filterToolsByServer } from 'src/services/mcp/utils.js'
import { setupVscodeSdkMcp } from 'src/services/mcp/vscodeSdkMcp.js'
import { jsonStringify } from 'src/utils/telemetry/slowOperations.js'
import { handleMcpSetServers } from './mcpServers.js'
import type { HeadlessRunState } from './headlessRunState.js'

/**
 * Register elicitation request/completion handlers on connected MCP clients
 * that haven't been registered yet. SDK MCP servers are excluded because they
 * route through SdkControlClientTransport. Hooks run first (matching REPL
 * behavior); if no hook responds, the request is forwarded to the SDK
 * consumer via the control protocol.
 */
export function registerElicitationHandlers(
  state: HeadlessRunState,
  clients: MCPServerConnection[],
): void {
  for (const connection of clients) {
    if (
      connection.type !== 'connected' ||
      state.elicitationRegistered.has(connection.name)
    ) {
      continue
    }
    // Skip SDK MCP servers — elicitation flows through SdkControlClientTransport
    if (connection.config.type === 'sdk') {
      continue
    }
    const serverName = connection.name

    // Wrapped in try/catch because setRequestHandler throws if the client wasn't
    // created with elicitation capability declared (e.g., SDK-created clients).
    try {
      connection.client.setRequestHandler(
        'elicitation/create',
        async (request, ctx) => {
          const { signal } = ctx.mcpReq
          logMCPDebug(
            serverName,
            `Elicitation request received in print mode: ${jsonStringify(request)}`,
          )

          const mode = request.params.mode === 'url' ? 'url' : 'form'

          logEvent('tengu_mcp_elicitation_shown', {
            mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })

          // Run elicitation hooks first — they can provide a response programmatically
          const hookResponse = await runElicitationHooks(
            serverName,
            request.params,
            signal,
          )
          if (hookResponse) {
            logMCPDebug(
              serverName,
              `Elicitation resolved by hook: ${jsonStringify(hookResponse)}`,
            )
            logEvent('tengu_mcp_elicitation_response', {
              mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              action:
                hookResponse.action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            return hookResponse
          }

          // Delegate to SDK consumer via control protocol
          const url =
            'url' in request.params ? (request.params.url as string) : undefined
          const requestedSchema =
            'requestedSchema' in request.params
              ? (request.params.requestedSchema as
                  | Record<string, unknown>
                  | undefined)
              : undefined

          const elicitationId =
            'elicitationId' in request.params
              ? (request.params.elicitationId as string | undefined)
              : undefined

          const rawResult = await state.structuredIO.handleElicitation(
            serverName,
            request.params.message,
            requestedSchema,
            signal,
            mode,
            url,
            elicitationId,
          )

          const result = await runElicitationResultHooks(
            serverName,
            rawResult,
            signal,
            mode,
            elicitationId,
          )

          logEvent('tengu_mcp_elicitation_response', {
            mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            action:
              result.action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          return result
        },
      )

      // Surface completion notifications to SDK consumers (URL mode)
      connection.client.setNotificationHandler(
        'notifications/elicitation/complete',
        notification => {
          const { elicitationId } = notification.params
          logMCPDebug(
            serverName,
            `Elicitation completion notification: ${elicitationId}`,
          )
          void executeNotificationHooks({
            message: `MCP server "${serverName}" confirmed elicitation ${elicitationId} complete`,
            notificationType: 'elicitation_complete',
          })
          state.output.enqueue({
            type: 'system',
            subtype: 'elicitation_complete',
            mcp_server_name: serverName,
            elicitation_id: elicitationId,
            uuid: randomUUID(),
            session_id: getSessionId(),
          })
        },
      )

      state.elicitationRegistered.add(serverName)
    } catch {
      // setRequestHandler throws if the client wasn't created with
      // elicitation capability — skip silently
    }
  }
}

export async function updateSdkMcp(state: HeadlessRunState): Promise<void> {
  // Check if SDK MCP servers need to be updated (new servers added or removed)
  const currentServerNames = new Set(Object.keys(state.sdkMcpConfigs))
  const connectedServerNames = new Set(state.sdkClients.map(c => c.name))

  // Check if there are any differences (additions or removals)
  const hasNewServers = Array.from(currentServerNames).some(
    name => !connectedServerNames.has(name),
  )
  const hasRemovedServers = Array.from(connectedServerNames).some(
    name => !currentServerNames.has(name),
  )
  // Check if any SDK clients are pending and need to be upgraded
  const hasPendingSdkClients = state.sdkClients.some(c => c.type === 'pending')
  // Check if any SDK clients failed their handshake and need to be retried.
  // Without this, a client that lands in 'failed' (e.g. handshake timeout on
  // a WS reconnect race) stays failed forever — its name satisfies the
  // connectedServerNames diff but it contributes zero tools.
  const hasFailedSdkClients = state.sdkClients.some(c => c.type === 'failed')

  const haveServersChanged =
    hasNewServers ||
    hasRemovedServers ||
    hasPendingSdkClients ||
    hasFailedSdkClients

  if (haveServersChanged) {
    // Clean up removed servers
    for (const client of state.sdkClients) {
      if (!currentServerNames.has(client.name)) {
        if (client.type === 'connected') {
          await client.cleanup()
        }
      }
    }

    // Re-initialize all SDK MCP servers with current config
    const sdkSetup = await setupSdkMcpClients(
      state.sdkMcpConfigs,
      (serverName, message) =>
        state.structuredIO.sendMcpMessage(serverName, message),
    )
    state.sdkClients = sdkSetup.clients
    state.sdkTools = sdkSetup.tools

    // Store SDK MCP tools in appState so subagents can access them via
    // assembleToolPool. Only tools are stored here — SDK clients are already
    // merged separately in the query loop (allMcpClients) and mcp_status handler.
    // Use both old (connectedServerNames) and new (currentServerNames) to remove
    // stale SDK tools when servers are added or removed.
    const allSdkNames = uniq([...connectedServerNames, ...currentServerNames])
    state.setAppState(prev => ({
      ...prev,
      mcp: {
        ...prev.mcp,
        tools: [
          ...prev.mcp.tools.filter(
            t =>
              !allSdkNames.some(name => t.name.startsWith(getMcpPrefix(name))),
          ),
          ...state.sdkTools,
        ],
      },
    }))

    // Set up the special internal VSCode MCP server if necessary.
    setupVscodeSdkMcp(state.sdkClients)
  }
}

// Shared tool assembly for ask() and the get_context_usage control request.
// Closes over the mutable sdkTools/dynamicMcpState bindings so both call
// sites see late-connecting servers.
export function buildAllTools(
  state: HeadlessRunState,
  appState: AppState,
): Tools {
  const assembledTools = assembleToolPool(
    appState.toolPermissionContext,
    appState.mcp.tools,
  )
  let allTools = uniqBy(
    mergeAndFilterTools(
      [...state.tools, ...state.sdkTools, ...state.dynamicMcpState.tools],
      assembledTools,
      appState.toolPermissionContext.mode,
    ),
    'name',
  )
  if (state.options.permissionPromptToolName) {
    allTools = allTools.filter(
      tool => !toolMatchesName(tool, state.options.permissionPromptToolName!),
    )
  }
  const initJsonSchema = getInitJsonSchema()
  if (initJsonSchema && !state.options.jsonSchema) {
    const syntheticOutputResult = createSyntheticOutputTool(initJsonSchema)
    if ('tool' in syntheticOutputResult) {
      allTools = [...allTools, syntheticOutputResult.tool]
    }
  }
  return allTools
}

// Helper to apply MCP server changes - used by both mcp_set_servers control message
// and background plugin installation.
// NOTE: Nested function required - mutates closure state (state.sdkMcpConfigs, sdkClients, etc.)
export function applyMcpServerChanges(
  state: HeadlessRunState,
  servers: Record<string, McpServerConfigForProcessTransport>,
): Promise<{
  response: SDKControlMcpSetServersResponse
  sdkServersChanged: boolean
}> {
  // Serialize calls to prevent race conditions between concurrent callers
  // (background plugin install and mcp_set_servers control messages)
  const doWork = async (): Promise<{
    response: SDKControlMcpSetServersResponse
    sdkServersChanged: boolean
  }> => {
    const oldSdkClientNames = new Set(state.sdkClients.map(c => c.name))

    const result = await handleMcpSetServers(
      servers,
      {
        configs: state.sdkMcpConfigs,
        clients: state.sdkClients,
        tools: state.sdkTools,
      },
      state.dynamicMcpState,
      state.setAppState,
    )

    // Update SDK state (need to mutate state.sdkMcpConfigs since it's shared)
    for (const key of Object.keys(state.sdkMcpConfigs)) {
      delete state.sdkMcpConfigs[key]
    }
    Object.assign(state.sdkMcpConfigs, result.newSdkState.configs)
    state.sdkClients = result.newSdkState.clients
    state.sdkTools = result.newSdkState.tools
    state.dynamicMcpState = result.newDynamicState

    // Keep appState.mcp.tools in sync so subagents can see SDK MCP tools.
    // Use both old and new SDK client names to remove stale tools.
    if (result.sdkServersChanged) {
      const newSdkClientNames = new Set(state.sdkClients.map(c => c.name))
      const allSdkNames = uniq([...oldSdkClientNames, ...newSdkClientNames])
      state.setAppState(prev => ({
        ...prev,
        mcp: {
          ...prev.mcp,
          tools: [
            ...prev.mcp.tools.filter(
              t =>
                !allSdkNames.some(name =>
                  t.name.startsWith(getMcpPrefix(name)),
                ),
            ),
            ...state.sdkTools,
          ],
        },
      }))
    }

    return {
      response: result.response,
      sdkServersChanged: result.sdkServersChanged,
    }
  }

  state.mcpChangesPromise = state.mcpChangesPromise.then(doWork, doWork)
  return state.mcpChangesPromise
}

// Build McpServerStatus[] for control responses. Shared by mcp_status and
// reload_plugins handlers. Reads closure state: sdkClients, dynamicMcpState.
export function buildMcpServerStatuses(
  state: HeadlessRunState,
): McpServerStatus[] {
  const currentAppState = state.getAppState()
  const currentMcpClients = currentAppState.mcp.clients
  const allMcpTools = uniqBy(
    [...currentAppState.mcp.tools, ...state.dynamicMcpState.tools],
    'name',
  )
  const existingNames = new Set([
    ...currentMcpClients.map(c => c.name),
    ...state.sdkClients.map(c => c.name),
  ])
  return [
    ...currentMcpClients,
    ...state.sdkClients,
    ...state.dynamicMcpState.clients.filter(c => !existingNames.has(c.name)),
  ].map(connection => {
    let config
    if (connection.config.type === 'sse' || connection.config.type === 'http') {
      config = {
        type: connection.config.type,
        url: connection.config.url,
        headers: connection.config.headers,
        oauth: connection.config.oauth,
      }
    } else if (connection.config.type === 'claudeai-proxy') {
      config = {
        type: 'claudeai-proxy' as const,
        url: connection.config.url,
        id: connection.config.id,
      }
    } else if (
      connection.config.type === 'stdio' ||
      connection.config.type === undefined
    ) {
      const stdioConfig = connection.config as {
        command: string
        args: string[]
      }
      config = {
        type: 'stdio' as const,
        command: stdioConfig.command,
        args: stdioConfig.args,
      }
    }
    const serverTools =
      connection.type === 'connected'
        ? filterToolsByServer(allMcpTools, connection.name).map(tool => ({
            name: tool.mcpInfo?.toolName ?? tool.name,
            annotations: {
              readOnly: tool.isReadOnly({}) || undefined,
              destructive: tool.isDestructive?.({}) || undefined,
              openWorld: tool.isOpenWorld?.({}) || undefined,
            },
          }))
        : undefined
    // Capabilities passthrough with allowlist pre-filter. The IDE reads
    // experimental['claude/channel'] to decide whether to show the
    // Enable-channel prompt — only echo it if channel_enable would
    // actually pass the allowlist. Not a security boundary (the
    // handler re-runs the full gate); just avoids dead buttons.
    let capabilities: { experimental?: Record<string, unknown> } | undefined
    if (
      (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
      connection.type === 'connected' &&
      connection.capabilities.experimental
    ) {
      const exp = { ...connection.capabilities.experimental }
      if (
        exp['claude/channel'] &&
        (!isChannelsEnabled() ||
          !isChannelAllowlisted(connection.config.pluginSource))
      ) {
        delete exp['claude/channel']
      }
      if (Object.keys(exp).length > 0) {
        capabilities = { experimental: exp }
      }
    }
    return {
      name: connection.name,
      status: connection.type as McpServerStatus['status'],
      serverInfo:
        connection.type === 'connected' ? connection.serverInfo : undefined,
      error: connection.type === 'failed' ? connection.error : undefined,
      config,
      scope: connection.config.scope,
      tools: serverTools,
      capabilities,
    }
  }) as McpServerStatus[]
}
