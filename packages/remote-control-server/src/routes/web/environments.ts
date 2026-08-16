import { Hono } from 'hono'
import { browserAuth } from '../../auth/middleware'
import { listActiveEnvironmentsResponse } from '../../services/environment'

const app = new Hono()

app.get('/environments', browserAuth, c =>
  c.json(listActiveEnvironmentsResponse(c.get('accountId') as string), 200),
)

export default app
