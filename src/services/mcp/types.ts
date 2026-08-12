import type {
  Client,
  Resource,
  ServerCapabilities,
} from '@modelcontextprotocol/client'
import { z } from 'zod/v4'
import { lazySchema } from '../../utils/collections/lazySchema.js'

// Configuration schemas and types
export const ConfigScopeSchema = lazySchema(() =>
  z.enum([
    'local',
    'user',
    'project',
    'dynamic',
    'enterprise',
    'claudeai',
    'managed',
  ]),
)
export type ConfigScope = z.infer<ReturnType<typeof ConfigScopeSchema>>

export const TransportSchema = lazySchema(() =>
  z.enum(['stdio', 'sse', 'sse-ide', 'http', 'ws', 'sdk', 'claudeai-proxy']),
)
export type Transport = z.infer<ReturnType<typeof TransportSchema>>

// Per-server tool-call timeout override (.mcp.json / settings mcpServers),
// official 2.1.206 parity. Consumed in client.ts callMCPTool — falls back to
// MCP_TOOL_TIMEOUT env / the (effectively unlimited) default when absent.
const McpTimeoutFields = {
  request_timeout_ms: z.number().int().positive().optional(),
}

// Per-server opt-out of tool-search deferral (.mcp.json / settings mcpServers).
// Consumed in client.ts when building each MCP Tool; `serverAlwaysLoad` below
// is the single reader. Only offered on the transports a user actually writes
// by hand — the IDE, SDK and claude.ai-proxy variants are constructed
// internally and have no config file to put this in.
const McpDeferralFields = {
  alwaysLoad: z
    .boolean()
    .optional()
    .describe(
      'When true, every tool from this server is loaded into the prompt directly instead of being deferred behind SearchExtraTools. Best-effort on turn 1: occ deliberately never blocks startup on MCP, so a server that has not finished connecting yet contributes its tools from the next turn onward.',
    ),
}

export const McpStdioServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('stdio').optional(), // Optional for backwards compatibility
    command: z.string().min(1, 'Command cannot be empty'),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    ...McpDeferralFields,
    ...McpTimeoutFields,
  }),
)

// Cross-App Access (XAA / SEP-990): just a per-server flag. IdP connection
// details (issuer, clientId, callbackPort) come from settings.xaaIdp — configured
// once, shared across all XAA-enabled servers. clientId/clientSecret (parent
// oauth config + keychain slot) are for the MCP server's AS.
const McpXaaConfigSchema = lazySchema(() => z.boolean())

const McpOAuthConfigSchema = lazySchema(() =>
  z.object({
    clientId: z.string().optional(),
    callbackPort: z.number().int().positive().optional(),
    authServerMetadataUrl: z
      .string()
      .url()
      .startsWith('https://', {
        message: 'authServerMetadataUrl must use https://',
      })
      .optional(),
    xaa: McpXaaConfigSchema().optional(),
  }),
)

export const McpSSEServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sse'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    headersHelper: z.string().optional(),
    oauth: McpOAuthConfigSchema().optional(),
    ...McpDeferralFields,
    ...McpTimeoutFields,
  }),
)

// Internal-only server type for IDE extensions
export const McpSSEIDEServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sse-ide'),
    url: z.string(),
    ideName: z.string(),
    ideRunningInWindows: z.boolean().optional(),
  }),
)

// Internal-only server type for IDE extensions
export const McpWebSocketIDEServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('ws-ide'),
    url: z.string(),
    ideName: z.string(),
    authToken: z.string().optional(),
    ideRunningInWindows: z.boolean().optional(),
  }),
)

export const McpHTTPServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('http'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    headersHelper: z.string().optional(),
    oauth: McpOAuthConfigSchema().optional(),
    ...McpDeferralFields,
    ...McpTimeoutFields,
  }),
)

export const McpWebSocketServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('ws'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    headersHelper: z.string().optional(),
    ...McpDeferralFields,
    ...McpTimeoutFields,
  }),
)

export const McpSdkServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sdk'),
    name: z.string(),
  }),
)

// Config type for Claude.ai proxy servers
export const McpClaudeAIProxyServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('claudeai-proxy'),
    url: z.string(),
    id: z.string(),
  }),
)

