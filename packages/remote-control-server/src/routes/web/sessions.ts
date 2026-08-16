import { Hono } from 'hono'
import {
  browserAuth,
  getConnectionCredential,
  requireSameOriginJson,
  validateConnectionAccess,
} from '../../auth/middleware'
import { error as logError } from '../../logger'
import { getAutomationStateSnapshot } from '../../services/automationState'
import {
  createSession,
  createSessionPairing,
  getSession,
  isSessionClosedStatus,
  listWebSessionSummariesByAccount,
  listWebSessionsByAccount,
  resolveOwnedWebSessionId,
  toWebSessionResponse,
} from '../../services/session'
import { createWorkItem } from '../../services/work-dispatch'
import { storeGetSessionWorker } from '../../store'
import { getEventBus } from '../../transport/event-bus'
import { createSSEStream } from '../../transport/sse-writer'

const app = new Hono()

app.post('/sessions', requireSameOriginJson, browserAuth, async c => {
  const accountId = c.get('accountId') as string
  const body = await c.req.json()
  try {
    const session = createSession({
      accountId,
      environment_id: body.environment_id || null,
      title: body.title || 'New Session',
      source: 'web',
      permission_mode: body.permission_mode || 'default',
    })
    if (body.environment_id) {
      await createWorkItem(body.environment_id, session.id, accountId)
    }
    return c.json(
      { ...session, ...createSessionPairing(session.id, accountId) },
      200,
    )
  } catch (error) {
    logError(`[RCS] Failed to create web session: ${(error as Error).message}`)
    return c.json(
      {
        error: { type: 'invalid_request', message: 'Unable to create session' },
      },
      400,
    )
  }
})

app.get('/sessions', browserAuth, c =>
  c.json(listWebSessionsByAccount(c.get('accountId') as string), 200),
)

app.get('/sessions/all', browserAuth, c =>
  c.json(listWebSessionSummariesByAccount(c.get('accountId') as string), 200),
)

app.get('/sessions/:id', browserAuth, c => {
  const accountId = c.get('accountId') as string
  const sessionId = resolveOwnedWebSessionId(c.req.param('id')!, accountId)
  const session = sessionId ? getSession(sessionId, accountId) : null
  if (!session || !sessionId) {
    return c.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      404,
    )
  }
  const worker = storeGetSessionWorker(sessionId, accountId)
  const automationState = getAutomationStateSnapshot(worker?.externalMetadata)
  const response = toWebSessionResponse(session)
  return c.json(
    automationState === undefined
      ? response
      : { ...response, automation_state: automationState },
    200,
  )
})

app.get('/sessions/:id/history', browserAuth, c => {
  const accountId = c.get('accountId') as string
  const sessionId = resolveOwnedWebSessionId(c.req.param('id')!, accountId)
  if (!sessionId || !getSession(sessionId, accountId)) {
    return c.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      404,
    )
  }
  return c.json({ events: getEventBus(sessionId).getEventsSince(0) }, 200)
})

app.get('/sessions/:id/events', browserAuth, c => {
  const accountId = c.get('accountId') as string
  const sessionId = resolveOwnedWebSessionId(c.req.param('id')!, accountId)
  const session = sessionId ? getSession(sessionId, accountId) : null
  if (!session || !sessionId) {
    return c.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      404,
    )
  }
  if (isSessionClosedStatus(session.status)) {
    return c.json(
      {
        error: {
          type: 'session_closed',
          message: `Session is ${session.status}`,
        },
      },
      409,
    )
  }
  const lastEventId = c.req.header('Last-Event-ID')
  const credential = getConnectionCredential(c)
  return createSSEStream(
    c,
    sessionId,
    lastEventId ? Number.parseInt(lastEventId, 10) : 0,
    {
      accountId,
      sessionId,
      revalidate: () =>
        validateConnectionAccess(credential, accountId, sessionId),
    },
  )
})

export default app
