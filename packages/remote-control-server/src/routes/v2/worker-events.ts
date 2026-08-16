import { Hono } from 'hono'
import { sessionIngressAuth } from '../../auth/middleware'
import {
  getSession,
  touchSession,
  updateSessionStatus,
} from '../../services/session'
import { publishSessionEvent } from '../../services/transport'

const app = new Hono()

function extractWorkerEvents(body: unknown): Array<Record<string, unknown>> {
  if (!body || typeof body !== 'object') return []
  const payload = body as Record<string, unknown>
  const rawEvents = Array.isArray(payload.events)
    ? payload.events
    : Array.isArray(body)
      ? body
      : [body]
  return rawEvents
    .filter(
      (event): event is Record<string, unknown> =>
        !!event && typeof event === 'object',
    )
    .map(event => {
      const wrappedPayload = event.payload
      return wrappedPayload &&
        typeof wrappedPayload === 'object' &&
        !Array.isArray(wrappedPayload)
        ? (wrappedPayload as Record<string, unknown>)
        : event
    })
}

function hasSession(sessionId: string, accountId: string) {
  return !!getSession(sessionId, accountId)
}

app.post('/:id/worker/events', sessionIngressAuth, async c => {
  const sessionId = c.req.param('id')!
  const accountId = c.get('accountId') as string
  if (!hasSession(sessionId, accountId)) {
    return c.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      404,
    )
  }
  const events = extractWorkerEvents(await c.req.json())
  for (const event of events) {
    publishSessionEvent(
      sessionId,
      typeof event.type === 'string' ? event.type : 'message',
      event,
      'inbound',
    )
  }
  touchSession(sessionId, accountId)
  return c.json({ status: 'ok', count: events.length })
})

app.put('/:id/worker/state', sessionIngressAuth, async c => {
  const sessionId = c.req.param('id')!
  const accountId = c.get('accountId') as string
  if (!hasSession(sessionId, accountId)) {
    return c.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      404,
    )
  }
  const body = await c.req.json()
  if (body.status) {
    updateSessionStatus(sessionId, body.status, accountId)
  } else {
    touchSession(sessionId, accountId)
  }
  return c.json({ status: 'ok' })
})

app.put('/:id/worker/external_metadata', sessionIngressAuth, async c => {
  const sessionId = c.req.param('id')!
  const accountId = c.get('accountId') as string
  if (!hasSession(sessionId, accountId)) {
    return c.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      404,
    )
  }
  return c.json({ status: 'ok' })
})

app.post('/:id/worker/events/delivery', sessionIngressAuth, c => {
  const sessionId = c.req.param('id')!
  const accountId = c.get('accountId') as string
  return hasSession(sessionId, accountId)
    ? c.json({ status: 'ok' })
    : c.json(
        { error: { type: 'not_found', message: 'Session not found' } },
        404,
      )
})

app.post('/:id/worker/events/:eventId/delivery', sessionIngressAuth, c => {
  const sessionId = c.req.param('id')!
  const accountId = c.get('accountId') as string
  return hasSession(sessionId, accountId)
    ? c.json({ status: 'ok' })
    : c.json(
        { error: { type: 'not_found', message: 'Session not found' } },
        404,
      )
})

export default app
