import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { accountAuth, sessionIngressAuth } from '../../auth/middleware'
import {
  automationStatesEqual,
  getAutomationStateEventPayload,
} from '../../services/automationState'
import {
  getSession,
  incrementEpoch,
  touchSession,
  updateSessionStatus,
} from '../../services/session'
import { storeGetSessionWorker, storeUpsertSessionWorker } from '../../store'
import { getEventBus } from '../../transport/event-bus'

const app = new Hono()

app.get('/:id/worker', sessionIngressAuth, c => {
  const sessionId = c.req.param('id')!
  const accountId = c.get('accountId') as string
  const session = getSession(sessionId, accountId)
  if (!session) {
    return c.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      404,
    )
  }
  const worker = storeGetSessionWorker(sessionId, accountId)
  return c.json({
    worker: {
      worker_status: worker?.workerStatus ?? session.status,
      external_metadata: worker?.externalMetadata ?? null,
      requires_action_details: worker?.requiresActionDetails ?? null,
      last_heartbeat_at: worker?.lastHeartbeatAt?.toISOString() ?? null,
    },
  })
})

app.put('/:id/worker', sessionIngressAuth, async c => {
  const sessionId = c.req.param('id')!
  const accountId = c.get('accountId') as string
  const session = getSession(sessionId, accountId)
  if (!session) {
    return c.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      404,
    )
  }
  const body = await c.req.json()
  const previousState = getAutomationStateEventPayload(
    storeGetSessionWorker(sessionId, accountId)?.externalMetadata,
  )
  if (body.worker_status) {
    updateSessionStatus(sessionId, body.worker_status, accountId)
  } else {
    touchSession(sessionId, accountId)
  }
  const worker = storeUpsertSessionWorker(
    sessionId,
    {
      workerStatus: body.worker_status,
      externalMetadata: body.external_metadata,
      requiresActionDetails: body.requires_action_details,
    },
    accountId,
  )
  const nextState = getAutomationStateEventPayload(worker.externalMetadata)
  if (!automationStatesEqual(previousState, nextState)) {
    getEventBus(sessionId).publish({
      id: randomUUID(),
      sessionId,
      type: 'automation_state',
      payload: nextState,
      direction: 'inbound',
    })
  }
  return c.json({
    status: 'ok',
    worker: {
      worker_status: worker.workerStatus ?? session.status,
      external_metadata: worker.externalMetadata,
      requires_action_details: worker.requiresActionDetails,
      last_heartbeat_at: worker.lastHeartbeatAt?.toISOString() ?? null,
    },
  })
})

app.post('/:id/worker/heartbeat', sessionIngressAuth, c => {
  const sessionId = c.req.param('id')!
  const accountId = c.get('accountId') as string
  if (!getSession(sessionId, accountId)) {
    return c.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      404,
    )
  }
  const now = new Date()
  storeUpsertSessionWorker(sessionId, { lastHeartbeatAt: now }, accountId)
  touchSession(sessionId, accountId)
  return c.json({ status: 'ok', last_heartbeat_at: now.toISOString() })
})

app.post('/:id/worker/register', accountAuth, c => {
  const sessionId = c.req.param('id')!
  const accountId = c.get('accountId') as string
  if (!getSession(sessionId, accountId)) {
    return c.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      404,
    )
  }
  return c.json({ worker_epoch: incrementEpoch(sessionId, accountId) })
})

export default app
