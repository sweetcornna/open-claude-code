import { Hono } from 'hono'
import { accountAuth } from '../../auth/middleware'
import { generateWorkerJwt } from '../../auth/jwt'
import { config, getBaseUrl } from '../../config'
import {
  createCodeSession,
  createSessionPairing,
  getSession,
  incrementEpoch,
} from '../../services/session'

const app = new Hono()

app.post('/', accountAuth, async c => {
  const body = await c.req.json()
  const accountId = c.get('accountId') as string
  try {
    const session = createCodeSession(body, accountId)
    return c.json(
      {
        session: c.get('legacyAuth')
          ? session
          : {
              ...session,
              ...createSessionPairing(session.id, accountId),
            },
      },
      200,
    )
  } catch {
    return c.json(
      {
        error: { type: 'invalid_request', message: 'Unable to create session' },
      },
      400,
    )
  }
})

app.post('/:id/bridge', accountAuth, c => {
  const accountId = c.get('accountId') as string
  const sessionId = c.req.param('id')!
  if (!getSession(sessionId, accountId)) {
    return c.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      404,
    )
  }
  const epoch = incrementEpoch(sessionId, accountId)
  const expiresInSeconds = config.jwtExpiresIn
  return c.json(
    {
      api_base_url: getBaseUrl(),
      worker_epoch: epoch,
      worker_jwt: generateWorkerJwt(accountId, sessionId, expiresInSeconds),
      expires_in: expiresInSeconds,
    },
    200,
  )
})

export default app
