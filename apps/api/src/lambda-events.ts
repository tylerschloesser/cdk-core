/**
 * The prod/preview Lambda entry point for the streaming backend, behind a
 * function URL created with `invokeMode: RESPONSE_STREAM` (Epoch 2). `streamHandle`
 * reaches for `awslambda`, a global the Lambda Node runtime injects only when a
 * function is actually invoked with response streaming enabled — it does not
 * exist under Node outside Lambda, so this module must only ever be loaded
 * there. `src/server.ts` reaches `createEventsApp()` directly instead of going
 * through this file.
 */

import { streamHandle } from 'hono/aws-lambda'
import { createEventsApp } from './events.js'

export const handler = streamHandle(createEventsApp())
