import {
  type CallToolResult,
  type ListToolsResult,
  type McpServerFactory,
  Server,
  type Tool as McpTool,
} from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import type { ZodType } from 'zod/v4'
import review from '../commands/review.js'
import type { Command } from '../commands.js'
import {
  findToolByName,
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from '../Tool.js'
import { getTools } from '../tools.js'
import { createAbortController } from '../utils/abortController.js'
import { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
import { logError } from '../utils/log.js'
import { createAssistantMessage } from '../utils/messages.js'
import { getMainLoopModel } from '../utils/model/model.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import { setCwd } from '../utils/Shell.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { getErrorParts } from '../utils/toolErrors.js'
import { zodToJsonSchema } from '../utils/zodToJsonSchema.js'

type ToolInput = McpTool['inputSchema']
type ToolOutput = McpTool['outputSchema']

const MCP_COMMANDS: Command[] = [review]

// Use size-limited LRU cache for readFileState to prevent unbounded memory growth
// 100 files and 25MB limit should be sufficient for MCP server operations
const READ_FILE_STATE_CACHE_SIZE = 100

/**
 * The output schema we actually advertise for a tool, or `undefined` when we
 * advertise none.
 *
 * MCP requires `outputSchema` to have `type: "object"` at the root, so schemas
 * with `anyOf`/`oneOf` at the root (from `z.union`, `z.discriminatedUnion`,
 * etc.) are dropped.
 * See: https://github.com/anthropics/claude-code/issues/8014
 *
 * `tools/call` has to agree with `tools/list` here: a client that has listed
 * the tools rejects a result with no `structuredContent` whenever an output
 * schema was advertised for it.
 */
function advertisedOutputSchema(
  outputSchema: ZodType<unknown> | undefined,
): ToolOutput | undefined {
  if (!outputSchema) {
    return undefined
  }
  const convertedSchema = zodToJsonSchema(outputSchema)
  if (
    typeof convertedSchema === 'object' &&
    convertedSchema !== null &&
    'type' in convertedSchema &&
    convertedSchema.type === 'object'
  ) {
    return convertedSchema as ToolOutput
  }
  return undefined
}

/**
 * Builds the per-connection MCP server factory that exposes occ's builtin
 * tools.
 *
 * `serveStdio` owns the era decision: it inspects the opening exchange, calls
 * this factory once, and pins that instance for the connection lifetime. The
 * same registered handlers therefore serve both a 2025-era `initialize`
 * handshake and a 2026-07-28 stateless client — the handler bodies are
 * era-agnostic.
 */
export function createMcpServerFactory(
  debug: boolean,
  verbose: boolean,
): McpServerFactory {
  return () => {
    const readFileStateCache = createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    )

    const server = new Server(
      {
        name: 'claude/tengu',
        version: MACRO.VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      },
    )

    server.setRequestHandler(
      'tools/list',
      async (): Promise<ListToolsResult> => {
        // TODO: Also re-expose any MCP tools
        const toolPermissionContext = getEmptyToolPermissionContext()
        const tools = getTools(toolPermissionContext)
        return {
          tools: await Promise.all(
            tools.map(async tool => ({
              ...tool,
              description: await tool.prompt({
                getToolPermissionContext: async () => toolPermissionContext,
                tools,
                agents: [],
              }),
              inputSchema: zodToJsonSchema(tool.inputSchema) as ToolInput,
              outputSchema: advertisedOutputSchema(tool.outputSchema),
            })),
          ),
        }
      },
    )

    server.setRequestHandler(
      'tools/call',
      async ({
        params: { name, arguments: args },
      }): Promise<CallToolResult> => {
        const toolPermissionContext = getEmptyToolPermissionContext()
        // TODO: Also re-expose any MCP tools
        const tools = getTools(toolPermissionContext)
        const tool = findToolByName(tools, name)
        if (!tool) {
          throw new Error(`Tool ${name} not found`)
        }

        // Assume MCP servers do not read messages separately from the tool
        // call arguments.
        const toolUseContext: ToolUseContext = {
          abortController: createAbortController(),
          options: {
            commands: MCP_COMMANDS,
            tools,
            mainLoopModel: getMainLoopModel(),
            thinkingConfig: { type: 'disabled' },
            mcpClients: [],
            mcpResources: {},
            isNonInteractiveSession: true,
            debug,
            verbose,
            agentDefinitions: { activeAgents: [], allAgents: [] },
          },
          getAppState: () => getDefaultAppState(),
          setAppState: () => {},
          messages: [],
          readFileState: readFileStateCache,
          setInProgressToolUseIDs: () => {},
          setResponseLength: () => {},
          updateFileHistoryState: () => {},
          updateAttributionState: () => {},
        }

        // TODO: validate input types with zod
        try {
          if (!tool.isEnabled()) {
            throw new Error(`Tool ${name} is not enabled`)
          }
          const validationResult = await tool.validateInput?.(
            (args as never) ?? {},
            toolUseContext,
          )
          if (validationResult && !validationResult.result) {
            throw new Error(
              `Tool ${name} input is invalid: ${'message' in validationResult ? validationResult.message : String(validationResult)}`,
            )
          }
          const finalResult = await tool.call(
            (args ?? {}) as never,
            toolUseContext,
            hasPermissionsToUseTool,
            createAssistantMessage({
              content: [],
            }),
          )

          // Mirror `tools/list`: when an output schema was advertised, the
          // result MUST carry `structuredContent` or a conforming client
          // rejects it as a protocol violation.
          const structuredContent =
            typeof finalResult !== 'string' &&
            advertisedOutputSchema(tool.outputSchema) !== undefined &&
            typeof finalResult.data === 'object' &&
            finalResult.data !== null
              ? (finalResult.data as Record<string, unknown>)
              : undefined

          return {
            content: [
              {
                type: 'text' as const,
                text:
                  typeof finalResult === 'string'
                    ? finalResult
                    : jsonStringify(finalResult.data),
              },
            ],
            ...(structuredContent !== undefined ? { structuredContent } : {}),
          }
        } catch (error) {
          logError(error)

          const parts =
            error instanceof Error ? getErrorParts(error) : [String(error)]
          const errorText = parts.filter(Boolean).join('\n').trim() || 'Error'

          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: errorText,
              },
            ],
          }
        }
      },
    )

    return server
  }
}

export async function startMCPServer(
  cwd: string,
  debug: boolean,
  verbose: boolean,
): Promise<void> {
  setCwd(cwd)
  // `serveStdio` installs its callbacks and starts the stdio transport
  // synchronously, so the process stays alive on stdin exactly as the
  // v1 `server.connect(new StdioServerTransport())` call it replaces did.
  serveStdio(createMcpServerFactory(debug, verbose), {
    onerror: logError,
  })
}
