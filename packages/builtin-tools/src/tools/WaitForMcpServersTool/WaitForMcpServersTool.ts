import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '@open-claude-code/tool-runtime/Tool.js'
import { lazySchema } from '@open-claude-code/tool-runtime/lazySchema.js'
import { normalizeNameForMCP } from 'src/services/mcp/normalization.js'
import type { MCPServerConnection } from 'src/services/mcp/types.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import { DESCRIPTION, WAIT_FOR_MCP_SERVERS_TOOL_NAME } from './prompt.js'

/**
 * Ceiling on a single wait, matching upstream.
 *
 * Deliberately short. This tool exists to close the gap between "the model wants a
 * server's tools" and "the connection finished" — a gap measured in hundreds of
 * milliseconds for a healthy stdio server. A server that has not connected in five
 * seconds is not slow, it is stuck, and the useful answer is the status breakdown so
 * the model can route around it rather than a longer block.
 */
const MAX_WAIT_MS = 5_000

/** Poll interval while waiting. */
const POLL_INTERVAL_MS = 50

const inputSchema = lazySchema(() =>
  z.object({
    servers: z
      .array(z.string())
      .optional()
      .describe('Server names to wait for (default: all pending)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    ready: z
      .boolean()
      .describe('True when nothing requested is still pending or unusable'),
    connected: z.array(z.string()),
    failed: z.array(z.string()),
    stillPending: z.array(z.string()),
    needsAuth: z.array(z.string()),
    disabled: z.array(z.string()),
    unknown: z.array(z.string()),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export const WaitForMcpServersTool = buildTool({
  name: WAIT_FOR_MCP_SERVERS_TOOL_NAME,
  searchHint:
    'wait for pending MCP servers to finish connecting before using their tools',
  shouldDefer: true,
  maxResultSizeChars: 10_000,
  // Not concurrency-safe: it is a barrier. Running it alongside the calls it is
  // supposed to gate defeats the point.
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.servers?.join(', ') ?? ''
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  // Waiting reads nothing and changes nothing; a permission prompt here would ask the
  // user to approve the act of being patient.
  async checkPermissions(input) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input, context) {
    const {
      abortController,
      options: { mcpClients },
    } = context

    // The live connection list has to be re-read on every tick: `options.mcpClients` is
    // the snapshot taken when the turn started, and the whole point of this tool is to
    // observe a transition that happens after that. AppState wins on name collision
    // because it is the side the connection manager writes; the snapshot still supplies
    // any session-constant server AppState has not learned about (headless, SDK).
    const liveClients = (): MCPServerConnection[] => {
      const fromState = context.getAppState().mcp?.clients ?? []
      if (fromState.length === 0) return [...mcpClients]
      const byName = new Map(mcpClients.map(client => [client.name, client]))
      for (const client of fromState) byName.set(client.name, client)
      return [...byName.values()]
    }

    const requested =
      input.servers && input.servers.length > 0
        ? input.servers
        : liveClients()
            .filter(client => client.type === 'pending')
            .map(client => client.name)

    // Match normalized as well as literally: the model has usually only seen the
    // server name through an `mcp__<normalized>__tool` name, so asking for the
    // normalized spelling must not come back as "unknown".
    const normalized = new Set(requested.map(normalizeNameForMCP))
    const matching = () =>
      liveClients().filter(
        client =>
          requested.includes(client.name) ||
          normalized.has(normalizeNameForMCP(client.name)),
      )

    const startedAt = Date.now()
    const deadline = startedAt + MAX_WAIT_MS
    while (
      matching().some(client => client.type === 'pending') &&
      Date.now() < deadline &&
      !abortController.signal.aborted
    ) {
      await sleep(POLL_INTERVAL_MS, abortController.signal)
    }

    const connected: string[] = []
    const failed: string[] = []
    const stillPending: string[] = []
    const needsAuth: string[] = []
    const disabled: string[] = []
    const settled = matching()
    for (const client of settled) {
      switch (client.type) {
        case 'connected':
          connected.push(client.name)
          break
        case 'failed':
          failed.push(client.name)
          break
        case 'pending':
          stillPending.push(client.name)
          break
        case 'needs-auth':
          needsAuth.push(client.name)
          break
        case 'disabled':
          disabled.push(client.name)
          break
      }
    }

    const seen = new Set(
      settled.map(client => normalizeNameForMCP(client.name)),
    )
    const unknown = requested.filter(
      name => !seen.has(normalizeNameForMCP(name)),
    )

    const ready =
      stillPending.length === 0 &&
      failed.length === 0 &&
      needsAuth.length === 0 &&
      disabled.length === 0 &&
      unknown.length === 0

    logForDebugging(
      `[WaitForMcpServers] waited=${Date.now() - startedAt}ms connected=${connected.join(',')} failed=${failed.join(',')} pending=${stillPending.join(',')} needsAuth=${needsAuth.join(',')} disabled=${disabled.join(',')} unknown=${unknown.join(',')}`,
    )

    return {
      data: {
        ready,
        connected,
        failed,
        stillPending,
        needsAuth,
        disabled,
        unknown,
      },
    }
  },
  renderToolUseMessage(input) {
    const names = input.servers?.join(', ')
    return names
      ? `Wait for MCP servers to connect: ${names}`
      : 'Wait for pending MCP servers to connect'
  },
  userFacingName: () => 'MCP Wait For Servers',
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    // Prose rather than JSON: every non-ready bucket needs a different next action from
    // the model, and naming that action inline is what keeps it from retrying a server
    // that will never connect on its own.
    const lines = [
      `ready: ${content.ready}`,
      content.connected.length
        ? `Connected (their tools are now available — call them directly): ${content.connected.join(', ')}`
        : '',
      content.failed.length
        ? `Failed to connect: ${content.failed.join(', ')}`
        : '',
      content.stillPending.length
        ? `Still connecting (try again or proceed without): ${content.stillPending.join(', ')}`
        : '',
      content.needsAuth.length
        ? `Needs authentication (ask the user to run /mcp): ${content.needsAuth.join(', ')}`
        : '',
      content.disabled.length
        ? `Disabled (ask the user to enable via /mcp): ${content.disabled.join(', ')}`
        : '',
      content.unknown.length
        ? `Unknown (no MCP server with this name is configured): ${content.unknown.join(', ')}`
        : '',
    ].filter(Boolean)
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
      is_error: !content.ready,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
