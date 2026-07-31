/**
 * Names and tool inventory for the Chrome DevTools MCP integration.
 *
 * Kept dependency-light on purpose: `mcp/config.ts` and `main.tsx` import the
 * server-name predicate during startup, and pulling the setup module (which
 * reads global config) in from there would drag the config stack into the
 * reserved-name check.
 */
import { normalizeNameForMCP } from '../../services/mcp/normalization.js'

/**
 * The MCP server name. Matches the name Google documents for
 * `chrome-devtools-mcp`, so tool names in transcripts line up with upstream
 * docs and with every other client's configuration.
 */
export const CHROME_DEVTOOLS_MCP_SERVER_NAME = 'chrome-devtools'

/** Prefix every Chrome DevTools tool carries once namespaced by the MCP layer. */
export const CHROME_DEVTOOLS_TOOL_PREFIX = `mcp__${CHROME_DEVTOOLS_MCP_SERVER_NAME}__`

/**
 * Minimum Chrome major version that can be attached to with `--autoConnect`.
 * Below this, chrome-devtools-mcp launches its own (logged-out) browser.
 */
export const CHROME_AUTOCONNECT_MIN_MAJOR = 144

/**
 * Environment override that switches the server from `--autoConnect` to
 * `--browserUrl <url>`. This is the WSL/remote path: Chrome runs on the
 * Windows side (or another host) with `--remote-debugging-port`, and occ
 * attaches over HTTP instead of trying to drive a browser that does not exist
 * inside the Linux namespace.
 */
export const CHROME_BROWSER_URL_ENV = 'OCC_CHROME_BROWSER_URL'

/** Set to a falsy value to stop passing `--autoConnect`. */
export const CHROME_AUTOCONNECT_ENV = 'OCC_CHROME_AUTOCONNECT'

/**
 * Tools chrome-devtools-mcp 1.x exposes with our argument set (default
 * categories: emulation, performance, network; extensions/third-party/webmcp
 * and the coordinate-based and screencast tools stay off).
 *
 * Verified against the running server rather than the README — `tools/list`
 * over stdio on chrome-devtools-mcp@1.6.0 returns exactly these 29.
 */
export const CHROME_DEVTOOLS_TOOLS: readonly string[] = [
  'click',
  'close_page',
  'drag',
  'emulate',
  'evaluate_script',
  'fill',
  'fill_form',
  'get_console_message',
  'get_network_request',
  'handle_dialog',
  'hover',
  'lighthouse_audit',
  'list_console_messages',
  'list_network_requests',
  'list_pages',
  'navigate_page',
  'new_page',
  'performance_analyze_insight',
  'performance_start_trace',
  'performance_stop_trace',
  'press_key',
  'resize_page',
  'select_page',
  'take_heapsnapshot',
  'take_screenshot',
  'take_snapshot',
  'type_text',
  'upload_file',
  'wait_for',
]

/**
 * The subset pre-approved in `allowedTools`, i.e. the tools that skip the
 * permission prompt.
 *
 * Strictly observational: they read what is already on screen and never
 * navigate, click, type, run script, or mutate browser state. Everything else
 * — including `navigate_page`, `evaluate_script`, `select_page`, `emulate` and
 * the trace/audit tools that reload the page — goes through the normal MCP
 * permission prompt, because this server drives the user's real, logged-in
 * Chrome profile.
 */
export const CHROME_DEVTOOLS_READ_ONLY_TOOLS: readonly string[] = [
  'get_console_message',
  'get_network_request',
  'list_console_messages',
  'list_network_requests',
  'list_pages',
  'performance_analyze_insight',
  'take_screenshot',
  'take_snapshot',
  'wait_for',
]

/** Whether `name` refers to the built-in Chrome DevTools MCP server. */
export function isChromeDevtoolsMCPServer(name: string): boolean {
  return normalizeNameForMCP(name) === CHROME_DEVTOOLS_MCP_SERVER_NAME
}
