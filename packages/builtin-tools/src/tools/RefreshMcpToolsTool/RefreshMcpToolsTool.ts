import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '@open-claude-code/tool-runtime/Tool.js'
import { lazySchema } from '@open-claude-code/tool-runtime/lazySchema.js'
import { jsonStringify } from '@open-claude-code/tool-runtime/slowOperations.js'
import { normalizeNameForMCP } from 'src/services/mcp/normalization.js'
import { refreshMcpServerTools } from 'src/services/mcp/refreshTools.js'
import { DESCRIPTION, PROMPT, REFRESH_MCP_TOOLS_TOOL_NAME } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.object({
    server: z
      .string()
      .optional()
      .describe(
        'Optional server name: refresh only this server. Omit to refresh all connected servers.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.array(
    z.object({
      server: z.string().describe('Server name'),
      status: z
        .enum(['refreshed', 'error', 'not_connected'])
        .describe(
          'refreshed: tool list re-queried and applied. error: the re-query failed and the previous tool set was kept. not_connected: the server has no live connection to query (this tool never dials).',
        ),
      toolCount: z
        .number()
        .optional()
        .describe('Number of tools now available from this server'),
      added: z
        .array(z.string())
        .optional()
        .describe('Tool names this refresh added'),
      removed: z
        .array(z.string())
        .optional()
        .describe('Tool names this refresh removed'),
      error: z
        .string()
        .optional()
        .describe('Why the refresh failed or the server was unavailable'),
    }),
  ),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const RefreshMcpToolsTool = buildTool({
  name: REFRESH_MCP_TOOLS_TOOL_NAME,
  searchHint:
    'refresh or re-sync tool lists from connected MCP servers, recover missing device or server tools',
  shouldDefer: true,
  maxResultSizeChars: 50_000,
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.server ?? ''
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async call(input, context) {
    const {
      options: { mcpClients, tools },
    } = context
    const { server } = input

    const targets = server
      ? mcpClients.filter(
          client =>
            client.name === server ||
            normalizeNameForMCP(client.name) === normalizeNameForMCP(server),
        )
      : mcpClients

    if (server && targets.length === 0) {
      throw new Error(
        `Server "${server}" not found. Available servers: ${mcpClients
          .map(client => client.name)
          .join(', ')}`,
      )
    }

    // Subagents must use the shared setter, otherwise the swap lands on a state nobody
    // reads and the "refreshed" report is about tools that never entered the pool.
    const setAppState = context.setAppStateForTasks ?? context.setAppState

    // Sequential rather than Promise.all: each refresh does a read-modify-write of the
    // shared tool pool, and concurrent swaps would race on `prev.mcp.tools`.
    const results = []
    for (const client of targets) {
      results.push(await refreshMcpServerTools(client, tools, setAppState))
    }
    return { data: results }
  },
  renderToolUseMessage(input) {
    return input.server
      ? `Refresh MCP tools from server "${input.server}"`
      : 'Refresh all MCP tool lists'
  },
  userFacingName: () => 'refreshMcpTools',
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    if (!content || content.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'No MCP servers to refresh.',
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(content),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
