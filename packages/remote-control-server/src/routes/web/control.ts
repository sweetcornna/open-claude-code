import { Hono, type Context } from 'hono'
import { browserAuth, requireSameOriginJson } from '../../auth/middleware'
import { log } from '../../logger'
import {
  getSession,
  isSessionClosedStatus,
  resolveOwnedWebSessionId,
  updateSessionStatus,
} from '../../services/session'
import { EventQuotaError, publishSessionEvent } from '../../services/transport'
import { getEventBus } from '../../transport/event-bus'

function payloadTooLarge(c: Context) {
  return c.json(
    {
      error: { type: 'payload_too_large', message: 'Event payload too large' },
    },
    413,
  )
}

const app = new Hono()

function sessionForRequest(c: Context) {
  const accountId = c.get('accountId') as string
  const sessionId = resolveOwnedWebSessionId(c.req.param('id')!, accountId)
  const session = sessionId ? getSession(sessionId, accountId) : null
  return sessionId && session ? { accountId, sessionId, session } : undefined
}

app.post(
  '/sessions/:id/events',
  requireSameOriginJson,
  browserAuth,
  async c => {
    const scoped = sessionForRequest(c)
    if (!scoped) {
      return c.json(
        { error: { type: 'not_found', message: 'Session not found' } },
        404,
      )
    }
    if (isSessionClosedStatus(scoped.session.status)) {
      return c.json(
        {
          error: {
            type: 'session_closed',
            message: `Session is ${scoped.session.status}`,
          },
        },
        409,
      )
    }
    const body = await c.req.json()
    const eventType = body.type || 'user'
    log(
      `[RC-DEBUG] web -> server: session=${scoped.sessionId} type=${eventType}`,
    )
    let event
    try {
      event = publishSessionEvent(scoped.sessionId, eventType, body, 'outbound')
    } catch (error) {
      if (error instanceof EventQuotaError) return payloadTooLarge(c)
      throw error
    }
    log(
      `[RC-DEBUG] web event published: id=${event.id} subscribers=${getEventBus(scoped.sessionId).subscriberCount()}`,
    )
    return c.json({ status: 'ok', event }, 200)
  },
)

app.post(
  '/sessions/:id/control',
  requireSameOriginJson,
  browserAuth,
  async c => {
    const scoped = sessionForRequest(c)
    if (!scoped) {
      return c.json(
        { error: { type: 'not_found', message: 'Session not found' } },
        404,
      )
    }
    if (isSessionClosedStatus(scoped.session.status)) {
      return c.json(
        {
          error: {
            type: 'session_closed',
            message: `Session is ${scoped.session.status}`,
          },
        },
        409,
      )
    }
    const body = await c.req.json()
    let event
    try {
      event = publishSessionEvent(
        scoped.sessionId,
        body.type || 'control_request',
        body,
        'outbound',
      )
    } catch (error) {
      if (error instanceof EventQuotaError) return payloadTooLarge(c)
      throw error
    }
    return c.json({ status: 'ok', event }, 200)
  },
)

app.post('/sessions/:id/interrupt', requireSameOriginJson, browserAuth, c => {
  const scoped = sessionForRequest(c)
  if (!scoped) {
    return c.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      404,
    )
  }
  if (isSessionClosedStatus(scoped.session.status)) {
    return c.json(
      {
        error: {
          type: 'session_closed',
          message: `Session is ${scoped.session.status}`,
        },
      },
      409,
    )
  }
  publishSessionEvent(
    scoped.sessionId,
    'interrupt',
    { action: 'interrupt' },
    'outbound',
  )
  updateSessionStatus(scoped.sessionId, 'idle', scoped.accountId)
  return c.json({ status: 'ok' }, 200)
})

export default app
