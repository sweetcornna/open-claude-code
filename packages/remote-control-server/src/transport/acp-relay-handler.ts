import type { WSContext } from 'hono/ws'
import { findAcpConnectionByAgentId, sendToAgentWs } from './acp-ws-handler'
import { getAcpEventBus } from './event-bus'
import type { SessionEvent } from './event-bus'
import {
  validateConnectionAccess,
  type ConnectionCredential,
} from '../auth/middleware'
import { registerLiveConnection } from './connection-registry'
import { log, error as logError } from '../logger'

// Per-relay connection state
interface RelayConnectionEntry {
  accountId: string
  /** Cookie (browser) or bearer credential, re-checked per frame and tick. */
  credential: ConnectionCredential | undefined
  agentId: string
  unsub: (() => void) | null
  keepalive: ReturnType<typeof setInterval> | null
  unregister: (() => void) | null
  ws: WSContext
  openTime: number
}

const relayConnections = new Map<string, RelayConnectionEntry>() // key: relayWsId

const RELAY_KEEPALIVE_INTERVAL_MS = 20_000

/** Send a JSON message to relay WS */
function sendToRelayWs(ws: WSContext, msg: object): void {
  if (ws.readyState !== 1) return
  try {
    ws.send(JSON.stringify(msg))
  } catch (err) {
    logError('[ACP-Relay] send error:', err)
  }
}

/** Called from onOpen — finds target agent and bridges connection */
export function handleRelayOpen(
  ws: WSContext,
  relayWsId: string,
  accountId: string,
  agentId: string,
  credential?: ConnectionCredential,
): void {
  log(
    `[ACP-Relay] Relay connection opened: relayWsId=${relayWsId} agentId=${agentId}`,
  )

  // Check if agent is online
  const agentConn = findAcpConnectionByAgentId(agentId)
  if (!agentConn || agentConn.accountId !== accountId) {
    log(`[ACP-Relay] Agent ${agentId} not found or offline`)
    sendToRelayWs(ws, { type: 'error', message: 'Agent not found or offline' })
    ws.close(4004, 'agent not found')
    return
  }

  // Keepalive interval
  const keepalive = setInterval(() => {
    const entry = relayConnections.get(relayWsId)
    if (!entry || entry.ws.readyState !== 1) {
      clearInterval(keepalive)
      return
    }
    const access = validateConnectionAccess(entry.credential, entry.accountId)
    if (!access.ok) {
      log(`[ACP-Relay] Closing relay wsId=${relayWsId}: ${access.reason}`)
      entry.ws.close(4002, access.reason)
      clearInterval(keepalive)
      return
    }
    sendToRelayWs(entry.ws, { type: 'keep_alive' })
  }, RELAY_KEEPALIVE_INTERVAL_MS)

  // Subscribe to channel group EventBus — forward agent responses to frontend
  const channelGroupId = agentConn.channelGroupId
  const bus = getAcpEventBus(accountId, channelGroupId)
  const unsub = bus.subscribe((event: SessionEvent) => {
    if (ws.readyState !== 1) return
    if (event.direction !== 'inbound') return
    // Handle agent disconnect specially: send status to frontend
    if (event.type === 'agent_disconnect') {
      sendToRelayWs(ws, { type: 'status', payload: { connected: false } })
      return
    }
    // Forward agent responses to the frontend WebSocket
    sendToRelayWs(ws, event.payload as object)
  })

  const entry: RelayConnectionEntry = {
    accountId,
    credential,
    agentId,
    unsub,
    keepalive,
    unregister: null,
    ws,
    openTime: Date.now(),
  }
  entry.unregister = registerLiveConnection({
    accountId,
    revalidate: () => validateConnectionAccess(credential, accountId),
    close: reason => {
      if (entry.ws.readyState === 1) entry.ws.close(4002, reason)
    },
  })
  relayConnections.set(relayWsId, entry)

  // Don't send a synthetic status message here!
  // The frontend sends a "connect" command, which acp-link processes
  // and responds with a real status message including capabilities.
  // Sending a fake status would make the frontend think it's connected
  // before the agent process is actually ready.

  log(
    `[ACP-Relay] Relay established: relayWsId=${relayWsId} → agentId=${agentId}`,
  )
}

/** Called from onMessage — forwards frontend messages to acp-link */
export function handleRelayMessage(
  ws: WSContext,
  relayWsId: string,
  accountId: string,
  data: string,
): void {
  const entry = relayConnections.get(relayWsId)
  if (!entry) return
  const access = validateConnectionAccess(entry.credential, accountId)
  if (!access.ok) {
    ws.close(4002, access.reason)
    return
  }

  const lines = data.split('\n').filter(l => l.trim())
  for (const line of lines) {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line)
    } catch {
      logError('[ACP-Relay] Dropping malformed frame')
      continue
    }

    // Ignore keepalive responses
    if (msg.type === 'keep_alive') continue

    // Forward to acp-link agent
    const sent = sendToAgentWs(entry.agentId, msg)
    if (!sent) {
      sendToRelayWs(ws, { type: 'error', message: 'Agent connection lost' })
      return
    }
  }
}

/** Called from onClose — cleans up relay connection */
export function handleRelayClose(
  ws: WSContext,
  relayWsId: string,
  code?: number,
  reason?: string,
): void {
  const entry = relayConnections.get(relayWsId)
  if (!entry) return

  const duration = Math.round((Date.now() - entry.openTime) / 1000)
  log(
    `[ACP-Relay] Connection closed: relayWsId=${relayWsId} agentId=${entry.agentId} code=${code ?? 'none'} reason=${reason || '(none)'} duration=${duration}s`,
  )

  if (entry.unsub) {
    entry.unsub()
  }
  if (entry.keepalive) {
    clearInterval(entry.keepalive)
  }
  entry.unregister?.()

  relayConnections.delete(relayWsId)
}

/** Close all relay connections (for graceful shutdown) */
export function closeAllRelayConnections(): void {
  if (relayConnections.size === 0) return

  log(`[ACP-Relay] Closing ${relayConnections.size} relay connection(s)...`)
  for (const [relayWsId, entry] of relayConnections) {
    try {
      if (entry.unsub) entry.unsub()
      if (entry.keepalive) clearInterval(entry.keepalive)
      entry.unregister?.()
      if (entry.ws.readyState === 1) {
        entry.ws.close(1001, 'server_shutdown')
      }
    } catch {
      // ignore errors during shutdown
    }
  }
  relayConnections.clear()
  log('[ACP-Relay] All relay connections closed')
}
