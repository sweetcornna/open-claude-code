import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import type { WSContext, WSMessageReceive } from 'hono/ws'
import {
  extractBearerToken,
  isAllowedWebSocketOrigin,
  resolveBearerAccount,
  resolveWebSocketAccount,
  validateConnectionAccess,
} from '../../auth/middleware'
import { error as logError, log } from '../../logger'
import {
  storeGetEnvironment,
  storeListAcpAgents,
  storeListAcpAgentsByChannelGroup,
} from '../../store'
import {
  handleAcpWsClose,
  handleAcpWsMessage,
  handleAcpWsOpen,
} from '../../transport/acp-ws-handler'
import {
  handleRelayClose,
  handleRelayMessage,
  handleRelayOpen,
} from '../../transport/acp-relay-handler'
import { createAcpSSEStream } from '../../transport/acp-sse-writer'
import { handleSizedWsPayload } from '../../transport/ws-payload'
import { upgradeWebSocket } from '../../transport/ws-shared'

const app = new Hono()
type WsMessageEvent = { data: WSMessageReceive }
type WsCloseEvent = { code?: number; reason?: string }

function bearerAccount(c: Context) {
  return resolveBearerAccount(extractBearerToken(c))
}

function websocketAccount(c: Context) {
  return resolveWebSocketAccount(c)
}

function unauthorized(c: Context) {
  return c.json(
    { error: { type: 'unauthorized', message: 'Missing auth' } },
    401,
  )
}

/**
 * Cookie-authenticated upgrades additionally need an Origin check: the browser
 * attaches `__Host-rcs_session` to a WebSocket handshake initiated from any
 * origin, and there is no preflight to stop it. Bearer/subprotocol upgrades
 * come from CLI clients and are unaffected.
 */
function isAllowedWebSocketUpgrade(
  c: Context,
  source: 'cookie' | 'bearer',
): boolean {
  return source !== 'cookie' || isAllowedWebSocketOrigin(c)
}

function toAcpAgentResponse(
  environment: NonNullable<ReturnType<typeof storeGetEnvironment>>,
) {
  return {
    id: environment.id,
    agent_name: environment.machineName,
    channel_group_id: environment.bridgeId,
    status: environment.status === 'active' ? 'online' : 'offline',
    max_sessions: environment.maxSessions,
    last_seen_at: environment.lastPollAt
      ? environment.lastPollAt.getTime() / 1000
      : null,
    created_at: environment.createdAt.getTime() / 1000,
  }
}

app.get('/agents', c => {
  const account = bearerAccount(c)
  if (!account) return unauthorized(c)
  return c.json(storeListAcpAgents(account.id).map(toAcpAgentResponse))
})

app.get('/channel-groups', c => {
  const account = bearerAccount(c)
  if (!account) return unauthorized(c)
  const agents = storeListAcpAgents(account.id)
  const groups = new Map<string, typeof agents>()
  for (const agent of agents) {
    const groupId = agent.bridgeId || 'default'
    const members = groups.get(groupId) ?? []
    members.push(agent)
    groups.set(groupId, members)
  }
  return c.json(
    [...groups].map(([groupId, members]) => ({
      channel_group_id: groupId,
      member_count: members.length,
      members: members.map(toAcpAgentResponse),
    })),
  )
})

app.get('/channel-groups/:id', c => {
  const account = bearerAccount(c)
  if (!account) return unauthorized(c)
  const members = storeListAcpAgentsByChannelGroup(
    c.req.param('id')!,
    account.id,
  )
  return members.length > 0
    ? c.json({
        channel_group_id: c.req.param('id')!,
        member_count: members.length,
        members: members.map(toAcpAgentResponse),
      })
    : c.json(
        { error: { type: 'not_found', message: 'Channel group not found' } },
        404,
      )
})

app.get('/channel-groups/:id/events', c => {
  const account = bearerAccount(c)
  if (!account) return unauthorized(c)
  const groupId = c.req.param('id')!
  if (storeListAcpAgentsByChannelGroup(groupId, account.id).length === 0) {
    return c.json(
      { error: { type: 'not_found', message: 'Channel group not found' } },
      404,
    )
  }
  const lastEventId = c.req.header('Last-Event-ID')
  const fromSequence = c.req.query('from_sequence_num')
  return createAcpSSEStream(
    c,
    account.id,
    groupId,
    fromSequence
      ? Number.parseInt(fromSequence, 10)
      : lastEventId
        ? Number.parseInt(lastEventId, 10)
        : 0,
    {
      accountId: account.id,
      revalidate: () =>
        validateConnectionAccess(account.credential, account.id),
    },
  )
})

app.get(
  '/ws',
  upgradeWebSocket(async c => {
    const account = websocketAccount(c)
    if (!account || !isAllowedWebSocketUpgrade(c, account.source)) {
      return {
        onOpen(_event: Event, ws: WSContext) {
          ws.close(4003, 'unauthorized')
        },
      }
    }
    const wsId = `acp_ws_${randomUUID().replaceAll('-', '')}`
    return {
      onOpen(_event: Event, ws: WSContext) {
        handleAcpWsOpen(ws, wsId, account.id, account.credential)
      },
      onMessage(event: WsMessageEvent, ws: WSContext) {
        handleAcpWsPayload(ws, '[ACP-WS]', `wsId=${wsId}`, event.data, data =>
          handleAcpWsMessage(ws, wsId, data),
        )
      },
      onClose(event: WsCloseEvent, ws: WSContext) {
        handleAcpWsClose(ws, wsId, event.code, event.reason)
      },
      onError(event: Event, ws: WSContext) {
        logError(`[ACP-WS] Error on wsId=${wsId}:`, event)
        handleAcpWsClose(ws, wsId, 1006, 'websocket error')
      },
    }
  }),
)

app.get(
  '/relay/:agentId',
  upgradeWebSocket(async c => {
    const account = websocketAccount(c)
    const agentId = c.req.param('agentId')!
    const agent = account ? storeGetEnvironment(agentId, account.id) : undefined
    if (
      !account ||
      !agent ||
      agent.workerType !== 'acp' ||
      !isAllowedWebSocketUpgrade(c, account.source)
    ) {
      log('[ACP-Relay] Upgrade rejected: unauthorized')
      return {
        onOpen(_event: Event, ws: WSContext) {
          ws.close(4003, 'unauthorized')
        },
      }
    }
    const relayWsId = `relay_${randomUUID().replaceAll('-', '')}`
    return {
      onOpen(_event: Event, ws: WSContext) {
        handleRelayOpen(ws, relayWsId, account.id, agentId, account.credential)
      },
      onMessage(event: WsMessageEvent, ws: WSContext) {
        handleAcpWsPayload(
          ws,
          '[ACP-Relay]',
          `relayWsId=${relayWsId}`,
          event.data,
          data => handleRelayMessage(ws, relayWsId, account.id, data),
        )
      },
      onClose(event: WsCloseEvent, ws: WSContext) {
        handleRelayClose(ws, relayWsId, event.code, event.reason)
      },
      onError(event: Event, ws: WSContext) {
        logError(`[ACP-Relay] Error on relayWsId=${relayWsId}:`, event)
        handleRelayClose(ws, relayWsId, 1006, 'websocket error')
      },
    }
  }),
)

function handleAcpWsPayload(
  ws: WSContext,
  logPrefix: string,
  label: string,
  payload: unknown,
  handleMessage: (data: string) => void,
): boolean {
  return handleSizedWsPayload(ws, logPrefix, label, payload, handleMessage)
}

export default app
