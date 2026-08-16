import type { WSContext } from 'hono/ws'
import { getEventBus } from './event-bus'
import type { SessionEvent } from './event-bus'
import { EventQuotaError, publishSessionEvent } from '../services/transport'
import { touchSession } from '../services/session'
import { log, error as logError } from '../logger'
import { toClientPayload } from './client-payload'
import {
  validateConnectionAccess,
  type ConnectionCredential,
} from '../auth/middleware'
import { registerLiveConnection } from './connection-registry'
import { storeGetSession } from '../store'
import { config } from '../config'

// Per-connection cleanup, keyed by sessionId (only one WS per session)
interface CleanupEntry {
  unsub: () => void
  keepalive: ReturnType<typeof setInterval>
  unregister: (() => void) | null
  /**
   * Credential presented at upgrade (account access token or worker JWT).
   * Optional only so unit tests can drive the handlers without one; the route
   * always supplies it, and without it the socket is never re-authenticated
   * beyond account/session state.
   */
  credential: ConnectionCredential | undefined
  ws: WSContext
  openTime: number
}
const cleanupBySession = new Map<string, CleanupEntry>()

// Track all active WS connections for graceful shutdown
const activeConnections = new Set<WSContext>()

// Server-side keepalive interval (configurable via RCS_WS_KEEPALIVE_INTERVAL).
// Sends data frames to keep reverse proxies from closing idle connections.
const SERVER_KEEPALIVE_INTERVAL_MS = (config.wsKeepaliveInterval || 20) * 1000

/**
 * Convert internal EventBus event -> SDK message for bridge client.
 */
function toSDKMessage(event: SessionEvent): string {
  // NDJSON format: each message MUST end with \n so the child process's
  // line-based parser can split messages correctly.
  return JSON.stringify(toClientPayload(event)) + '\n'
}

/** Called from onOpen — subscribes to event bus, forwards outbound events to bridge WS */
export function handleWebSocketOpen(
  ws: WSContext,
  sessionId: string,
  credential?: ConnectionCredential,
) {
  const openTime = Date.now()
  log(`[RC-DEBUG] [WS] Open session=${sessionId}`)
  activeConnections.add(ws)

  // If there's an existing connection for this session, clean it up first
  const existing = cleanupBySession.get(sessionId)
  if (existing) {
    log(`[WS] Replacing existing connection for session=${sessionId}`)
    existing.unsub()
    clearInterval(existing.keepalive)
    existing.unregister?.()
    activeConnections.delete(existing.ws)
  }

  const bus = getEventBus(sessionId)

  // Only replay events destined for the bridge. Inbound events originated
  // from this bridge; replaying them makes headless workers echo assistant
  // messages back to RCS, amplifying every reconnect exponentially.
  const missed = bus
    .getEventsSince(0)
    .filter(event => event.direction === 'outbound')
  if (missed.length > 0) {
    log(`[WS] Replaying ${missed.length} missed event(s)`)
    for (const event of missed) {
      if (ws.readyState !== 1) break
      try {
        ws.send(toSDKMessage(event))
      } catch {
        // ignore send errors during replay
      }
    }
  }

  const unsub = bus.subscribe((event: SessionEvent) => {
    if (ws.readyState !== 1) return
    if (event.direction !== 'outbound') return
    try {
      const sdkMsg = toSDKMessage(event)
      log(
        `[RC-DEBUG] [WS] -> bridge (outbound): type=${event.type} seq=${event.seqNum}`,
      )
      ws.send(sdkMsg)
    } catch (err) {
      logError('[RC-DEBUG] [WS] send error:', err)
    }
  })

  const revalidate = () => {
    const session = storeGetSession(sessionId)
    if (!session) {
      return { ok: false, reason: 'session_revoked' } as const
    }
    return validateConnectionAccess(credential, session.accountId, sessionId)
  }

  const keepalive = setInterval(() => {
    if (ws.readyState !== 1) {
      clearInterval(keepalive)
      return
    }
    // Access tokens expire on a 15-minute clock and nothing fires an event
    // when they do; this tick is what evicts a socket that has gone quiet.
    const access = revalidate()
    if (!access.ok) {
      log(`[WS] Closing session=${sessionId}: ${access.reason}`)
      try {
        ws.close(4002, access.reason)
      } finally {
        clearInterval(keepalive)
      }
      return
    }
    try {
      ws.send('{"type":"keep_alive"}\n')
    } catch {
      clearInterval(keepalive)
    }
  }, SERVER_KEEPALIVE_INTERVAL_MS)

  const entry: CleanupEntry = {
    unsub,
    keepalive,
    unregister: null,
    credential,
    ws,
    openTime,
  }
  const session = storeGetSession(sessionId)
  if (session) {
    entry.unregister = registerLiveConnection({
      accountId: session.accountId,
      sessionId,
      revalidate,
      close: reason => {
        if (ws.readyState === 1) ws.close(4002, reason)
      },
    })
  }
  cleanupBySession.set(sessionId, entry)
}

/**
 * Called from onMessage — bridge sends newline-delimited JSON.
 */
