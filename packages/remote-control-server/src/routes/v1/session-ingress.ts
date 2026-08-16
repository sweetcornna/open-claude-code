import { error as logError, log } from '../../logger'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { WSContext, WSMessageReceive } from 'hono/ws'
import {
  authenticateWorkerToken,
  extractWebSocketAuthToken,
  type ConnectionCredential,
} from '../../auth/middleware'
import { resolveAccountToken } from '../../services/account'
import { storeGetSession } from '../../store'
import { getSession, resolveExistingSessionId } from '../../services/session'
import { EventQuotaError } from '../../services/transport'
import { handleSizedWsPayload } from '../../transport/ws-payload'
import {
  handleWebSocketClose,
  handleWebSocketMessage,
  handleWebSocketOpen,
  ingestBridgeMessage,
} from '../../transport/ws-handler'
import { upgradeWebSocket } from '../../transport/ws-shared'

const app = new Hono()

type WsMessageEvent = { data: WSMessageReceive }
type WsCloseEvent = { code?: number; reason?: string }

function authenticateRequest(
  c: Context,
  requestedSessionId: string,
):
  | { payload?: unknown; sessionId: string; credential: ConnectionCredential }
  | undefined {
  const rawToken = extractWebSocketAuthToken(c)
  if (!rawToken) return undefined
  const payload = authenticateWorkerToken(rawToken)
  if (payload) {
    const sessionId = resolveExistingSessionId(
      requestedSessionId,
      payload.account_id,
    )
    if (!sessionId || payload.session_id !== sessionId) return undefined
    return {
      payload,
      sessionId,
      credential: { type: 'worker', token: rawToken, sessionId },
    }
  }
  // v1 transports authenticate with the account access token ("OAuth" in
  // upstream terms) instead of the worker JWT — the client contract is
  // "accepts OAuth OR JWT". Scope it to sessions owned by that account.
  const account = resolveAccountToken(rawToken, 'access')
  if (!account) return undefined
  const sessionId = resolveExistingSessionId(requestedSessionId, account.id)
  if (!sessionId || !storeGetSession(sessionId, account.id)) return undefined
  return {
    sessionId,
    credential: { type: 'account', token: rawToken, kind: 'access' },
  }
}

app.post('/session/:sessionId/events', async c => {
  const auth = authenticateRequest(c, c.req.param('sessionId')!)
  if (!auth || !getSession(auth.sessionId)) {
    return c.json(
      { error: { type: 'unauthorized', message: 'Invalid worker token' } },
      401,
    )
  }
  const body = await c.req.json()
  const events = Array.isArray(body.events) ? body.events : [body]
  let count = 0
  for (const message of events) {
    if (!message || typeof message !== 'object') continue
    try {
      ingestBridgeMessage(auth.sessionId, message as Record<string, unknown>)
    } catch (error) {
      if (error instanceof EventQuotaError) {
        return c.json(
          {
            error: {
              type: 'payload_too_large',
              message: 'Event payload too large',
            },
          },
          413,
        )
      }
      throw error
    }
    count++
  }
  return c.json({ status: 'ok', count }, 200)
})

app.get(
  '/ws/:sessionId',
  upgradeWebSocket(async c => {
    const auth = authenticateRequest(c, c.req.param('sessionId')!)
    if (!auth || !getSession(auth.sessionId)) {
      return {
        onOpen(_event: Event, ws: WSContext) {
          ws.close(4003, 'unauthorized')
        },
      }
    }
    const { sessionId, credential } = auth
    log(`[WS] Upgrade accepted: session=${sessionId}`)
    return {
      onOpen(_event: Event, ws: WSContext) {
        handleWebSocketOpen(ws, sessionId, credential)
      },
      onMessage(event: WsMessageEvent, ws: WSContext) {
        handleSessionIngressWsPayload(ws, sessionId, event.data)
      },
      onClose(event: WsCloseEvent, ws: WSContext) {
        handleWebSocketClose(ws, sessionId, event.code, event.reason)
      },
      onError(event: Event, ws: WSContext) {
        logError(`[WS] Error on session=${sessionId}:`, event)
        handleWebSocketClose(ws, sessionId, 1006, 'websocket error')
      },
    }
  }),
)

function handleSessionIngressWsPayload(
  ws: WSContext,
  sessionId: string,
  payload: unknown,
): boolean {
  return handleSizedWsPayload(
    ws,
    '[WS]',
    `session=${sessionId}`,
    payload,
    data => handleWebSocketMessage(ws, sessionId, data),
  )
}

export default app