export const McpServerConfigSchema = lazySchema(() =>
  z.union([
    McpStdioServerConfigSchema(),
    McpSSEServerConfigSchema(),
    McpSSEIDEServerConfigSchema(),
    McpWebSocketIDEServerConfigSchema(),
    McpHTTPServerConfigSchema(),
    McpWebSocketServerConfigSchema(),
    McpSdkServerConfigSchema(),
    McpClaudeAIProxyServerConfigSchema(),
  ]),
)

export type McpStdioServerConfig = z.infer<
  ReturnType<typeof McpStdioServerConfigSchema>
>
export type McpSSEServerConfig = z.infer<
  ReturnType<typeof McpSSEServerConfigSchema>
>
export type McpSSEIDEServerConfig = z.infer<
  ReturnType<typeof McpSSEIDEServerConfigSchema>
>
export type McpWebSocketIDEServerConfig = z.infer<
  ReturnType<typeof McpWebSocketIDEServerConfigSchema>
>
export type McpHTTPServerConfig = z.infer<
  ReturnType<typeof McpHTTPServerConfigSchema>
>
export type McpWebSocketServerConfig = z.infer<
  ReturnType<typeof McpWebSocketServerConfigSchema>
>
export type McpSdkServerConfig = z.infer<
  ReturnType<typeof McpSdkServerConfigSchema>
>
export type McpClaudeAIProxyServerConfig = z.infer<
  ReturnType<typeof McpClaudeAIProxyServerConfigSchema>
>
export type McpServerConfig = z.infer<ReturnType<typeof McpServerConfigSchema>>

/**
 * True when the user asked for this server's tools to skip deferral.
 *
 * Only the hand-written transports carry the field, so this narrows rather
 * than reading it off the union blindly.
 */
export function serverAlwaysLoad(config: McpServerConfig): boolean {
  return 'alwaysLoad' in config && config.alwaysLoad === true
}

export type ScopedMcpServerConfig = McpServerConfig & {
  scope: ConfigScope
  // For plugin-provided servers: the providing plugin's LoadedPlugin.source
  // (e.g. 'slack@anthropic'). Stashed at config-build time so the channel
  // gate doesn't have to race AppState.plugins.enabled hydration.
  pluginSource?: string
}

export const McpJsonConfigSchema = lazySchema(() =>
  z.object({
    mcpServers: z.record(z.string(), McpServerConfigSchema()),
  }),
)

export type McpJsonConfig = z.infer<ReturnType<typeof McpJsonConfigSchema>>

// Server connection types
export type ConnectedMCPServer = {
  client: Client
  name: string
  type: 'connected'
  capabilities: ServerCapabilities
  serverInfo?: {
    name: string
    version: string
  }
  instructions?: string
  config: ScopedMcpServerConfig
  cleanup: () => Promise<void>
}

export type FailedMCPServer = {
  name: string
  type: 'failed'
  config: ScopedMcpServerConfig
  error?: string
}

export type NeedsAuthMCPServer = {
  name: string
  type: 'needs-auth'
  config: ScopedMcpServerConfig
}

export type PendingMCPServer = {
  name: string
  type: 'pending'
  config: ScopedMcpServerConfig
  reconnectAttempt?: number
  maxReconnectAttempts?: number
}

export type DisabledMCPServer = {
  name: string
  type: 'disabled'
  config: ScopedMcpServerConfig
}

export type MCPServerConnection =
  | ConnectedMCPServer
  | FailedMCPServer
  | NeedsAuthMCPServer
  | PendingMCPServer
  | DisabledMCPServer

// Resource types
export type ServerResource = Resource & { server: string }

// MCP CLI State types
export interface SerializedTool {
  name: string
  description: string
  inputJSONSchema?: {
    [x: string]: unknown
    type: 'object'
    properties?: {
      [x: string]: unknown
    }
  }
  isMcp?: boolean
  originalToolName?: string // Original unnormalized tool name from MCP server
}

export interface SerializedClient {
  name: string
  type: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  capabilities?: ServerCapabilities
}

export interface MCPCliState {
  clients: SerializedClient[]
  configs: Record<string, ScopedMcpServerConfig>
  tools: SerializedTool[]
  resources: Record<string, ServerResource[]>
  normalizedNames?: Record<string, string> // Maps normalized names to original names
}
