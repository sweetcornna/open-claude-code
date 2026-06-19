import { spawn, type ChildProcess } from 'node:child_process'
import { createServer as createHttpsServer } from 'node:https'
import { Writable, Readable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import type { WSContext } from 'hono/ws'
import type { WebSocket as RawWebSocket } from 'ws'
import { createLogger } from './logger.js'
import { getOrCreateCertificate, getLanIPs } from './cert.js'
import { RcsUpstreamClient, type RcsUpstreamConfig } from './rcs-upstream.js'
import {
  decodeJsonWsMessage,
  isJsonRpc2Message,
  WsPayloadTooLargeError,
  type JsonRpc2ClientMessage,
} from './ws-message.js'
import { authTokensEqual, extractWebSocketAuthToken } from './ws-auth.js'

export {
  MAX_CLIENT_WS_PAYLOAD_BYTES,
  isJsonRpc2Message,
  type JsonRpc2ClientMessage,
} from './ws-message.js'

// JSON-RPC 2.0 reserved error codes (spec §5.1)
const JSONRPC_PARSE_ERROR = -32700
const JSONRPC_INVALID_REQUEST = -32600
const JSONRPC_METHOD_NOT_FOUND = -32601
const JSONRPC_INVALID_PARAMS = -32602
const JSONRPC_INTERNAL_ERROR = -32603

export interface ServerConfig {
  port: number
  host: string
  command: string
  args: string[]
  cwd: string
  debug?: boolean
  token?: string
  https?: boolean
  /** Default permission mode for new sessions (e.g. "auto", "default", "bypassPermissions") */
  permissionMode?: string
  /** Channel group ID for RCS registration */
  group?: string
}

// Pending permission request
interface PendingPermission {
  resolve: (
    outcome:
      | { outcome: 'cancelled' }
      | { outcome: 'selected'; optionId: string },
  ) => void
  timeout: ReturnType<typeof setTimeout>
}

// PromptCapabilities from ACP protocol
// Reference: Zed's prompt_capabilities to check image support
interface PromptCapabilities {
  audio?: boolean
  embeddedContext?: boolean
  image?: boolean
}

// SessionModelState from ACP protocol
// Reference: Zed's AgentModelSelector reads from state.available_models
interface SessionModelState {
  availableModels: Array<{
    modelId: string
    name: string
    description?: string | null
  }>
  currentModelId: string
}

// AgentCapabilities from ACP protocol
// Reference: Zed's AcpConnection.agent_capabilities
// Matches SDK's AgentCapabilities exactly
interface AgentCapabilities {
  _meta?: Record<string, unknown> | null
  loadSession?: boolean
  mcpCapabilities?: {
    _meta?: Record<string, unknown> | null
    clientServers?: boolean
  }
  promptCapabilities?: PromptCapabilities
  sessionCapabilities?: {
    _meta?: Record<string, unknown> | null
    fork?: Record<string, unknown> | null
    list?: Record<string, unknown> | null
    resume?: Record<string, unknown> | null
  }
}

// Track connected clients and their agent connections
interface ClientState {
  process: ChildProcess | null
  connection: acp.ClientSideConnection | null
  sessionId: string | null
  pendingPermissions: Map<string, PendingPermission>
  agentCapabilities: AgentCapabilities | null
  promptCapabilities: PromptCapabilities | null
  modelState: SessionModelState | null
  isAlive: boolean
  /**
   * True when this client speaks JSON-RPC 2.0 (determined from the first
   * framed message). When true, responses are emitted as JSON-RPC responses
   * that preserve the request `id`; otherwise the legacy `{type, payload}`
   * envelope is used for backwards compatibility.
   */
  jsonRpc: boolean
  /**
   * Client-supplied identity and capabilities, captured from the JSON-RPC
   * `initialize` request or legacy `connect` payload and forwarded to the
   * agent instead of the hardcoded Zed fallback. See audit §8.7.
   */
  clientInfo: { name: string; version: string }
  clientCapabilities: Record<string, unknown>
  /** Negotiated ACP protocolVersion surfaced back to the client (audit §8.13). */
  protocolVersion: number | null
  /** Agent identity from InitializeResult.agentInfo (audit §8.13). */
  agentInfo: { name: string; version: string; [k: string]: unknown } | null
  /**
   * Currently in-flight JSON-RPC request being serviced. The proxy echoes this
   * id back in the JSON-RPC response (audit §8.2). At most one request is
   * processed per client at a time because onMessage is awaited serially.
   */
  pendingJsonRpc: {
    id: string | number | null
    /** Legacy response type the handler will emit via send(). */
    responseType: string
  } | null
}

// Default fallback client identity (used only when the client provides none)
const DEFAULT_CLIENT_INFO = Object.freeze({ name: 'zed', version: '1.0.0' })
const DEFAULT_CLIENT_CAPABILITIES = Object.freeze({
  fs: { readTextFile: true, writeTextFile: true },
})

/**
 * Create a fresh ClientState with the default fallback client identity and
 * capabilities. Used by every WebSocket open handler and the RCS relay.
 */
function createClientState(): ClientState {
  return {
    process: null,
    connection: null,
    sessionId: null,
    pendingPermissions: new Map(),
    agentCapabilities: null,
    promptCapabilities: null,
    modelState: null,
    isAlive: true,
    jsonRpc: false,
    clientInfo: { ...DEFAULT_CLIENT_INFO },
    clientCapabilities: { ...DEFAULT_CLIENT_CAPABILITIES },
    protocolVersion: null,
    agentInfo: null,
    pendingJsonRpc: null,
  }
}

// Module-level state (set when server starts)
let AGENT_COMMAND: string
let AGENT_ARGS: string[]
let AGENT_CWD: string
let SERVER_PORT: number
let SERVER_HOST: string
let AUTH_TOKEN: string | undefined
let DEFAULT_PERMISSION_MODE: string | undefined

const clients = new Map<WSContext, ClientState>()

// Module-scoped child loggers
const logWs = createLogger('ws')
const logAgent = createLogger('agent')
const logSession = createLogger('session')
const logPrompt = createLogger('prompt')
const logPerm = createLogger('perm')
const logRelay = createLogger('relay')
const logServer = createLogger('server')

// RCS upstream client (optional — enabled via ACP_RCS_URL env var)
let rcsUpstream: RcsUpstreamClient | null = null

/**
 * Create a virtual WSContext for RCS relay messages.
 * Responses via send() go to RCS upstream (not a local WS).
 */
function createRelayWs(): WSContext {
  return {
    get readyState() {
      return 1
    }, // always OPEN
    send: () => {}, // no-op — responses go through rcsUpstream.send()
    close: () => {},
    raw: null,
    isInner: false,
    url: '',
    origin: '',
    protocol: '',
  } as unknown as WSContext
}

// Permission request timeout (5 minutes)
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000

// Heartbeat interval for WebSocket ping/pong (30 seconds)
const HEARTBEAT_INTERVAL_MS = 30_000

// Generate unique request ID
function generateRequestId(): string {
  return `perm_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}

// Maps legacy notification type strings to their JSON-RPC method names so
// agent→client notifications are also emitted as JSON-RPC notifications for
// JSON-RPC 2.0 clients (audit §8.1). Notifications have no id.
const LEGACY_NOTIFICATION_TO_JSONRPC: Record<string, string> = {
  session_update: 'session/update',
  permission_request: 'session/request_permission',
}

// Send a notification/response to the WebSocket client.
//
// For legacy `{type, payload}` clients this emits the proprietary envelope.
// For JSON-RPC 2.0 clients this additionally emits a JSON-RPC response that
// echoes the in-flight request id when the message type matches the pending
// request's expected response type (audit §8.2). Agent→client notifications
// (`session_update`, `permission_request`) are emitted as JSON-RPC
// notifications without an id.
function send(ws: WSContext, type: string, payload?: unknown): void {
  if (ws.readyState === 1) {
    // WebSocket.OPEN
    ws.send(JSON.stringify({ type, payload }))
  }
  // Forward to RCS upstream if connected
  if (rcsUpstream?.isRegistered()) {
    rcsUpstream.send({ type, payload })
  }

  const state = clients.get(ws)
  if (!state?.jsonRpc) return

  // If this is the response to an in-flight JSON-RPC request, emit the
  // standard JSON-RPC result with the preserved id.
  if (state.pendingJsonRpc?.responseType === type) {
    sendJsonRpcRaw(ws, {
      jsonrpc: '2.0',
      id: state.pendingJsonRpc.id,
      result: payload ?? {},
    })
    state.pendingJsonRpc = null
    return
  }

  // Agent→client notifications are also emitted as JSON-RPC notifications
  // (no id) so JSON-RPC clients receive them in their native format.
  const notificationMethod = LEGACY_NOTIFICATION_TO_JSONRPC[type]
  if (notificationMethod) {
    sendJsonRpcRaw(ws, {
      jsonrpc: '2.0',
      method: notificationMethod,
      params: payload ?? {},
    })
  }
}

// Serialize a JSON-RPC 2.0 message and send it to a connected WS client.
function sendJsonRpcRaw(ws: WSContext, message: object): void {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message))
  }
}

/**
 * Send a JSON-RPC 2.0 error response with a reserved -32xxx code (audit §8.3).
 * Also emits the legacy `{type: 'error', payload: {message}}` envelope for
 * backwards compatibility.
 */
function sendJsonRpcError(
  ws: WSContext,
  state: ClientState | undefined,
  id: string | number | null,
  code: number,
  message: string,
): void {
  if (state?.jsonRpc) {
    sendJsonRpcRaw(ws, {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    })
  } else {
    send(ws, 'error', { message, code: String(code) })
  }
  // Error consumed the in-flight request, if any.
  if (state) state.pendingJsonRpc = null
}

// Create a Client implementation that forwards events to WebSocket
function createClient(ws: WSContext, clientState: ClientState): acp.Client {
  return {
    async requestPermission(params) {
      const requestId = generateRequestId()
      logPerm.debug({ requestId, title: params.toolCall.title }, 'requested')

      const outcomePromise = new Promise<
        { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string }
      >(resolve => {
        const timeout = setTimeout(() => {
          logPerm.warn({ requestId }, 'timed out')
          clientState.pendingPermissions.delete(requestId)
          resolve({ outcome: 'cancelled' })
        }, PERMISSION_TIMEOUT_MS)

        clientState.pendingPermissions.set(requestId, { resolve, timeout })
      })

      send(ws, 'permission_request', {
        requestId,
        sessionId: params.sessionId,
        options: params.options,
        toolCall: params.toolCall,
      })

      const outcome = await outcomePromise
      logPerm.debug({ requestId, outcome: outcome.outcome }, 'resolved')

      return { outcome }
    },

    async sessionUpdate(params) {
      send(ws, 'session_update', params)
    },

    async readTextFile(params) {
      logWs.debug({ path: params.path }, 'readTextFile')
      return { content: '' }
    },

    async writeTextFile(params) {
      logWs.debug({ path: params.path }, 'writeTextFile')
      return {}
    },
  }
}

// Handle permission response from client
function handlePermissionResponse(
  ws: WSContext,
  payload: {
    requestId: string
    outcome:
      | { outcome: 'cancelled' }
      | { outcome: 'selected'; optionId: string }
  },
): void {
  const state = clients.get(ws)
  if (!state) {
    logPerm.warn('response from unknown client')
    return
  }

  const pending = state.pendingPermissions.get(payload.requestId)
  if (!pending) {
    logPerm.warn(
      { requestId: payload.requestId },
      'response for unknown request',
    )
    return
  }

  clearTimeout(pending.timeout)
  state.pendingPermissions.delete(payload.requestId)
  pending.resolve(payload.outcome)
}

// Cancel all pending permissions for a client (called on disconnect)
function cancelPendingPermissions(clientState: ClientState): void {
  for (const [requestId, pending] of clientState.pendingPermissions) {
    logPerm.debug({ requestId }, 'cancelled on disconnect')
    clearTimeout(pending.timeout)
    pending.resolve({ outcome: 'cancelled' })
  }
  clientState.pendingPermissions.clear()
}

async function handleConnect(ws: WSContext): Promise<void> {
  const state = clients.get(ws)
  if (!state) return

  // If already connected to a running agent, just resend status
  // This handles frontend reconnections without restarting the agent process
  // Check both .killed and .exitCode to detect crashed processes
  if (
    state.connection &&
    state.process &&
    !state.process.killed &&
    state.process.exitCode === null
  ) {
    logAgent.info('already connected, resending status')
    send(ws, 'status', {
      connected: true,
      agentInfo: state.agentInfo ?? { name: AGENT_COMMAND },
      capabilities: state.agentCapabilities,
      protocolVersion: state.protocolVersion,
    })
    return
  }

  // Kill existing process if any (only if not healthy)
  if (state.process) {
    cancelPendingPermissions(state)
    state.process.kill()
    state.process = null
    state.connection = null
  }

  try {
    logAgent.info({ command: AGENT_COMMAND, args: AGENT_ARGS }, 'spawning')

    const agentProcess = spawn(AGENT_COMMAND, AGENT_ARGS, {
      cwd: AGENT_CWD,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: buildAgentEnv(),
    })

    state.process = agentProcess

    // Clean up state when agent process exits unexpectedly
    agentProcess.on('exit', code => {
      logAgent.info({ exitCode: code }, 'agent process exited')
      // Only clear if this is still the current process
      if (state.process === agentProcess) {
        state.process = null
        state.connection = null
        state.sessionId = null
      }
    })

    const input = Writable.toWeb(
      agentProcess.stdin!,
    ) as unknown as WritableStream<Uint8Array>
    const output = Readable.toWeb(
      agentProcess.stdout!,
    ) as unknown as ReadableStream<Uint8Array>

    const stream = acp.ndJsonStream(input, output)
    const connection = new acp.ClientSideConnection(
      _agent => createClient(ws, state),
      stream,
    )

    state.connection = connection

    const initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      // Forward the real client identity/capabilities (audit §8.7). Falls back
      // to the Zed defaults only when the client did not provide any.
      clientInfo: state.clientInfo,
      clientCapabilities: state.clientCapabilities,
    })

    // Pass the raw agentCapabilities through unchanged so present and future
    // capability fields (auth, terminal, ...) reach the client (audit §8.6).
    const agentCaps = initResult.agentCapabilities
    state.agentCapabilities = (agentCaps as AgentCapabilities | null) ?? null
    state.promptCapabilities = agentCaps?.promptCapabilities ?? null
    // Remember the negotiated protocolVersion + agentInfo so reconnects and
    // JSON-RPC initialize responses can forward them to the client (§8.13).
    state.protocolVersion = initResult.protocolVersion
    state.agentInfo =
      (initResult.agentInfo as ClientState['agentInfo'] | null | undefined) ??
      null

    logAgent.info(
      {
        protocolVersion: initResult.protocolVersion,
        loadSession: !!state.agentCapabilities?.loadSession,
        sessionList: !!state.agentCapabilities?.sessionCapabilities?.list,
        sessionResume: !!state.agentCapabilities?.sessionCapabilities?.resume,
        hasMcp: !!state.agentCapabilities?.mcpCapabilities,
      },
      'initialized',
    )

    send(ws, 'status', {
      connected: true,
      agentInfo: initResult.agentInfo,
      capabilities: state.agentCapabilities,
      // Surface the negotiated protocolVersion to downstream clients (audit §8.13).
      protocolVersion: initResult.protocolVersion,
    })

    connection.closed.then(() => {
      logAgent.info('connection closed')
      state.connection = null
      state.sessionId = null
      send(ws, 'status', { connected: false })
    })
  } catch (error) {
    logAgent.error({ error: (error as Error).message }, 'connect failed')
    sendJsonRpcError(
      ws,
      state,
      null,
      JSONRPC_INTERNAL_ERROR,
      `Failed to connect: ${(error as Error).message}`,
    )
  }
}

async function handleNewSession(
  ws: WSContext,
  params: { cwd?: string; permissionMode?: string },
): Promise<void> {
  const state = clients.get(ws)
  if (!state?.connection) {
    logAgent.warn(
      {
        hasState: !!state,
        hasProcess: !!state?.process,
        processKilled: state?.process?.killed,
        exitCode: state?.process?.exitCode,
      },
      'handleNewSession: not connected to agent',
    )
    sendJsonRpcError(
      ws,
      state,
      state?.pendingJsonRpc?.id ?? null,
      JSONRPC_INVALID_REQUEST,
      'Not connected to agent',
    )
    return
  }

  try {
    const sessionCwd = params.cwd || AGENT_CWD
    let permissionMode: string | undefined
    try {
      permissionMode = resolveNewSessionPermissionMode(
        params.permissionMode,
        DEFAULT_PERMISSION_MODE,
      )
    } catch (error) {
      sendJsonRpcError(
        ws,
        state,
        state.pendingJsonRpc?.id ?? null,
        JSONRPC_INVALID_PARAMS,
        (error as Error).message,
      )
      return
    }
    const result = await state.connection.newSession({
      cwd: sessionCwd,
      mcpServers: [],
      ...(permissionMode ? { _meta: { permissionMode } } : {}),
    })

    state.sessionId = result.sessionId
    state.modelState = result.models ?? null
    logSession.info(
      {
        sessionId: result.sessionId,
        cwd: sessionCwd,
        hasModels: !!result.models,
      },
      'created',
    )

    send(ws, 'session_created', {
      ...result,
      promptCapabilities: state.promptCapabilities,
      models: state.modelState,
    })
  } catch (error) {
    logSession.error({ error: (error as Error).message }, 'create failed')
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_INTERNAL_ERROR,
      `Failed to create session: ${(error as Error).message}`,
    )
  }
}

// ============================================================================
// Session History Operations
// Reference: Zed's AgentConnection trait - list_sessions, load_session, resume_session
// ============================================================================

async function handleListSessions(
  ws: WSContext,
  params: { cwd?: string; cursor?: string },
): Promise<void> {
  const state = clients.get(ws)
  if (!state?.connection) {
    logAgent.warn(
      {
        hasState: !!state,
        hasProcess: !!state?.process,
        processKilled: state?.process?.killed,
        exitCode: state?.process?.exitCode,
      },
      'handleListSessions: not connected to agent',
    )
    sendJsonRpcError(
      ws,
      state,
      state?.pendingJsonRpc?.id ?? null,
      JSONRPC_INVALID_REQUEST,
      'Not connected to agent',
    )
    return
  }

  if (!state.agentCapabilities?.sessionCapabilities?.list) {
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_METHOD_NOT_FOUND,
      'Listing sessions is not supported by this agent',
    )
    return
  }

  try {
    const result = await state.connection.listSessions({
      cwd: params.cwd,
      cursor: params.cursor,
    })

    const MAX_SESSIONS = 20
    const sessions = result.sessions.slice(0, MAX_SESSIONS)
    logSession.info(
      {
        total: result.sessions.length,
        returned: sessions.length,
        hasMore: !!result.nextCursor,
      },
      'listed',
    )

    send(ws, 'session_list', {
      sessions: sessions.map((s: acp.SessionInfo) => ({
        _meta: s._meta,
        cwd: s.cwd,
        sessionId: s.sessionId,
        title: s.title,
        updatedAt: s.updatedAt,
      })),
      nextCursor: result.nextCursor,
      _meta: result._meta,
    })
  } catch (error) {
    logSession.error({ error: (error as Error).message }, 'list failed')
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_INTERNAL_ERROR,
      `Failed to list sessions: ${(error as Error).message}`,
    )
  }
}

async function handleLoadSession(
  ws: WSContext,
  params: { sessionId: string; cwd?: string },
): Promise<void> {
  const state = clients.get(ws)
  if (!state?.connection) {
    logAgent.warn(
      {
        hasState: !!state,
        hasProcess: !!state?.process,
        processKilled: state?.process?.killed,
        exitCode: state?.process?.exitCode,
      },
      'handleLoadSession: not connected to agent',
    )
    sendJsonRpcError(
      ws,
      state,
      state?.pendingJsonRpc?.id ?? null,
      JSONRPC_INVALID_REQUEST,
      'Not connected to agent',
    )
    return
  }

  if (!state.agentCapabilities?.loadSession) {
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_METHOD_NOT_FOUND,
      'Loading sessions is not supported by this agent',
    )
    return
  }

  try {
    const sessionCwd = params.cwd || AGENT_CWD
    const sessionId = params.sessionId
    const result = await state.connection.loadSession({
      sessionId,
      cwd: sessionCwd,
      mcpServers: [],
    })

    state.sessionId = sessionId
    state.modelState = result.models ?? null
    logSession.info({ sessionId, cwd: sessionCwd }, 'loaded')

    send(ws, 'session_loaded', {
      sessionId,
      promptCapabilities: state.promptCapabilities,
      models: state.modelState,
    })
  } catch (error) {
    logSession.error({ error: (error as Error).message }, 'load failed')
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_INTERNAL_ERROR,
      `Failed to load session: ${(error as Error).message}`,
    )
  }
}

async function handleResumeSession(
  ws: WSContext,
  params: { sessionId: string; cwd?: string },
): Promise<void> {
  const state = clients.get(ws)
  if (!state?.connection) {
    logAgent.warn(
      {
        hasState: !!state,
        hasProcess: !!state?.process,
        processKilled: state?.process?.killed,
        exitCode: state?.process?.exitCode,
      },
      'handleResumeSession: not connected to agent',
    )
    sendJsonRpcError(
      ws,
      state,
      state?.pendingJsonRpc?.id ?? null,
      JSONRPC_INVALID_REQUEST,
      'Not connected to agent',
    )
    return
  }

  if (!state.agentCapabilities?.sessionCapabilities?.resume) {
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_METHOD_NOT_FOUND,
      'Resuming sessions is not supported by this agent',
    )
    return
  }

  try {
    const sessionCwd = params.cwd || AGENT_CWD
    const sessionId = params.sessionId
    const result = await state.connection.unstable_resumeSession({
      sessionId,
      cwd: sessionCwd,
    })

    state.sessionId = sessionId
    state.modelState = result.models ?? null
    logSession.info({ sessionId, cwd: sessionCwd }, 'resumed')

    send(ws, 'session_resumed', {
      sessionId,
      promptCapabilities: state.promptCapabilities,
      models: state.modelState,
    })
  } catch (error) {
    logSession.error({ error: (error as Error).message }, 'resume failed')
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_INTERNAL_ERROR,
      `Failed to resume session: ${(error as Error).message}`,
    )
  }
}

// Reference: Zed's AcpThread.send() forwards Vec<acp::ContentBlock> to agent
async function handlePrompt(
  ws: WSContext,
  params: { content: ContentBlock[] },
): Promise<void> {
  const state = clients.get(ws)
  if (!state?.connection || !state.sessionId) {
    sendJsonRpcError(
      ws,
      state,
      state?.pendingJsonRpc?.id ?? null,
      JSONRPC_INVALID_REQUEST,
      'No active session',
    )
    return
  }

  try {
    const firstText = params.content.find(b => b.type === 'text')?.text
    const images = params.content.filter(b => b.type === 'image')
    logPrompt.debug(
      {
        text: firstText?.slice(0, 100),
        imageCount: images.length,
        blockCount: params.content.length,
      },
      'sending',
    )

    const result = await state.connection.prompt({
      sessionId: state.sessionId,
      prompt: params.content as acp.ContentBlock[],
    })

    logPrompt.info({ stopReason: result.stopReason }, 'completed')
    send(ws, 'prompt_complete', result)
  } catch (error) {
    logPrompt.error({ error: (error as Error).message }, 'failed')
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_INTERNAL_ERROR,
      `Prompt failed: ${(error as Error).message}`,
    )
  }
}

function handleDisconnect(ws: WSContext): void {
  const state = clients.get(ws)
  if (!state) return

  if (state.process) {
    state.process.kill()
    state.process = null
  }
  state.connection = null
  state.sessionId = null

  send(ws, 'status', { connected: false })
}

// Handle cancel request from client
async function handleCancel(ws: WSContext): Promise<void> {
  const state = clients.get(ws)
  if (!state?.connection || !state.sessionId) {
    logWs.warn('cancel requested but no active session')
    return
  }

  logSession.info({ sessionId: state.sessionId }, 'cancel requested')
  cancelPendingPermissions(state)

  try {
    await state.connection.cancel({ sessionId: state.sessionId })
    logSession.info({ sessionId: state.sessionId }, 'cancel sent')
  } catch (error) {
    logSession.error({ error: (error as Error).message }, 'cancel failed')
  }
}

// Reference: Zed's AgentModelSelector.select_model() calls connection.set_session_model()
async function handleSetSessionModel(
  ws: WSContext,
  params: { modelId: string },
): Promise<void> {
  const state = clients.get(ws)
  if (!state?.connection || !state.sessionId) {
    sendJsonRpcError(
      ws,
      state,
      state?.pendingJsonRpc?.id ?? null,
      JSONRPC_INVALID_REQUEST,
      'No active session',
    )
    return
  }

  if (!state.modelState) {
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_METHOD_NOT_FOUND,
      'Model selection not supported by this agent',
    )
    return
  }

  try {
    logSession.info(
      { sessionId: state.sessionId, modelId: params.modelId },
      'setting model',
    )
    await state.connection.unstable_setSessionModel({
      sessionId: state.sessionId,
      modelId: params.modelId,
    })
    state.modelState = { ...state.modelState, currentModelId: params.modelId }
    send(ws, 'model_changed', { modelId: params.modelId })
    logSession.info({ modelId: params.modelId }, 'model changed')
  } catch (error) {
    logSession.error({ error: (error as Error).message }, 'set model failed')
    sendJsonRpcError(
      ws,
      state,
      state.pendingJsonRpc?.id ?? null,
      JSONRPC_INTERNAL_ERROR,
      `Failed to set model: ${(error as Error).message}`,
    )
  }
}

// ContentBlock type matching @agentclientprotocol/sdk
interface ContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  uri?: string
  name?: string
}

type PermissionResponsePayload = {
  requestId: string
  outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string }
}

type ProxyMessage =
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'new_session'; payload: { cwd?: string; permissionMode?: string } }
  | { type: 'prompt'; payload: { content: ContentBlock[] } }
  | { type: 'permission_response'; payload: PermissionResponsePayload }
  | { type: 'cancel' }
  | { type: 'set_session_model'; payload: { modelId: string } }
  | { type: 'list_sessions'; payload: { cwd?: string; cursor?: string } }
  | { type: 'load_session'; payload: { sessionId: string; cwd?: string } }
  | { type: 'resume_session'; payload: { sessionId: string; cwd?: string } }
  | { type: 'ping' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalStringField(
  payload: Record<string, unknown>,
  key: string,
  source: string,
): string | undefined {
  if (!Object.hasOwn(payload, key)) return undefined
  const value = payload[key]
  if (typeof value === 'string') return value
  throw new Error(`Invalid ${source}: expected a string`)
}

function payloadRecord(value: unknown, type: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${type} payload`)
  }
  return value
}

