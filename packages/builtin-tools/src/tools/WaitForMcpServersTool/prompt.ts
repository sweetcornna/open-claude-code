/**
 * Name lives here rather than in the tool module so `src/constants/tools.ts` and the
 * inventory can import it without dragging in the implementation.
 */
export const WAIT_FOR_MCP_SERVERS_TOOL_NAME = 'WaitForMcpServers'

/**
 * Upstream wording, kept close to verbatim.
 *
 * The load-bearing sentences are the two about what happens *after* the wait: that the
 * server's tools land in the tool list and can be called directly (so the model does not
 * go looking for another indirection), and that `ready=false` covers three different
 * situations it must not retry blindly.
 */
export const DESCRIPTION = [
  'Wait for MCP servers that are still connecting and whose tools are not',
  'yet in your tool list. Pass `servers` to wait for specific ones, or omit',
  'it to wait for all pending servers.',
  '',
  "If the user's request needs tools from a still-connecting server, call this",
  'tool to wait for it. Once it connects, its tools will be added to your tool',
  'list and you can use them directly. Returns ready=true when servers are',
  'ready, ready=false if they failed to connect, need authentication, or are',
  'disabled.',
  '',
  'You do not need to ask the user for confirmation to use this tool.',
].join('\n')
