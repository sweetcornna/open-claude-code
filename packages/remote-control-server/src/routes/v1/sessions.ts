import { Hono } from 'hono'
import { accountAuth } from '../../auth/middleware'
import { error as logError } from '../../logger'
import {
  archiveSession,
  createSession,
  createSessionPairing,
  getSession,
  resolveExistingSessionId,
  updateSessionTitle,
} from '../../services/session'
import { EventQuotaError, publishSessionEvent } from '../../services/transport'
import { createWorkItem } from '../../services/work-dispatch'

const app = new Hono()

// Pairing codes and worker JWTs travel through these responses: never cache.
app.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
})

app.post('/', accountAuth, async c => {
  const body = await c.req.json()
  const accountId = c.get('accountId') as string
  let session
  try {
    session = createSession({ ...body, accountId })
    if (body.environment_id) {
      await createWorkItem(body.environment_id, session.id, accountId)
    }
  } catch (error) {
    logError(`[RCS] Failed to create session: ${(error as Error).message}`)
    return c.json(
      {
        error: { type: 'invalid_request', message: 'Unable to create session' },
      },
      400,
    )
  }

  if (Array.isArray(body.events)) {
    for (const event of body.events) {
      try {
        publishSessionEvent(session.id, event.type || 'init', event, 'outbound')
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
    }
  }
  return c.json(
    c.get('legacyAuth')
      ? session
      : { ...session, ...createSessionPairing(session.id, accountId) },
    200,
  )
})

app.post('/:id/pairing', accountAuth, c => {
  if (c.get('legacyAuth')) {
    return c.json(
      { error: { type: 'forbidden', message: 'Account login required' } },
      403,
    )
  }
  const accountId = c.get('accountId') as string
  const sessionId = resolveExistingSessionId(c.req.param('id')!, accountId)
  if (!sessionId) {
    return c.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      404,
    )
  }
  return c.json(createSessionPairing(sessionId, accountId), 200)
})

app.get('/:id', accountAuth, c => {
  const accountId = c.get('accountId') as string
  const sessionId = resolveExistingSessionId(c.req.param('id')!, accountId)
  const session = sessionId ? getSession(sessionId, accountId) : null
  return session
    ? c.json(session, 200)
    : c.json(
        { error: { type: 'not_found', message: 'Session not found' } },
        404,
      )
})

app.patch('/:id', accountAuth, async c => {
  const accountId = c.get('accountId') as string
  const sessionId = resolveExistingSessionId(c.req.param('id')!, accountId)
  if (!sessionId) {
    return c.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      404,
    )
  }
  const body = await c.req.json()
  if (typeof body.title === 'string' && body.title) {
    updateSessionTitle(sessionId, body.title, accountId)
  }
  return c.json(getSession(sessionId, accountId), 200)
})

app.post('/:id/archive', accountAuth, c => {
  const accountId = c.get('accountId') as string
  const sessionId = resolveExistingSessionId(c.req.param('id')!, accountId)
  if (!sessionId) {
    return c.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      404,
    )
  }
  archiveSession(sessionId, accountId)
  return c.json({ status: 'ok' }, 200)
})

app.post('/:id/events', accountAuth, async c => {
  const accountId = c.get('accountId') as string
  const sessionId = resolveExistingSessionId(c.req.param('id')!, accountId)
  if (!sessionId) {
    return c.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      404,
    )
  }
  const body = await c.req.json()
  const events = body.events
    ? Array.isArray(body.events)
      ? body.events
      : [body.events]
    : Array.isArray(body)
      ? body
      : [body]
  for (const event of events) {
    try {
      publishSessionEvent(sessionId, event.type || 'message', event, 'inbound')
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
  }
  return c.json({ status: 'ok', events: events.length }, 200)
})

export default app
