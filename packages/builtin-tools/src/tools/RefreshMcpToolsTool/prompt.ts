/** Name lives here so the inventory can import it without the implementation. */
export const REFRESH_MCP_TOOLS_TOOL_NAME = 'RefreshMcpTools'

/**
 * Upstream wording, kept close to verbatim.
 *
 * The trigger list is the point of this description. Without it the model has no way to
 * connect "my desktop IS open now" — a sentence about the user's world — to an action in
 * its own world, and will keep re-calling a tool that fails with device-not-connected.
 */
export const DESCRIPTION = `Re-queries the tool list of connected MCP servers and updates the set of available tools, reporting which tools were added or removed.

MCP servers normally push a notification when their tool list changes, but that notification can be missed (connection hiccups, a device announcing while the notification stream was down). Use this tool to re-sync when the available tools may be out of date. Good triggers:
- The user says a device or app is now open or connected (e.g. "my desktop IS open", "I just started the app") after a tool call failed with device-not-connected or the expected tools are missing.
- A tool you expect an MCP server to provide is absent from your available tools.
- A server's tools look stale after its connection recovered.

The refreshed tools are available immediately — you can call them on your next step.

Usage:
- Refresh all connected servers: \`RefreshMcpTools\` with no arguments
- Refresh one server: \`RefreshMcpTools({ server: "myserver" })\`
`

export const PROMPT = `Re-query the tool lists of connected MCP servers and update the available tools.

Returns one entry per server: the server name, refresh status, current tool count, and which tool names were added or removed relative to what was previously available. Servers that are not currently connected are reported as not_connected (this tool never dials or re-dials connections — it only re-reads the tool list over the existing connection).

Parameters:
- server (optional): The name of a specific MCP server to refresh. If not provided, all connected servers are refreshed.
`
