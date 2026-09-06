/**
 * The prod/preview Lambda entry point for the buffered backend. Unused until
 * Epoch 2 wires a `NodejsFunction` (or equivalent bundling) to it — nothing in
 * this repo invokes `handler` yet.
 */

import { handle } from 'hono/aws-lambda'
import { createApiApp } from './app.js'

export const handler = handle(createApiApp())
