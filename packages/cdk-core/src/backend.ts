/**
 * The pure derivations shared by everything that consumes a `BackendProps`.
 *
 * This module exists so that `src/router/render.ts` — whose output is a plain
 * string and which must never pull `aws-cdk-lib`'s construct classes in — and
 * `src/behaviors.ts` — which is nothing but construct classes — can agree on
 * what a backend's read timeout is. A preview sets it per request through
 * `updateRequestOrigin.timeouts`; prod sets the same number on the origin. The
 * two must not be allowed to drift, because the symptom of a mismatch is a
 * stream that survives locally and is cut off in one environment only.
 */

import type { BackendProps } from './types.js'

/**
 * A backend's origin read timeout in seconds: explicit if given, else 60 for a
 * streaming backend and 30 for a buffered one.
 *
 * 120 s is CloudFront's ceiling without a quota increase, and it is the real
 * deadline — CloudFront waits this long for the first origin byte *and*
 * between packets, whatever the Lambda's own timeout says.
 */
export function backendReadTimeoutSeconds(key: string, backend: BackendProps): number {
  const seconds = backend.readTimeout ? backend.readTimeout.toSeconds() : backend.streaming ? 60 : 30
  if (seconds < 1 || seconds > 120) {
    throw new Error(
      `backend '${key}': readTimeout must be between 1 and 120 seconds (CloudFront's documented ` +
        `limit), got ${seconds}`,
    )
  }
  return seconds
}
