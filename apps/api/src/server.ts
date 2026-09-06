/**
 * Local composition root: two plain HTTP servers, not one mounted app. In
 * production these are two separate Lambdas behind two CloudFront behaviors —
 * response streaming is fixed at function-URL creation, so `events` can never
 * share a function (or a port) with `api`. Keeping them apart here too is what
 * makes `apps/web`'s dev proxy match prod's topology.
 */

import { serve } from '@hono/node-server'
import { createApiApp } from './app.js'
import { createEventsApp } from './events.js'

// `auth/server` reads `AUTH` on every call rather than at module load, so
// setting it here — after the imports — is enough. Neither `dev` nor `start`
// sets it, and an unset `AUTH` means `none`, which would make `/api/me`
// unreachable locally. The constructs never emit `local`: it exists so a
// laptop can run the real code path without a user pool.
process.env.AUTH ??= 'local'

const apiPort = Number(process.env.PORT ?? 3001)
const eventsPort = Number(process.env.EVENTS_PORT ?? 3002)

serve({ fetch: createApiApp().fetch, port: apiPort }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`)
})

serve({ fetch: createEventsApp().fetch, port: eventsPort }, (info) => {
  console.log(`events listening on http://localhost:${info.port}`)
})
