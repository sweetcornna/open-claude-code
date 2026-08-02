/**
 * Plugin lifecycle for a headless session.
 *
 * Background install, the post-install cache sweep that rebuilds commands and
 * agents, and the MCP re-diff that follows a plugin-state change. These three
 * were nested inside `runHeadlessStreaming` and mutually recursive through the
 * closure (install → diff, diff → applyMcpServerChanges/updateSdkMcp); with
 * the shared bindings on `HeadlessRunState` they are plain module functions
 * and the recursion is ordinary imports.
 */
import { cwd } from 'process'
import { logEvent } from 'src/services/analytics/index.js'
import { logError } from 'src/utils/log.js'
import { logForDebugging } from 'src/utils/debug.js'
import { withDiagnosticsTiming } from 'src/utils/diagLogs.js'
import { getCommands } from 'src/commands.js'
import { getAllMcpConfigs } from 'src/services/mcp/config.js'
import type { McpServerConfigForProcessTransport } from 'src/entrypoints/agentSdkTypes.js'
import { waitForRemoteManagedSettingsToLoad } from 'src/services/remoteManagedSettings/index.js'
import { installPluginsForHeadless } from 'src/utils/plugins/headlessPluginInstall.js'
import { refreshActivePlugins } from 'src/utils/plugins/refresh.js'
import { sleep } from 'src/utils/process/sleep.js'
import { applyMcpServerChanges, updateSdkMcp } from './headlessMcpRuntime.js'
import type { HeadlessRunState } from './headlessRunState.js'

/**
 * Background plugin installation for headless users: waits for remote
 * managed settings, installs marketplaces from extraKnownMarketplaces plus
 * any missing enabled plugins, then re-diffs MCP if anything landed.
 */
export async function installPluginsAndApplyMcpInBackground(
  state: HeadlessRunState,
): Promise<void> {
  try {
    await withDiagnosticsTiming('headless_managed_settings_wait', () =>
      waitForRemoteManagedSettingsToLoad(),
    )

    const pluginsInstalled = await installPluginsForHeadless()

    if (pluginsInstalled) {
      await applyPluginMcpDiff(state)
    }
  } catch (error) {
    logError(error)
  }
}

// Clear all plugin-related caches, reload commands/agents/hooks.
// Called after CLAUDE_CODE_SYNC_PLUGIN_INSTALL completes (before first query)
// and after non-sync background install finishes.
// refreshActivePlugins calls clearAllCaches() which is required because
// loadAllPlugins() may have run during main.tsx startup BEFORE managed
// settings were fetched. Without clearing, getCommands() would rebuild
// from a stale plugin list.
export async function refreshPluginState(
  state: HeadlessRunState,
): Promise<void> {
  // refreshActivePlugins handles the full cache sweep (clearAllCaches),
  // reloads all plugin component loaders, writes AppState.plugins +
  // AppState.agentDefinitions, registers hooks, and bumps mcp.pluginReconnectKey.
  const { agentDefinitions: freshAgentDefs } = await refreshActivePlugins(
    state.setAppState,
  )

  // Headless-specific: currentCommands/currentAgents are local mutable refs
  // captured by the query loop (REPL uses AppState instead). getCommands is
  // fresh because refreshActivePlugins cleared its cache.
  state.currentCommands = await getCommands(cwd())

  // Preserve SDK-provided agents (--agents CLI flag or SDK initialize
  // control_request) — both inject via parseAgentsFromJson with
  // source='flagSettings'. loadMarkdownFilesForSubdir never assigns this
  // source, so it cleanly discriminates "injected, not disk-loadable".
  //
  // The previous filter used a negative set-diff (!freshAgentTypes.has(a))
  // which also matched plugin agents that were in the poisoned initial
  // currentAgents but correctly excluded from freshAgentDefs after managed
  // settings applied — leaking policy-blocked agents into the init message.
  // See gh-23085: isBridgeEnabled() at Commander-definition time poisoned
  // the settings cache before setEligibility(true) ran.
  const sdkAgents = state.currentAgents.filter(a => a.source === 'flagSettings')
  state.currentAgents = [...freshAgentDefs.allAgents, ...sdkAgents]
}

// Re-diff MCP configs after plugin state changes. Filters to
// process-transport-supported types and carries SDK-mode servers through
// so applyMcpServerChanges' diff doesn't close their transports.
// Nested: needs closure access to state.sdkMcpConfigs, applyMcpServerChanges,
// updateSdkMcp.
export async function applyPluginMcpDiff(
  state: HeadlessRunState,
): Promise<void> {
  const { servers: newConfigs } = await getAllMcpConfigs()
  const supportedConfigs: Record<string, McpServerConfigForProcessTransport> =
    {}
  for (const [name, config] of Object.entries(newConfigs)) {
    const type = config.type
    if (
      type === undefined ||
      type === 'stdio' ||
      type === 'sse' ||
      type === 'http' ||
      type === 'sdk'
    ) {
      supportedConfigs[name] = config as McpServerConfigForProcessTransport
    }
  }
  for (const [name, config] of Object.entries(state.sdkMcpConfigs)) {
    if (config.type === 'sdk' && !(name in supportedConfigs)) {
      supportedConfigs[name] =
        config as unknown as McpServerConfigForProcessTransport
    }
  }
  const { response, sdkServersChanged } = await applyMcpServerChanges(
    state,
    supportedConfigs,
  )
  if (sdkServersChanged) {
    void updateSdkMcp(state)
  }
  logForDebugging(
    `Headless MCP refresh: added=${response.added.length}, removed=${response.removed.length}`,
  )
}

/**
 * Resolve deferred plugin installation (CLAUDE_CODE_SYNC_PLUGIN_INSTALL).
 * The promise was started eagerly so installation overlaps with other init.
 * Awaiting here guarantees plugins are available before the first ask().
 * If CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS is set, races against that
 * deadline and proceeds without plugins on timeout (logging an error).
 */
export async function resolveDeferredPluginInstall(
  state: HeadlessRunState,
): Promise<void> {
  if (!state.pluginInstallPromise) {
    return
  }
  const timeoutMs = parseInt(
    process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS || '',
    10,
  )
  if (timeoutMs > 0) {
    const timeout = sleep(timeoutMs).then(() => 'timeout' as const)
    const result = await Promise.race([state.pluginInstallPromise, timeout])
    if (result === 'timeout') {
      logError(
        new Error(
          `CLAUDE_CODE_SYNC_PLUGIN_INSTALL: plugin installation timed out after ${timeoutMs}ms`,
        ),
      )
      logEvent('tengu_sync_plugin_install_timeout', {
        timeout_ms: timeoutMs,
      })
    }
  } else {
    await state.pluginInstallPromise
  }
  state.pluginInstallPromise = null

  // Refresh commands, agents, and hooks now that plugins are installed
  await refreshPluginState(state)

  // Set up hot-reload for plugin hooks now that the initial install is done.
  // In sync-install mode, setup.ts skips this to avoid racing with the install.
  const { setupPluginHookHotReload } = await import(
    '../../utils/plugins/loadPluginHooks.js'
  )
  setupPluginHookHotReload()
}
