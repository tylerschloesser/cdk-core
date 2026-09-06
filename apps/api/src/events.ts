/**
 * The streaming backend: `GET /events/tick`, one SSE endpoint that emits `n`
 * ticks and a `done`. Kept separate from `app.ts` because production puts it
 * behind a `RESPONSE_STREAM` function URL and its own CloudFront behavior —
 * response streaming is fixed at function-URL creation, so a buffered and a
 * streaming route can never share a Lambda.
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

const DEFAULT_N = 5
const MIN_N = 1
const MAX_N = 50

const DEFAULT_INTERVAL_MS = 500
const MIN_INTERVAL_MS = 50
const MAX_INTERVAL_MS = 5000

// A later epoch re-measures CloudFront's SSE edge behavior (buffering,
// timeouts) against a live distribution; letting `n` and `intervalMs` vary per
// request means that measurement never needs a redeploy.
const POSITIVE_INTEGER = /^[0-9]+$/

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createEventsApp(): Hono {
  const app = new Hono()

  app.get('/events/tick', (c) => {
    c.header('Cache-Control', 'no-store')

    const nParam = c.req.query('n')
    if (nParam !== undefined && !POSITIVE_INTEGER.test(nParam)) {
      return c.json({ error: 'n must be a positive integer' }, 400)
    }
    const n = clamp(nParam === undefined ? DEFAULT_N : Number(nParam), MIN_N, MAX_N)

    const intervalParam = c.req.query('intervalMs')
    const intervalMs = clamp(
      intervalParam !== undefined && POSITIVE_INTEGER.test(intervalParam)
        ? Number(intervalParam)
        : DEFAULT_INTERVAL_MS,
      MIN_INTERVAL_MS,
      MAX_INTERVAL_MS,
    )

    return streamSSE(c, async (stream) => {
      // The keepalive timer and the tick loop both write to the same
      // connection independently; without serializing them a keepalive could
      // land mid-frame. A single promise chain both writers append to is
      // enough (the same trick yahn uses).
      let queue: Promise<unknown> = Promise.resolve()
      const enqueue = (write: () => Promise<unknown>): Promise<unknown> => {
        queue = queue.then(write)
        return queue
      }

      const keepalive = setInterval(() => {
        enqueue(() => stream.write(': keepalive\n\n'))
      }, 10_000)
      stream.onAbort(() => clearInterval(keepalive))

      try {
        for (let i = 1; i <= n; i++) {
          await enqueue(() =>
            stream.writeSSE({
              event: 'tick',
              id: String(i),
              data: JSON.stringify({ i, at: Date.now() }),
            }),
          )
          // Sleep between events, not after the last one, so event n arrives
          // at (n-1)*intervalMs rather than n*intervalMs.
          if (i < n) await sleep(intervalMs)
        }
        await enqueue(() =>
          stream.writeSSE({
            event: 'done',
            data: JSON.stringify({ n }),
          }),
        )
      } finally {
        clearInterval(keepalive)
      }
    })
  })

  return app
}
