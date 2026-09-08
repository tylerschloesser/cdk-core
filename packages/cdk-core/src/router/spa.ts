/**
 * The prod site's SPA fallback, as a CloudFront Function (`cloudfront-js-2.0`).
 *
 * A preview does this inside `renderRouterSource()`, where it is one branch of
 * a function that also has to pick an origin and a `pr-<n>/` prefix. Prod has
 * one bucket at the root, so the same rule is all it needs — but it has to be
 * *the same rule*, which is why this lives next to the router rather than as
 * five inline lines in `site.ts`.
 *
 * The rule: a path whose last segment carries no extension is a client route,
 * so it serves the app shell. It must not be rewritten to `<path>/index.html`.
 * That was the router's first version, and every deep client route came back
 * **403** — not 404, because an OAC bucket policy grants `s3:GetObject` and not
 * `s3:ListBucket`, so S3 answers a missing key `AccessDenied`. A request for a
 * genuinely missing *asset* still fails, which is the point of keying on the
 * extension.
 *
 * Note that `uri.indexOf('.') === -1` — the form both prior-art sites use — is
 * not the same rule: it sends `/v1.2/settings` to the shell but also sends
 * `/assets/app.js` there whenever the path above it contains a dot.
 *
 * With `backends`, prod's one function is associated on the default behavior
 * *and* on every backend behavior (the function itself cannot change which
 * behavior was selected — `.claude/rules/cdk.md` rule 5), so it must not
 * rewrite `/api/v1/x` to `/index.html`: a guard runs before the SPA rewrite
 * for each backend's derived prefix. With `gate`, the same Google sign-in
 * gate the preview router uses (`./gate.js`) runs first and can short-circuit
 * the request.
 */

import { deriveBackendRoutes, stripSourceComments } from './render.js'
import type { BackendProps } from '../types.js'
import { renderGateSource } from './gate.js'
import type { GateSourceProps } from './gate.js'

export interface SpaSourceProps {
  /** Same keys and shape as `Site`'s `backends`. When set, those paths are not rewritten. */
  readonly backends?: Record<string, BackendProps>
  /** When set, splices the Google sign-in gate in front of the SPA rewrite. */
  readonly gate?: GateSourceProps
}

/**
 * Renders the source of the prod SPA-fallback function.
 *
 * With no `props` (or an empty one), the output is byte-identical to the
 * original no-argument form — the no-auth, no-backend consumer path is
 * untouched.
 */
export function renderSpaSource(props?: SpaSourceProps): string {
  const backendGuards = props?.backends
    ? deriveBackendRoutes(props.backends)
        .map((route) => {
          const cond = route.matchExact
            ? `uri === ${JSON.stringify(route.prefix)}`
            : `uri.indexOf(${JSON.stringify(route.prefix)}) === 0`
          return `  if (${cond}) return request`
        })
        .join('\n')
    : ''

  if (!props?.gate) {
    const guardBlock = backendGuards ? `${backendGuards}\n` : ''
    return `function handler(event) {
  var request = event.request
  var uri = request.uri
${guardBlock}  if (uri.lastIndexOf('.') <= uri.lastIndexOf('/')) request.uri = '/index.html'
  return request
}
`
  }

  const gateFragment = renderGateSource(props.gate)
  const guardBlock = backendGuards ? `${backendGuards}\n` : ''
  return stripSourceComments(`import cf from 'cloudfront'
import crypto from 'crypto'

var kvs = cf.kvs()
${gateFragment}
async function handler(event) {
  var request = event.request
  var gated = await gate(request, '')
  if (gated) return gated
  var uri = request.uri
${guardBlock}  if (uri.lastIndexOf('.') <= uri.lastIndexOf('/')) request.uri = '/index.html'
  return request
}
`)
}