function optionalPayloadRecord(
  value: unknown,
  type: string,
): Record<string, unknown> {
  if (value === undefined) return {}
  return payloadRecord(value, type)
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function decodeContentBlocks(value: unknown): ContentBlock[] {
  if (
    !Array.isArray(value) ||
    !value.every(block => isRecord(block) && typeof block.type === 'string')
  ) {
    throw new Error('Invalid prompt payload')
  }
  return value as ContentBlock[]
}

function decodePermissionResponsePayload(
  value: unknown,
): PermissionResponsePayload {
  const payload = payloadRecord(value, 'permission_response')
  if (typeof payload.requestId !== 'string' || !isRecord(payload.outcome)) {
    throw new Error('Invalid permission_response payload')
  }
  if (payload.outcome.outcome === 'cancelled') {
    return { requestId: payload.requestId, outcome: { outcome: 'cancelled' } }
  }
  if (
    payload.outcome.outcome === 'selected' &&
    typeof payload.outcome.optionId === 'string'
  ) {
    return {
      requestId: payload.requestId,
      outcome: { outcome: 'selected', optionId: payload.outcome.optionId },
    }
  }
  throw new Error('Invalid permission_response payload')
}

function decodeClientMessage(message: Record<string, unknown>): ProxyMessage {
  if (typeof message.type !== 'string') {
    throw new Error('Invalid WebSocket message payload')
  }

  switch (message.type) {
    case 'connect':
    case 'disconnect':
    case 'cancel':
    case 'ping':
      return { type: message.type }
    case 'new_session': {
      const payload = optionalPayloadRecord(message.payload, 'new_session')
      return {
        type: 'new_session',
        payload: {
          cwd: optionalStringField(payload, 'cwd', 'new_session.cwd'),
          permissionMode: optionalStringField(
            payload,
            'permissionMode',
            'new_session.permissionMode',
          ),
        },
      }
    }
    case 'prompt': {
      const payload = payloadRecord(message.payload, 'prompt')
      return {
        type: 'prompt',
        payload: { content: decodeContentBlocks(payload.content) },
      }
    }
    case 'permission_response':
      return {
        type: 'permission_response',
        payload: decodePermissionResponsePayload(message.payload),
      }
    case 'set_session_model': {
      const payload = payloadRecord(message.payload, 'set_session_model')
      if (typeof payload.modelId !== 'string') {
        throw new Error('Invalid set_session_model payload')
      }
      return {
        type: 'set_session_model',
        payload: { modelId: payload.modelId },
      }
    }
    case 'list_sessions': {
      const payload = optionalRecord(message.payload)
      return {
        type: 'list_sessions',
        payload: {
          cwd: optionalString(payload.cwd),
          cursor: optionalString(payload.cursor),
        },
      }
    }
    case 'load_session':
    case 'resume_session': {
      const payload = payloadRecord(message.payload, message.type)
      if (typeof payload.sessionId !== 'string') {
        throw new Error(`Invalid ${message.type} payload`)
      }
      return {
        type: message.type,
        payload: {
          sessionId: payload.sessionId,
          cwd: optionalString(payload.cwd),
        },
      }
    }
    default:
      throw new Error(`Unknown message type: ${message.type}`)
  }
}

export function decodeClientWsMessage(data: unknown): ProxyMessage {
  return decodeClientMessage(decodeJsonWsMessage(data))
}

async function dispatchClientMessage(
  ws: WSContext,
  data: ProxyMessage,
): Promise<void> {
  switch (data.type) {
    case 'connect':
      await handleConnect(ws)
      break
    case 'disconnect':
      handleDisconnect(ws)
      break
    case 'new_session':
      await handleNewSession(ws, data.payload)
      break
    case 'prompt':
      await handlePrompt(ws, data.payload)
      break
    case 'permission_response':
      handlePermissionResponse(ws, data.payload)
      break
    case 'cancel':
      await handleCancel(ws)
      break
    case 'set_session_model':
      await handleSetSessionModel(ws, data.payload)
      break
    case 'list_sessions':
      await handleListSessions(ws, data.payload)
      break
    case 'load_session':
      await handleLoadSession(ws, data.payload)
      break
    case 'resume_session':
      await handleResumeSession(ws, data.payload)
      break
    case 'ping':
      send(ws, 'pong')
      break
  }
}

/**
 * Maps JSON-RPC method names to their legacy handler + the legacy response
 * type the handler emits via send(). Used by dispatchJsonRpcMessage to route
 * standard ACP methods (audit §8.1, §8.4).
 */
const JSONRPC_METHOD_HANDLERS: Record<
  string,
  {
    responseType: string
    handle: (ws: WSContext, params: unknown) => Promise<void> | void
  }
> = {
  initialize: { responseType: 'status', handle: handleConnect },
  'session/new': {
    responseType: 'session_created',
    handle: handleJsonRpcNewSession,
  },
  'session/prompt': {
    responseType: 'prompt_complete',
    handle: handleJsonRpcPrompt,
  },
  'session/cancel': { responseType: '', handle: handleCancel },
  'session/list': {
    responseType: 'session_list',
    handle: handleJsonRpcListSessions,
  },
  'session/load': {
    responseType: 'session_loaded',
    handle: handleJsonRpcLoadSession,
  },
  'session/resume': {
    responseType: 'session_resumed',
    handle: handleJsonRpcResumeSession,
  },
  'session/set_model': {
    responseType: 'model_changed',
    handle: handleJsonRpcSetSessionModel,
  },
  'session/set_mode': {
    responseType: 'session_mode_set',
    handle: handleJsonRpcSetSessionMode,
  },
  'session/close': {
    responseType: 'session_closed',
    handle: handleJsonRpcCloseSession,
  },
}

// JSON-RPC method wrappers that accept `params: unknown` and forward to the
// existing handlers with the decoded payload.
async function handleJsonRpcNewSession(
  ws: WSContext,
  params: unknown,
): Promise<void> {
  const payload = optionalPayloadRecord(params, 'session/new')
  await handleNewSession(ws, {
    cwd: optionalStringField(payload, 'cwd', 'session/new.cwd'),
    permissionMode: optionalStringField(
      payload,
      'permissionMode',
      'session/new.permissionMode',
    ),
  })
}

async function handleJsonRpcPrompt(
  ws: WSContext,
  params: unknown,
): Promise<void> {
  const payload = payloadRecord(params, 'session/prompt')
  // ACP session/prompt params: { sessionId, prompt: ContentBlock[] }
  // Accept either `prompt` (spec) or `content` (legacy) for compatibility.
  const content = payload.prompt ?? payload.content
  await handlePrompt(ws, { content: decodeContentBlocks(content) })
}

async function handleJsonRpcListSessions(
  ws: WSContext,
  params: unknown,
): Promise<void> {
  const payload = optionalRecord(params)
  await handleListSessions(ws, {
    cwd: optionalString(payload.cwd),
    cursor: optionalString(payload.cursor),
  })
}

async function handleJsonRpcLoadSession(
  ws: WSContext,
  params: unknown,
): Promise<void> {
  const payload = payloadRecord(params, 'session/load')
  if (typeof payload.sessionId !== 'string') {
    throw new Error('Invalid session/load payload')
  }
  await handleLoadSession(ws, {
    sessionId: payload.sessionId,
    cwd: optionalString(payload.cwd),
  })
}

async function handleJsonRpcResumeSession(
  ws: WSContext,
  params: unknown,
): Promise<void> {
  const payload = payloadRecord(params, 'session/resume')
  if (typeof payload.sessionId !== 'string') {
    throw new Error('Invalid session/resume payload')
  }
  await handleResumeSession(ws, {
    sessionId: payload.sessionId,
    cwd: optionalString(payload.cwd),
  })
}

async function handleJsonRpcSetSessionModel(
  ws: WSContext,
  params: unknown,
): Promise<void> {
  const payload = payloadRecord(params, 'session/set_model')
  if (typeof payload.modelId !== 'string') {
    throw new Error('Invalid session/set_model payload')
  }
  await handleSetSessionModel(ws, { modelId: payload.modelId })
}

/**
 * Pass-through handlers for v1 baseline methods that the proprietary
 * whitelist previously dropped (audit §8.4). They forward the call to the
 * underlying SDK ClientSideConnection and surface the result.
 */
async function handleJsonRpcSetSessionMode(
  ws: WSContext,
  params: unknown,
): Promise<void> {
  const state = clients.get(ws)
  if (!state?.connection) {
    throw new Error('Not connected to agent')
  }
  const result = await state.connection.setSessionMode(
    params as { sessionId: string; modeId: string },
  )
  send(ws, 'session_mode_set', result ?? {})
}

async function handleJsonRpcCloseSession(
  ws: WSContext,
  params: unknown,
): Promise<void> {
  const state = clients.get(ws)
  if (!state?.connection) {
    throw new Error('Not connected to agent')
  }
  const result = await state.connection.unstable_closeSession(
    params as { sessionId: string },
  )
  send(ws, 'session_closed', result ?? {})
}

/**
 * Handle the JSON-RPC standard cancellation primitive `$/cancel_request`
 * (audit §8.5). Unlike the ACP-specific `session/cancel` notification, this
 * cancels an in-flight request by id. We forward to the ACP cancel path and
 * also clear any pending permission request.
 */
async function handleJsonRpcCancelRequest(
  ws: WSContext,
  params: unknown,
): Promise<void> {
  const payload = optionalRecord(params)
  logWs.info({ cancelledId: payload.id }, '$/cancel_request received')
  await handleCancel(ws)
}

/**
 * Route a JSON-RPC 2.0 message. Requests get a response with the echoed id;
 * notifications (no id) are dispatched without a response. Unknown methods
 * yield a JSON-RPC -32601 error (audit §8.4). `$/cancel_request` is handled
 * specially (audit §8.5).
 */
async function dispatchJsonRpcMessage(
  ws: WSContext,
  msg: JsonRpc2ClientMessage,
): Promise<void> {
  const state = clients.get(ws)
  // Mark this client as JSON-RPC from the first framed message.
  if (state) state.jsonRpc = true

  // Capture client identity/capabilities from initialize (audit §8.7).
  if (msg.method === 'initialize' && state) {
    const params = isRecord(msg.params) ? msg.params : {}
    if (isRecord(params.clientInfo)) {
      const ci = params.clientInfo
      if (typeof ci.name === 'string' && typeof ci.version === 'string') {
        state.clientInfo = { name: ci.name, version: ci.version }
      }
    }
    if (isRecord(params.clientCapabilities)) {
      state.clientCapabilities = params.clientCapabilities
    }
  }

  // Notification (no id) — dispatch without a response.
  if (!('id' in msg) || msg.id === undefined) {
    if (msg.method === '$/cancel_request') {
      await handleJsonRpcCancelRequest(ws, msg.params)
      return
    }
    if (msg.method === 'session/cancel') {
      await handleCancel(ws)
      return
    }
    // Unknown notification — silently ignore per JSON-RPC 2.0 (notifications
    // cannot be responded to).
    logWs.debug({ method: msg.method }, 'ignoring unknown notification')
    return
  }

  // Request (has id) — dispatch and the handler will emit a response.
  if (msg.method === '$/cancel_request') {
    await handleJsonRpcCancelRequest(ws, msg.params)
    // Cancellation is itself a notification-style request; respond with null.
    if (state) state.pendingJsonRpc = { id: msg.id, responseType: '' }
    sendJsonRpcRaw(ws, { jsonrpc: '2.0', id: msg.id, result: null })
    if (state) state.pendingJsonRpc = null
    return
  }

  const entry = JSONRPC_METHOD_HANDLERS[msg.method]
  if (!entry) {
    sendJsonRpcError(
      ws,
      state,
      msg.id,
      JSONRPC_METHOD_NOT_FOUND,
      `Method not found: ${msg.method}`,
    )
    return
  }

  // Track the in-flight request so the handler's send() emits a JSON-RPC
  // response with the echoed id (audit §8.2).
  if (state)
    state.pendingJsonRpc = { id: msg.id, responseType: entry.responseType }
  try {
    await entry.handle(ws, msg.params)
    // If the handler did not emit the expected response (e.g. it short
    // circuited with an error already), still clear the pending slot.
    if (state?.pendingJsonRpc) {
      sendJsonRpcRaw(ws, {
        jsonrpc: '2.0',
        id: msg.id,
        result: {},
      })
      state.pendingJsonRpc = null
    }
  } catch (error) {
    const code = (error as Error).message.startsWith('Invalid ')
      ? JSONRPC_INVALID_PARAMS
      : JSONRPC_INTERNAL_ERROR
    sendJsonRpcError(ws, state, msg.id, code, (error as Error).message)
  }
}

export const __testing = {
  dispatchClientMessage(ws: WSContext, data: unknown): Promise<void> {
    assertTestingInternalsEnabled()
    return dispatchClientMessage(ws, data as ProxyMessage)
  },
  dispatchJsonRpcMessage(ws: WSContext, data: unknown): Promise<void> {
    assertTestingInternalsEnabled()
    return dispatchJsonRpcMessage(ws, data as JsonRpc2ClientMessage)
  },
  registerClient(
    ws: WSContext,
    state: {
      connection?: unknown
      process?: ChildProcess | null
      sessionId?: string | null
      clientInfo?: { name: string; version: string }
      clientCapabilities?: Record<string, unknown>
      jsonRpc?: boolean
    },
  ): () => void {
    assertTestingInternalsEnabled()
    const full = createClientState()
    full.process = state.process ?? null
    full.connection = (state.connection ??
      null) as acp.ClientSideConnection | null
    full.sessionId = state.sessionId ?? null
    if (state.clientInfo) full.clientInfo = state.clientInfo
    if (state.clientCapabilities)
      full.clientCapabilities = state.clientCapabilities
    if (typeof state.jsonRpc === 'boolean') full.jsonRpc = state.jsonRpc
    clients.set(ws, full)
    return () => {
      clients.delete(ws)
    }
  },
  getClientSessionId(ws: WSContext): string | null | undefined {
    assertTestingInternalsEnabled()
    return clients.get(ws)?.sessionId
  },
  setDefaultPermissionMode(mode: string | undefined): () => void {
    assertTestingInternalsEnabled()
    const previous = DEFAULT_PERMISSION_MODE
    DEFAULT_PERMISSION_MODE = mode
    return () => {
      DEFAULT_PERMISSION_MODE = previous
    }
  },
}

function assertTestingInternalsEnabled(): void {
  if (process.env.ACP_LINK_TEST_INTERNALS === '1') {
    return
  }

  throw new Error(
    'acp-link test internals are disabled outside test execution.',
  )
}

const ACP_LINK_PERMISSION_MODE_ALIASES = {
  auto: 'auto',
  default: 'default',
  acceptedits: 'acceptEdits',
  dontask: 'dontAsk',
  plan: 'plan',
  bypasspermissions: 'bypassPermissions',
  bypass: 'bypassPermissions',
} as const

type AcpLinkPermissionMode =
  (typeof ACP_LINK_PERMISSION_MODE_ALIASES)[keyof typeof ACP_LINK_PERMISSION_MODE_ALIASES]

export function resolveNewSessionPermissionMode(
  requestedMode: string | undefined,
  defaultMode: string | undefined,
): string | undefined {
  const requested = resolveAcpLinkPermissionMode(requestedMode)
  const localDefault = resolveAcpLinkPermissionMode(defaultMode)

  if (!requested) {
    return localDefault
  }

  if (requested !== 'bypassPermissions') {
    return requested
  }

  if (localDefault === 'bypassPermissions') {
    return 'bypassPermissions'
  }

  throw new Error(
    'bypassPermissions requires local ACP_PERMISSION_MODE=bypassPermissions before a client can request it.',
  )
}

function resolveAcpLinkPermissionMode(
  mode: string | undefined,
): AcpLinkPermissionMode | undefined {
  if (mode === undefined) return undefined

  const normalized = mode?.trim().toLowerCase()
  if (!normalized) {
    throw new Error('Invalid permissionMode: expected a non-empty string.')
  }

  const resolved =
    ACP_LINK_PERMISSION_MODE_ALIASES[
      normalized as keyof typeof ACP_LINK_PERMISSION_MODE_ALIASES
    ]
  if (!resolved) {
    throw new Error(`Invalid permissionMode: ${mode}.`)
  }

  return resolved
}

function buildAgentEnv(): NodeJS.ProcessEnv {
  if (!DEFAULT_PERMISSION_MODE) {
    return process.env
  }

  return {
    ...process.env,
    ACP_PERMISSION_MODE: DEFAULT_PERMISSION_MODE,
  }
}

export async function startServer(config: ServerConfig): Promise<void> {
  const { port, host, command, args, cwd, token, https } = config

  // Set module-level config
  AGENT_COMMAND = command
  AGENT_ARGS = args
  AGENT_CWD = cwd
  SERVER_PORT = port
  SERVER_HOST = host
  AUTH_TOKEN = token
  DEFAULT_PERMISSION_MODE =
    config.permissionMode || process.env.ACP_PERMISSION_MODE

  // Initialize RCS upstream client if configured
  const rcsUrl = process.env.ACP_RCS_URL
  const rcsToken = process.env.ACP_RCS_TOKEN
  const rcsGroup = config.group || process.env.ACP_RCS_GROUP
  if (rcsGroup && !/^[a-zA-Z0-9_-]+$/.test(rcsGroup)) {
    throw new Error(
      `Invalid ACP_RCS_GROUP "${rcsGroup}": only letters, digits, hyphens, and underscores are allowed`,
    )
  }
  if (rcsUrl) {
    rcsUpstream = new RcsUpstreamClient({
      rcsUrl,
      apiToken: rcsToken || '',
      agentName: command,
      channelGroupId: rcsGroup || undefined,
      maxSessions: 1,
    })

    const relayWs = createRelayWs()
    const relayState = createClientState()
    clients.set(relayWs, relayState)

    rcsUpstream.setMessageHandler(async msg => {
      try {
        // The RCS relay forwards messages from the Web UI. Accept both
        // JSON-RPC 2.0 (audit §8.12) and the legacy `{type, payload}` envelope.
        if (isJsonRpc2Message(msg)) {
          logRelay.debug({ method: msg.method }, 'processing jsonrpc')
          await dispatchJsonRpcMessage(relayWs, msg)
        } else {
          const data = decodeClientMessage(msg)
          logRelay.debug({ type: data.type }, 'processing')
          await dispatchClientMessage(relayWs, data)
        }
      } catch (error) {
        logRelay.error({ error: (error as Error).message }, 'handler error')
      }
    })

    rcsUpstream.connect().catch(err => {
      logRelay.warn(
        { error: (err as Error).message },
        'initial connection failed',
      )
    })
    logRelay.info({ url: rcsUrl }, 'upstream enabled')
  }

  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  // Health check endpoint
  app.get('/health', c => {
    return c.json({ status: 'ok' })
  })

  // WebSocket endpoint with token validation
  app.get(
    '/ws',
    upgradeWebSocket(c => {
      if (AUTH_TOKEN) {
        const providedToken = extractWebSocketAuthToken({
          authorization: c.req.header('Authorization'),
          protocol: c.req.header('Sec-WebSocket-Protocol'),
        })
        if (!authTokensEqual(providedToken, AUTH_TOKEN)) {
          logWs.warn('connection rejected: invalid token')
          return {
            onOpen(_event, ws) {
              ws.close(4001, 'Unauthorized: Invalid token')
            },
            onMessage() {},
            onClose() {},
          }
        }
      }

      return {
        onOpen(_event, ws) {
          logWs.info('client connected')
          const state = createClientState()
          clients.set(ws, state)

          const rawWs = ws.raw as RawWebSocket
          rawWs.on('pong', () => {
            state.isAlive = true
          })
        },
        async onMessage(event, ws) {
          try {
            // Decode the raw frame once. JSON-RPC 2.0 messages are routed by
            // method name (audit §8.1, §8.4, §8.5); legacy `{type, payload}`
            // messages keep the existing dispatch path for backwards compat.
            const decoded = decodeJsonWsMessage(event.data)
            if (isJsonRpc2Message(decoded)) {
              logWs.debug({ method: decoded.method }, 'received jsonrpc')
              await dispatchJsonRpcMessage(ws, decoded)
            } else {
              const data = decodeClientMessage(decoded)
              logWs.debug({ type: data.type }, 'received')
              await dispatchClientMessage(ws, data)
            }
          } catch (error) {
            if (error instanceof WsPayloadTooLargeError) {
              logWs.warn({ error: error.message }, 'message too large')
              ws.close(1009, 'message too large')
              return
            }
            logWs.error({ error: (error as Error).message }, 'message error')
            const state = clients.get(ws)
            sendJsonRpcError(
              ws,
              state,
              state?.pendingJsonRpc?.id ?? null,
              JSONRPC_PARSE_ERROR,
              `Error: ${(error as Error).message}`,
            )
          }
        },
        onClose(_event, ws) {
          logWs.info('client disconnected')
          const state = clients.get(ws)
          if (state) {
            cancelPendingPermissions(state)
          }
          handleDisconnect(ws)
          clients.delete(ws)
        },
      }
    }),
  )

  // Create server with optional HTTPS
  let server
  if (https) {
    const tlsOptions = await getOrCreateCertificate()
    server = serve({
      fetch: app.fetch,
      port,
      hostname: host,
      createServer: createHttpsServer,
      serverOptions: tlsOptions,
    })
  } else {
    server = serve({ fetch: app.fetch, port, hostname: host })
  }
  injectWebSocket(server)

  // Heartbeat: periodically ping all connected clients
  setInterval(() => {
    for (const [ws, state] of clients) {
      // Skip virtual relay connections (no raw socket, always alive)
      if (!ws.raw && state.isAlive) continue
      if (!ws.raw) {
        // Connection already closed, clean up
        clients.delete(ws)
        continue
      }
      if (!state.isAlive) {
        logWs.info('heartbeat timeout, terminating')
        ;(ws.raw as RawWebSocket).terminate()
        continue
      }
      state.isAlive = false
      ;(ws.raw as RawWebSocket).ping()
    }
  }, HEARTBEAT_INTERVAL_MS)

  // Protocol strings based on HTTPS mode
  const wsProtocol = https ? 'wss' : 'ws'

  // Get actual LAN IP when binding to 0.0.0.0
  let displayHost = host
  if (host === '0.0.0.0') {
    const lanIPs = getLanIPs()
    displayHost = lanIPs[0] || 'localhost'
  }

  // Build URLs
  const localWsUrl = `${wsProtocol}://localhost:${port}/ws`
  const networkWsUrl = `${wsProtocol}://${displayHost}:${port}/ws`

  // Print startup banner
  console.log()
  console.log(`  🚀 ACP Proxy Server${https ? ' (HTTPS)' : ''}`)
  console.log()
  console.log(`  Connection:`)
  if (host === '0.0.0.0') {
    console.log(`    URL:   ${networkWsUrl}`)
  } else {
    console.log(`    URL:   ${localWsUrl}`)
  }
  if (AUTH_TOKEN) {
    console.log(`    Token: configured`)
  }
  console.log()
  if (!AUTH_TOKEN) {
    console.log(`  ⚠️  Authentication disabled (--no-auth)`)
    console.log()
  }

  const agentDisplay =
    AGENT_ARGS.length > 0
      ? `${AGENT_COMMAND} ${AGENT_ARGS.join(' ')}`
      : AGENT_COMMAND
  console.log(`  📦 Agent: ${agentDisplay}`)
  console.log(`     CWD:   ${AGENT_CWD}`)
  console.log()
  console.log(`  Press Ctrl+C to stop`)
  console.log()

  logServer.info(
    {
      port,
      host,
      https,
      wsEndpoint: `${wsProtocol}://${displayHost}:${port}/ws`,
      agent: AGENT_COMMAND,
      agentArgs: AGENT_ARGS,
      cwd: AGENT_CWD,
      authEnabled: !!AUTH_TOKEN,
    },
    'started',
  )

  // Graceful shutdown — close RCS upstream
  const shutdown = async () => {
    if (rcsUpstream) {
      await rcsUpstream.close()
    }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Keep the server running
  await new Promise(() => {})
}
