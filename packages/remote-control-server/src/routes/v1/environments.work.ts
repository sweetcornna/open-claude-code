import { Hono } from 'hono'
import { bridgeCredentialAuth } from '../../auth/middleware'
import { getEnvironment, updatePollTime } from '../../services/environment'
import {
  ackWork,
  heartbeatWork,
  pollWork,
  stopWork,
} from '../../services/work-dispatch'
import { storeGetWorkItem, storeWorkCredentialMatches } from '../../store'

const app = new Hono()

app.get('/:id/work/poll', bridgeCredentialAuth, async c => {
  const accountId = c.get('accountId') as string
  const environmentId = c.req.param('id')!
  if (c.get('jwtPayload')) {
    return c.json(
      {
        error: {
          type: 'forbidden',
          message: 'Environment credential required',
        },
      },
      403,
    )
  }
  if (!getEnvironment(environmentId, accountId)) {
    return c.json(
      { error: { type: 'not_found', message: 'Environment not found' } },
      404,
    )
  }
  updatePollTime(environmentId, accountId)
  const result = await pollWork(environmentId, undefined, accountId)
  return result ? c.json(result, 200) : c.body(null, 204)
})

app.post('/:id/work/:workId/ack', bridgeCredentialAuth, c => {
  const accountId = c.get('accountId') as string
  const environmentId = c.req.param('id')!
  const work = storeGetWorkItem(c.req.param('workId')!, accountId)
  const worker = c.get('jwtPayload')
  if (!work || work.environmentId !== environmentId) {
    return c.json(
      { error: { type: 'not_found', message: 'Work item not found' } },
      404,
    )
  }
  if (
    !worker ||
    worker.session_id !== work.sessionId ||
    !storeWorkCredentialMatches(
      work.id,
      accountId,
      c.get('rawAuthToken') as string,
    )
  ) {
    return c.json(
      { error: { type: 'forbidden', message: 'Work credential required' } },
      403,
    )
  }
  ackWork(work.id, accountId)
  return c.json({ status: 'ok' }, 200)
})

app.post('/:id/work/:workId/stop', bridgeCredentialAuth, c => {
  const accountId = c.get('accountId') as string
  const environmentId = c.req.param('id')!
  const work = storeGetWorkItem(c.req.param('workId')!, accountId)
  if (!work || work.environmentId !== environmentId) {
    return c.json(
      { error: { type: 'not_found', message: 'Work item not found' } },
      404,
    )
  }
  if (c.get('jwtPayload') || c.get('environmentCredential')) {
    return c.json(
      { error: { type: 'forbidden', message: 'Account token required' } },
      403,
    )
  }
  stopWork(work.id, accountId)
  return c.json({ status: 'ok' }, 200)
})

app.post('/:id/work/:workId/heartbeat', bridgeCredentialAuth, c => {
  const accountId = c.get('accountId') as string
  const environmentId = c.req.param('id')!
  const work = storeGetWorkItem(c.req.param('workId')!, accountId)
  const worker = c.get('jwtPayload')
  if (!work || work.environmentId !== environmentId) {
    return c.json(
      { error: { type: 'not_found', message: 'Work item not found' } },
      404,
    )
  }
  if (
    !worker ||
    worker.session_id !== work.sessionId ||
    !storeWorkCredentialMatches(
      work.id,
      accountId,
      c.get('rawAuthToken') as string,
    )
  ) {
    return c.json(
      { error: { type: 'forbidden', message: 'Work credential required' } },
      403,
    )
  }
  const result = heartbeatWork(work.id, accountId)
  return result
    ? c.json(result, 200)
    : c.json(
        { error: { type: 'not_found', message: 'Work item not found' } },
        404,
      )
})

export default app