export function handleWebSocketMessage(
  ws: WSContext,
  sessionId: string,
  data: string,
) {
  const session = storeGetSession(sessionId)
  if (!session) {
    ws.close(4002, 'session_revoked')
    return
  }
  const access = validateConnectionAccess(
    cleanupBySession.get(sessionId)?.credential,
    session.accountId,
    sessionId,
  )
  if (!access.ok) {
    ws.close(4002, access.reason)
    return
  }
  touchSession(sessionId)
  const lines = data.split('\n').filter(l => l.trim())
  for (const line of lines) {
    try {
      ingestBridgeMessage(sessionId, JSON.parse(line))
    } catch (err) {
      if (err instanceof EventQuotaError) {
        logError('[WS] Dropping oversized event frame')
        continue
      }
      logError('[WS] parse error:', err)
    }
  }
}

/** Called from onClose — unsubscribes from event bus */
export function handleWebSocketClose(
  ws: WSContext,
  sessionId: string,
  code?: number,
  reason?: string,
) {
  activeConnections.delete(ws)

  const entry = cleanupBySession.get(sessionId)
  const duration = entry ? Math.round((Date.now() - entry.openTime) / 1000) : -1

  log(
    `[WS] Close session=${sessionId} code=${code ?? 'none'} reason=${reason || '(none)'} duration=${duration}s`,
  )

  // Only the socket that owns the entry may tear it down. A client rotating
  // its credential opens the replacement before (or while) the old socket
  // finishes closing, and handleWebSocketOpen has already re-pointed the entry
  // at the new one — unsubscribing here on the old socket's behalf would kill
  // the live connection and leave the session permanently silent.
  if (entry && entry.ws === ws) {
    entry.unsub()
    clearInterval(entry.keepalive)
    entry.unregister?.()
    cleanupBySession.delete(sessionId)
  }
}

/**
 * Derive event type from a child process message that may lack an explicit
 * `type` field. The child's --print --output-format stream-json mode sends:
 *   {"message":{"role":"user",...},"uuid":"..."}       → type "user"
 *   {"message":{"role":"assistant",...},"uuid":"..."}  → type "assistant"
 *   {"subtype":"success","uuid":"...","result":"..."}  → type "result"
 */
function deriveEventType(msg: Record<string, unknown>): string {
  if (msg.type && typeof msg.type === 'string') return msg.type

  // Child process stream-json format: message.role determines type
  const message = msg.message as Record<string, unknown> | undefined
  if (message && typeof message.role === 'string') {
    return message.role // "user", "assistant", "system"
  }

  // Result message
  if (msg.subtype || msg.result !== undefined) return 'result'

  // System/init message
  if (msg.session_id) return 'system'

  return 'unknown'
}

/**
 * Parse a single SDK message from bridge -> publish to EventBus as inbound.
 */
export function ingestBridgeMessage(
  sessionId: string,
  msg: Record<string, unknown>,
) {
  if (msg.type === 'keep_alive') return

  const eventType = deriveEventType(msg)

  log(
    `[RC-DEBUG] [WS] <- bridge (inbound): sessionId=${sessionId} type=${eventType}${msg.uuid ? ` uuid=${msg.uuid}` : ''}`,
  )

  let payload: unknown

  if (eventType === 'assistant' || eventType === 'partial_assistant') {
    const message = msg.message as Record<string, unknown> | undefined
    const content = message?.content
    // Extract text from content blocks for simple display
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      text = content
        .filter(
          (b: unknown) =>
            b &&
            typeof b === 'object' &&
            'type' in (b as Record<string, unknown>) &&
            (b as Record<string, unknown>).type === 'text',
        )
        .map(
          (b: Record<string, unknown>) =>
            (b as Record<string, unknown>).text || '',
        )
        .join('')
    }
    payload = { message: msg.message, uuid: msg.uuid, content: text }
  } else if (eventType === 'user' || eventType === 'system') {
    payload = {
      message: msg.message,
      uuid: msg.uuid,
      ...(typeof msg.isSynthetic === 'boolean'
        ? { isSynthetic: msg.isSynthetic }
        : {}),
    }
  } else if (eventType === 'control_request') {
    payload = { request_id: msg.request_id, request: msg.request }
  } else if (eventType === 'control_response') {
    payload = { response: msg.response }
  } else if (eventType === 'result' || eventType === 'result_success') {
    payload = { subtype: msg.subtype, uuid: msg.uuid, result: msg.result }
  } else {
    payload = msg
  }

  publishSessionEvent(sessionId, eventType, payload, 'inbound')
}

/**
 * Gracefully close all active WebSocket connections.
 */
export function closeAllConnections(): void {
  const count = activeConnections.size
  if (count === 0) return

  log(`[WS] Gracefully closing ${count} active connection(s)...`)
  for (const [sessionId, entry] of cleanupBySession) {
    try {
      entry.unsub()
      clearInterval(entry.keepalive)
      entry.unregister?.()
      if (entry.ws.readyState === 1) {
        entry.ws.close(1001, 'server_shutdown')
      }
    } catch {
      // ignore errors during shutdown
    }
  }
  cleanupBySession.clear()
  activeConnections.clear()
  log('[WS] All connections closed')
}
