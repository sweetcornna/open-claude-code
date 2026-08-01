import {
  buildComputerUseTools,
  createComputerUseMcpServer,
} from '@ant/computer-use-mcp'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { initializeAnalyticsSink } from '../../services/analytics/sink.js'
import { homedir } from 'os'

import { shutdownDatadog } from '../../services/analytics/datadog.js'
import { shutdown1PEventLogging } from '../../services/analytics/firstPartyEventLogger.js'

import { enableConfigs } from '../config.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import { filterAppsForDescription } from './appNames.js'
import { getChicagoCoordinateMode } from './gates.js'
import { getComputerUseHostAdapter } from './hostAdapter.js'

const APP_ENUM_TIMEOUT_MS = 1000

/**
 * Enumerate installed apps, timed. Fails soft — if Spotlight is slow or
 * claude-swift throws, the tool description just omits the list. Resolution
 * happens at call time regardless; the model just doesn't get hints.
 */
async function tryGetInstalledAppNames(): Promise<string[] | undefined> {
  const adapter = getComputerUseHostAdapter()
  const enumP = adapter.executor.listInstalledApps()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutP = new Promise<undefined>(resolve => {
    timer = setTimeout(resolve, APP_ENUM_TIMEOUT_MS, undefined)
  })
  const installed = await Promise.race([enumP, timeoutP])
    .catch(() => undefined)
    .finally(() => clearTimeout(timer))
  if (!installed) {
    // The enumeration continues in the background — swallow late rejections.
    void enumP.catch(() => {})
    logForDebugging(
      `[Computer Use MCP] app enumeration exceeded ${APP_ENUM_TIMEOUT_MS}ms or failed; tool description omits list`,
    )
    return undefined
  }
  return filterAppsForDescription(installed, homedir())
}

/**
 * Build one server instance. Delegates to the package's
 * `createComputerUseMcpServer` for the Server object + stub CallTool handler,
 * then REPLACES the ListTools handler with one that includes installed-app
 * names in the `request_access` description (the package's factory doesn't
 * take `installedAppNames`, and Cowork builds its own tool array in
 * serverDef.ts for the same reason).
 *
 * Synchronous on purpose: the app enumeration it needs is awaited once by the
 * caller and threaded in, so `serveStdio` can call this as its per-connection
 * factory without paying the 1s timeout again.
 */
function buildServer(
  installedAppNames: string[] | undefined,
): ReturnType<typeof createComputerUseMcpServer> {
  const adapter = getComputerUseHostAdapter()
  const coordinateMode = getChicagoCoordinateMode()
  const server = createComputerUseMcpServer(adapter, coordinateMode)

  const tools = buildComputerUseTools(
    adapter.executor.capabilities,
    coordinateMode,
    installedAppNames,
  )
  server.setRequestHandler('tools/list', async () =>
    adapter.isDisabled() ? { tools: [] } : { tools },
  )

  return server
}

/**
 * Construct the in-process server — the single instance `client.ts` hands one
 * end of a linked transport pair to on first CU connection.
 *
 * Async so the 1s app-enumeration timeout doesn't block startup — called from
 * an `await import()` in `client.ts` on first CU connection, not `main.tsx`.
 *
 * Real dispatch still goes through `wrapper.tsx`'s `.call()` override; this
 * server exists only to answer ListTools.
 */
export async function createComputerUseMcpServerForCli(): Promise<
  ReturnType<typeof createComputerUseMcpServer>
> {
  const installedAppNames = await tryGetInstalledAppNames()
  return buildServer(installedAppNames)
}

/**
 * Subprocess entrypoint for `--computer-use-mcp`. Mirror of
 * the Chrome MCP server it was modelled on — stdio transport, exit on stdin close,
 * flush analytics before exit.
 *
 * `serveStdio` owns both the transport and the era decision: it starts the
 * stdio transport synchronously (so the process stays alive on stdin exactly
 * as the `server.connect(new StdioServerTransport())` call it replaces did),
 * inspects the opening exchange, and pins one instance for the connection.
 */
export async function runComputerUseMcpServer(): Promise<void> {
  enableConfigs()
  initializeAnalyticsSink()

  const installedAppNames = await tryGetInstalledAppNames()

  let exiting = false
  const shutdownAndExit = async (): Promise<void> => {
    if (exiting) return
    exiting = true
    await Promise.all([shutdown1PEventLogging(), shutdownDatadog()])
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  }
  process.stdin.on('end', () => void shutdownAndExit())
  process.stdin.on('error', () => void shutdownAndExit())

  logForDebugging('[Computer Use MCP] Starting MCP server')
  // The factory MUST return a fresh Server per call, never a captured one: a
  // `server/discover` opening builds a probe instance, and a 2025-era message
  // after it makes `serveStdio` close that probe and call the factory AGAIN
  // for the legacy fallback. A captured instance would be reconnected after
  // its own `close()`.
  serveStdio(() => buildServer(installedAppNames), { onerror: logError })
  logForDebugging('[Computer Use MCP] MCP server started')
}
