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
 */

/** Renders the source of the prod SPA-fallback function. Takes no arguments: the rule has no configuration. */
export function renderSpaSource(): string {
  return `function handler(event) {
  var request = event.request
  var uri = request.uri
  if (uri.lastIndexOf('.') <= uri.lastIndexOf('/')) request.uri = '/index.html'
  return request
}
`
}
