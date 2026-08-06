/**
 * Names and tool inventory for the browser-use MCP integration.
 *
 * Kept dependency-light on purpose: the reserved-name check in `mcp/config.ts`
 * runs during startup and must not drag the config stack in with it.
 */
import { normalizeNameForMCP } from '../../services/mcp/normalization.js'

/** The MCP server name. Matches the name browser-use documents. */
export const BROWSER_USE_MCP_SERVER_NAME = 'browser-use'

/** Prefix every browser-use tool carries once namespaced by the MCP layer. */
export const BROWSER_USE_TOOL_PREFIX = `mcp__${BROWSER_USE_MCP_SERVER_NAME}__`

/** Overrides which browser backend `--chrome` attaches. See browserBackend.ts. */
export const BROWSER_BACKEND_ENV = 'OCC_BROWSER_BACKEND'

/**
 * Tools `browser-use --mcp` exposes.
 *
 * Recorded here so the read-only subset below can be checked against something
 * — an allowlist entry naming a tool the server does not have is silently
 * inert, which is the kind of mistake that only shows up as an unexpected
 * permission prompt months later.
 */
export const BROWSER_USE_TOOLS: readonly string[] = [
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_get_state',
  'browser_scroll',
  'browser_go_back',
  'browser_list_tabs',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_extract_content',
  'browser_list_sessions',
  'browser_close_session',
  'browser_close_all',
  'retry_with_browser_use_agent',
]

/**
 * The subset pre-approved in `allowedTools`, i.e. the tools that skip the
 * permission prompt.
 *
 * Strictly observational: they read what is already on screen or enumerate
 * sessions, and never navigate, click, type, or close anything. Everything else
 * — including `browser_navigate`, `browser_close_tab` and the autonomous
 * `retry_with_browser_use_agent` — goes through the normal MCP permission flow,
 * because this server drives a real browser.
 */
export const BROWSER_USE_READ_ONLY_TOOLS: readonly string[] = [
  'browser_get_state',
  'browser_extract_content',
  'browser_list_tabs',
  'browser_list_sessions',
]

/** Whether `name` refers to the built-in browser-use MCP server. */
export function isBrowserUseMCPServer(name: string): boolean {
  return normalizeNameForMCP(name) === BROWSER_USE_MCP_SERVER_NAME
}
