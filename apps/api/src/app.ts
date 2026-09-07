/**
 * The buffered backend: `/api/ping`, `/api/echo`, `/api/me`. Everything here
 * returns in one response — no streaming, so this is the app that both
 * `src/server.ts` (local) and `src/lambda-api.ts` (Epoch 2) serve unmodified.
 */

import { Hono } from 'hono'
import { getUser } from '@tylerschloesser/cdk-core/auth/server'

export function createApiApp(): Hono {
  const app = new Hono()

  app.get('/api/ping', (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json({ message: 'pong!' })
  })

  app.post('/api/echo', async (c) => {
    c.header('Cache-Control', 'no-store')
    const body = await c.req.json().catch(() => null)
    const text = body && typeof body === 'object' ? (body as Record<string, unknown>).text : undefined
    if (typeof text !== 'string') {
      return c.json({ error: 'text must be a string' }, 400)
    }
    return c.json({ text, length: text.length })
  })

  app.get('/api/me', async (c) => {
    c.header('Cache-Control', 'no-store')
    const user = await getUser(c)
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    return c.json({ sub: user.sub, email: user.email })
  })

  return app
}
