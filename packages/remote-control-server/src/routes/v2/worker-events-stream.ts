import { Hono } from 'hono'
import {
  getConnectionCredential,
  sessionIngressAuth,
  validateConnectionAccess,
} from '../../auth/middleware'
import { getSession } from '../../services/session'
import { createWorkerEventStream } from '../../transport/sse-writer'

const app = new Hono()

app.get('/:id/worker/events/stream', sessionIngressAuth, c => {
  const sessionId = c.req.param('id')!
  const accountId = c.get('accountId') as string
  if (!getSession(sessionId, accountId)) {
    return c.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      404,
    )
  }
  const lastEventId = c.req.header('Last-Event-ID')
  const fromSequence = c.req.query('from_sequence_num')
  const fromSeqNum = fromSequence
    ? Number.parseInt(fromSequence, 10)
    : lastEventId
      ? Number.parseInt(lastEventId, 10)
      : 0
  const credential = getConnectionCredential(c)
  return createWorkerEventStream(c, sessionId, fromSeqNum, {
    accountId,
    sessionId,
    revalidate: () =>
      validateConnectionAccess(credential, accountId, sessionId),
  })
})

export default app
