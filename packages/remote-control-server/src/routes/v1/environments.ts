import { Hono } from 'hono'
import { accountAuth } from '../../auth/middleware'
import {
  deregisterEnvironment,
  reconnectEnvironment,
  registerEnvironment,
} from '../../services/environment'
import { reconnectWorkForEnvironment } from '../../services/work-dispatch'

const app = new Hono()

app.post('/bridge', accountAuth, async c => {
  const body = await c.req.json()
  const accountId = c.get('accountId') as string
  try {
    return c.json(registerEnvironment({ ...body, accountId }), 200)
  } catch (error) {
    return c.json(
      {
        error: {
          type: 'invalid_request',
          message: (error as Error).message,
        },
      },
      400,
    )
  }
})

app.delete('/bridge/:id', accountAuth, c => {
  const accountId = c.get('accountId') as string
  if (!deregisterEnvironment(c.req.param('id')!, accountId)) {
    return c.json(
      { error: { type: 'not_found', message: 'Environment not found' } },
      404,
    )
  }
  return c.json({ status: 'ok' }, 200)
})

app.post('/:id/bridge/reconnect', accountAuth, async c => {
  const accountId = c.get('accountId') as string
  const environmentId = c.req.param('id')!
  if (!reconnectEnvironment(environmentId, accountId)) {
    return c.json(
      { error: { type: 'not_found', message: 'Environment not found' } },
      404,
    )
  }
  await reconnectWorkForEnvironment(environmentId, accountId)
  return c.json({ status: 'ok' }, 200)
})

export default app
